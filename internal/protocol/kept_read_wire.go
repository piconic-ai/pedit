package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
)

const readSafeInteger = uint64(1<<53 - 1)

var readUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var readEpoch = regexp.MustCompile(`^[0-9a-f]{64}$`)

type KeptReadSnapshot struct {
	Epoch      string `json:"epoch"`
	Generation uint64 `json:"generation"`
	Cutoff     uint64 `json:"cutoff"`
	Ciphertext string `json:"ciphertext"`
	Tail       uint64 `json:"tail"`
	Session    string `json:"session"`
	Cursor     string `json:"cursor"`
}
type KeptReadEntry struct {
	Sequence   uint64 `json:"sequence"`
	Ciphertext string `json:"ciphertext"`
}
type KeptReadPage struct {
	Entries []KeptReadEntry `json:"entries"`
	Next    *string         `json:"next"`
}

func readCanonical(raw []byte, v any) error {
	if len(raw) > 2*MaxFrameBytes {
		return errors.New("read response too large")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	canonical, err := json.Marshal(v)
	if err != nil || !bytes.Equal(raw, canonical) {
		return errors.New("noncanonical read response")
	}
	return nil
}
func readCipher(v string) (int, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(v)
	if err != nil || len(b) == 0 || len(b) > MaxFrameBytes || base64.StdEncoding.EncodeToString(b) != v {
		return 0, errors.New("invalid ciphertext")
	}
	return len(b), nil
}
func ParseKeptReadSnapshot(raw []byte) (KeptReadSnapshot, error) {
	var v KeptReadSnapshot
	if err := readCanonical(raw, &v); err != nil {
		return v, err
	}
	_, err := readCipher(v.Ciphertext)
	if err != nil || !readEpoch.MatchString(v.Epoch) || v.Epoch == "0000000000000000000000000000000000000000000000000000000000000000" || v.Generation < 1 || v.Generation > readSafeInteger || v.Cutoff > readSafeInteger || v.Tail > readSafeInteger || v.Tail < v.Cutoff || !readUUID.MatchString(v.Session) || !readUUID.MatchString(v.Cursor) {
		return v, errors.New("invalid read snapshot")
	}
	return v, nil
}
func ParseKeptReadPage(raw []byte, after, tail uint64) (KeptReadPage, error) {
	var v KeptReadPage
	if err := readCanonical(raw, &v); err != nil {
		return v, err
	}
	if after > tail || tail > readSafeInteger || v.Entries == nil || len(v.Entries) > 16 || (v.Next != nil && !readUUID.MatchString(*v.Next)) {
		return v, errors.New("invalid read page")
	}
	seq, total := after, 0
	for _, entry := range v.Entries {
		n, err := readCipher(entry.Ciphertext)
		if err != nil || entry.Sequence <= seq || entry.Sequence > tail {
			return v, errors.New("invalid read entry")
		}
		total += n
		if total > MaxFrameBytes {
			return v, errors.New("read page too large")
		}
		seq = entry.Sequence
	}
	if v.Next == nil && seq < tail || v.Next != nil && (len(v.Entries) == 0 || seq >= tail) {
		return v, errors.New("incomplete read page")
	}
	return v, nil
}

// KeptReadAnchor is an earlier host-trusted read. It cannot prove the
// completeness of operations arriving while the host was offline.
type KeptReadAnchor struct {
	Epoch                    string
	Generation, Cutoff, Tail uint64
	Ciphertext               string
}

func CheckKeptReadAnchor(snapshot KeptReadSnapshot, anchor KeptReadAnchor) (string, error) {
	if snapshot.Epoch != anchor.Epoch || snapshot.Generation != anchor.Generation || snapshot.Cutoff != anchor.Cutoff || snapshot.Ciphertext != anchor.Ciphertext || snapshot.Tail < anchor.Tail {
		return "", errors.New("read anchor mismatch")
	}
	return "tail-unverified", nil
}
