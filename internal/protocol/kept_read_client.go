package protocol

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const keptReadSessionBudget = 4 * time.Minute

var keptHostToken = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var keptRoomID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// MaxKeptCheckpointReceipts bounds the authenticated baseline ledger.
const MaxKeptCheckpointReceipts = 10000

const maxKeptReadRecords = 1024
const maxKeptReadBytes = 16 * MaxFrameBytes

// KeptReadInspection is authenticated but is not a recovered document. The
// relay can omit previously unseen operations. Callers must not ACK or cut
// the log based only on this inspection.
type KeptReadInspection struct {
	Snapshot     KeptReadSnapshot
	Records      []KeptRecord
	Checkpoint   KeptTextPayload
	Frames       [][]byte
	Completeness string
}

// ReadKeptHost fetches one fixed session from the internal Room endpoint. An
// optional anchor is a previously trusted host observation. It cannot prove
// what arrived while the host was away. The minimum generation is a
// previously saved lower bound, even when no full anchor is available.
// No document or ledger is persisted.
func ReadKeptHost(ctx context.Context, client *http.Client, endpoint, roomID, hostToken string, keys *KeptRoomKeys, minimumGeneration uint64, anchor *KeptReadAnchor) (KeptReadInspection, error) {
	var result KeptReadInspection
	if client == nil || keys == nil || !keptHostToken.MatchString(hostToken) {
		return result, errors.New("invalid read configuration")
	}
	base, err := url.Parse(endpoint)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return result, errors.New("invalid read endpoint")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/internal/kept/" + roomID + "/read"
	base.RawPath = ""
	if !keptRoomID.MatchString(roomID) {
		return result, errors.New("invalid room id")
	}
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	readCtx, cancelRead := context.WithTimeout(ctx, keptReadSessionBudget)
	defer cancelRead()
	raw, err := fetchKeptRead(&safeClient, base, hostToken, readCtx, http.MethodPost, "", "", false)
	if err != nil {
		return result, err
	}
	session := readSessionID(raw)
	finished := false
	if session != "" {
		defer func() {
			if finished {
				return
			}
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(cleanupCtx, http.MethodDelete, base.String(), nil)
			if err != nil {
				return
			}
			req.Header.Set("Authorization", "Host "+hostToken)
			req.Header.Set("X-Pedit-Read-Session", session)
			resp, err := safeClient.Do(req)
			if err == nil {
				resp.Body.Close()
			}
		}()
	}
	snapshot, err := ParseKeptReadSnapshot(raw)
	if err != nil {
		return result, err
	}
	if snapshot.Generation < minimumGeneration {
		return result, errors.New("checkpoint generation predates saved credentials")
	}
	if anchor != nil {
		if _, err = CheckKeptReadAnchor(snapshot, *anchor); err != nil {
			return result, err
		}
	}
	epochBytes, err := hex.DecodeString(snapshot.Epoch)
	if err != nil {
		return result, errors.New("invalid read epoch")
	}
	var epoch [32]byte
	copy(epoch[:], epochBytes)
	cipher, err := base64.StdEncoding.Strict().DecodeString(snapshot.Ciphertext)
	if err != nil {
		return result, err
	}
	payloadBytes, err := OpenKeptCheckpoint(keys, KeptCheckpointContext{RoomID: roomID, Epoch: epoch, Generation: snapshot.Generation, Cutoff: snapshot.Cutoff}, cipher)
	if err != nil {
		return result, err
	}
	payload, err := DecodeKeptTextPayload(payloadBytes, MaxKeptCheckpointReceipts)
	if err != nil {
		return result, errors.New("unsupported checkpoint payload")
	}
	records, frames, cursor, err := readKeptPages(readCtx, &safeClient, base, hostToken, roomID, keys, snapshot, payload, epoch)
	if err != nil {
		return KeptReadInspection{}, err
	}

	finishCtx, cancelFinish := context.WithTimeout(readCtx, time.Second)
	_, err = fetchKeptRead(&safeClient, base, hostToken, finishCtx, http.MethodDelete, snapshot.Session, cursor, true)
	cancelFinish()
	if err != nil {
		return KeptReadInspection{}, err
	}
	finished = true
	return KeptReadInspection{Snapshot: snapshot, Records: records, Checkpoint: payload, Frames: frames, Completeness: "tail-unverified"}, nil
}

func readKeptPages(ctx context.Context, safeClient *http.Client, base *url.URL, hostToken, roomID string, keys *KeptRoomKeys, snapshot KeptReadSnapshot, payload KeptTextPayload, epoch [32]byte) ([]KeptRecord, [][]byte, string, error) {
	// The provisional ledger tracks sequence ordering only. It must never be
	// persisted or reported as having applied these operations.
	ledger := payload.Ledger
	ledger.limit = MaxKeptCheckpointReceipts + maxKeptReadRecords
	cursor, after, total := snapshot.Cursor, snapshot.Cutoff, 0
	rateRetries := 0
	records := []KeptRecord{}
	frames := [][]byte{}
	for {
		raw, err := fetchKeptPage(safeClient, base, hostToken, ctx, snapshot.Session, cursor, &rateRetries)
		if err != nil {
			return nil, nil, "", err
		}
		page, e := ParseKeptReadPage(raw, after, snapshot.Tail)
		if e != nil {
			return nil, nil, "", e
		}
		for _, entry := range page.Entries {
			sealed, record, nextLedger, e := readKeptEntry(entry, keys, roomID, epoch, snapshot.Generation, ledger, len(records), total)
			if e != nil {
				return nil, nil, "", e
			}
			total += len(sealed)
			ledger = nextLedger
			records = append(records, record)
			frames = append(frames, sealed)
			after = entry.Sequence
		}
		if page.Next == nil {
			break
		}
		if *page.Next == cursor {
			return nil, nil, "", errors.New("repeated read cursor")
		}
		cursor = *page.Next
	}
	return records, frames, cursor, nil
}

func readKeptEntry(entry KeptReadEntry, keys *KeptRoomKeys, roomID string, epoch [32]byte, generation uint64, ledger KeptLedger, count, total int) ([]byte, KeptRecord, KeptLedger, error) {
	var empty KeptRecord
	sealed, err := base64.StdEncoding.Strict().DecodeString(entry.Ciphertext)
	if err != nil {
		return nil, empty, ledger, err
	}
	if count >= maxKeptReadRecords || total+len(sealed) > maxKeptReadBytes {
		return nil, empty, ledger, errors.New("read capacity exceeded")
	}
	record, err := OpenKeptRecord(keys, KeptRecordContext{RoomID: roomID, Epoch: epoch, Generation: generation}, sealed)
	if err != nil {
		return nil, empty, ledger, err
	}
	plan, err := ledger.Inspect(record)
	if err != nil {
		return nil, empty, ledger, err
	}
	switch plan.Decision {
	case KeptNext:
		ledger, err = ledger.Commit(plan, KeptApplied)
		if err != nil {
			return nil, empty, ledger, err
		}
	case KeptDuplicate:
	default:
		return nil, empty, ledger, errors.New("invalid ledger sequence")
	}
	return sealed, record, ledger, nil
}

type keptRateLimit struct{ delay time.Duration }

func (e keptRateLimit) Error() string { return "read rate limited" }

func fetchKeptPage(client *http.Client, base *url.URL, hostToken string, ctx context.Context, session, cursor string, retries *int) ([]byte, error) {
	for {
		data, err := fetchKeptRead(client, base, hostToken, ctx, http.MethodGet, session, cursor, true)
		var limited keptRateLimit
		if !errors.As(err, &limited) || *retries >= 2 || limited.delay <= 0 {
			return data, err
		}
		*retries++
		timer := time.NewTimer(limited.delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func fetchKeptRead(safeClient *http.Client, base *url.URL, hostToken string, requestCtx context.Context, method, session, cursor string, retry bool) ([]byte, error) {
	attempts := 1
	if retry {
		attempts = 2
	}
	for i := 0; i < attempts; i++ {
		data, retryable, err := fetchKeptReadOnce(safeClient, base, hostToken, requestCtx, method, session, cursor)
		if !retryable || i+1 == attempts {
			return data, err
		}
	}
	return nil, errors.New("read request failed")
}

func fetchKeptReadOnce(client *http.Client, base *url.URL, hostToken string, ctx context.Context, method, session, cursor string) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, method, base.String(), nil)
	if err != nil {
		return nil, false, errors.New("invalid read request")
	}
	req.Header.Set("Authorization", "Host "+hostToken)
	if session != "" {
		req.Header.Set("X-Pedit-Read-Session", session)
		if cursor != "" {
			req.Header.Set("X-Pedit-Read-Cursor", cursor)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, true, errors.New("read request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests && method == http.MethodGet {
		return nil, false, keptRetryDelay(resp.Header.Get("Retry-After"))
	}
	if resp.StatusCode != http.StatusOK && !(method == http.MethodDelete && resp.StatusCode == http.StatusNoContent) {
		return nil, false, errors.New("read request refused")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2*MaxFrameBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, true, errors.New("read response interrupted")
	}
	if len(data) > 2*MaxFrameBytes {
		return nil, false, errors.New("read response too large")
	}
	return data, false, nil
}

func keptRetryDelay(value string) keptRateLimit {
	if value == "" {
		return keptRateLimit{delay: time.Minute}
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 1 || seconds > 60 {
		return keptRateLimit{}
	}
	return keptRateLimit{delay: time.Duration(seconds) * time.Second}
}

// readSessionID extracts only an unambiguous session from a syntactically
// valid response so that an otherwise invalid snapshot can be cancelled.
func readSessionID(raw []byte) string {
	d := json.NewDecoder(bytes.NewReader(raw))
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return ""
	}
	var session string
	seen := false
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return ""
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return ""
		}
		if key == "session" {
			if seen {
				return ""
			}
			seen = true
			if json.Unmarshal(value, &session) != nil {
				return ""
			}
		}
	}
	end, err := d.Token()
	if err != nil || end != json.Delim('}') {
		return ""
	}
	if _, err = d.Token(); err != io.EOF {
		return ""
	}
	if !readUUID.MatchString(session) {
		return ""
	}
	return session
}
