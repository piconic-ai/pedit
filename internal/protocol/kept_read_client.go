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
	"strings"
	"time"
)

var keptHostToken = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var keptRoomID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

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
// what arrived while the host was away. No document or ledger is persisted.
func ReadKeptHost(ctx context.Context, client *http.Client, endpoint, roomID, hostToken string, keys *KeptRoomKeys, anchor *KeptReadAnchor) (KeptReadInspection, error) {
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
	fetch := func(requestCtx context.Context, method, session, cursor string, retry bool) ([]byte, error) {
		attempts := 1
		if retry {
			attempts = 2
		}
		for i := 0; i < attempts; i++ {
			req, e := http.NewRequestWithContext(requestCtx, method, base.String(), nil)
			if e != nil {
				return nil, errors.New("invalid read request")
			}
			req.Header.Set("Authorization", "Host "+hostToken)
			if session != "" {
				req.Header.Set("X-Pedit-Read-Session", session)
				if cursor != "" {
					req.Header.Set("X-Pedit-Read-Cursor", cursor)
				}
			}
			resp, e := safeClient.Do(req)
			if e != nil {
				if requestCtx.Err() != nil {
					return nil, requestCtx.Err()
				}
				if i+1 < attempts {
					continue
				}
				return nil, errors.New("read request failed")
			}
			if resp.StatusCode != http.StatusOK && !(method == http.MethodDelete && resp.StatusCode == http.StatusNoContent) {
				resp.Body.Close()
				return nil, errors.New("read request refused")
			}
			data, e := io.ReadAll(io.LimitReader(resp.Body, 2*MaxFrameBytes+1))
			resp.Body.Close()
			if e != nil {
				if requestCtx.Err() != nil {
					return nil, requestCtx.Err()
				}
				if i+1 < attempts {
					continue
				}
				return nil, errors.New("read response interrupted")
			}
			if len(data) > 2*MaxFrameBytes {
				return nil, errors.New("read response too large")
			}
			return data, nil
		}
		return nil, errors.New("read request failed")
	}
	raw, err := fetch(ctx, http.MethodPost, "", "", false)
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
	payload, err := DecodeKeptTextPayload(payloadBytes, maxKeptReadRecords)
	if err != nil {
		return result, errors.New("unsupported checkpoint payload")
	}
	// The provisional ledger tracks sequence ordering only. It must never be
	// persisted or reported as having applied these operations.
	ledger := payload.Ledger
	cursor, after, total := snapshot.Cursor, snapshot.Cutoff, 0
	records := []KeptRecord{}
	frames := [][]byte{}
	for {
		raw, err = fetch(ctx, http.MethodGet, snapshot.Session, cursor, true)
		if err != nil {
			return KeptReadInspection{}, err
		}
		page, e := ParseKeptReadPage(raw, after, snapshot.Tail)
		if e != nil {
			return KeptReadInspection{}, e
		}
		for _, entry := range page.Entries {
			sealed, e := base64.StdEncoding.Strict().DecodeString(entry.Ciphertext)
			if e != nil {
				return KeptReadInspection{}, e
			}
			total += len(sealed)
			if len(records) >= maxKeptReadRecords || total > maxKeptReadBytes {
				return KeptReadInspection{}, errors.New("read capacity exceeded")
			}
			record, e := OpenKeptRecord(keys, KeptRecordContext{RoomID: roomID, Epoch: epoch, Generation: snapshot.Generation}, sealed)
			if e != nil {
				return KeptReadInspection{}, e
			}
			plan, e := ledger.Inspect(record)
			if e != nil {
				return KeptReadInspection{}, e
			}
			switch plan.Decision {
			case KeptNext:
				ledger, e = ledger.Commit(plan, KeptApplied)
				if e != nil {
					return KeptReadInspection{}, e
				}
			case KeptDuplicate:
			default:
				return KeptReadInspection{}, errors.New("invalid ledger sequence")
			}
			records = append(records, record)
			frames = append(frames, sealed)
			after = entry.Sequence
		}
		if page.Next == nil {
			break
		}
		if *page.Next == cursor {
			return KeptReadInspection{}, errors.New("repeated read cursor")
		}
		cursor = *page.Next
	}
	finishCtx, cancelFinish := context.WithTimeout(ctx, time.Second)
	_, err = fetch(finishCtx, http.MethodDelete, snapshot.Session, cursor, true)
	cancelFinish()
	if err != nil {
		return KeptReadInspection{}, err
	}
	finished = true
	return KeptReadInspection{Snapshot: snapshot, Records: records, Checkpoint: payload, Frames: frames, Completeness: "tail-unverified"}, nil
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
