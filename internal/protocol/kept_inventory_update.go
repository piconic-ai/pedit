package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

const inventoryUpdateDomain = "pedit/v6/inventory-text-update\x00"
const MaxKeptInventoryPaths = 1024

var errInventoryUpdate = errors.New("invalid inventory text update")

type KeptInventoryUpdate struct {
	Update    []byte
	Additions []string
}

func validInventoryPaths(paths []string) bool {
	if len(paths) > MaxKeptInventoryPaths {
		return false
	}
	for i, p := range paths {
		if !utf8.ValidString(p) || !keptAssetPath.MatchString(p) || (i > 0 && paths[i-1] >= p) {
			return false
		}
	}
	return true
}
func EncodeKeptInventoryUpdate(v KeptInventoryUpdate) ([]byte, error) {
	if CheckKeptTextUpdate(v.Update) != nil || !validInventoryPaths(v.Additions) {
		return nil, errInventoryUpdate
	}
	size := len(inventoryUpdateDomain) + 1 + 8 + len(v.Update)
	for _, p := range v.Additions {
		size += 4 + len(p)
	}
	if size > maxRecordPayload {
		return nil, errInventoryUpdate
	}
	var b bytes.Buffer
	b.Grow(size)
	b.WriteString(inventoryUpdateDomain)
	b.WriteByte(0)
	put := func(n int) { var raw [4]byte; binary.BigEndian.PutUint32(raw[:], uint32(n)); b.Write(raw[:]) }
	put(len(v.Update))
	b.Write(v.Update)
	put(len(v.Additions))
	for _, p := range v.Additions {
		put(len(p))
		b.WriteString(p)
	}
	return b.Bytes(), nil
}
func DecodeKeptInventoryUpdate(raw []byte) (KeptInventoryUpdate, error) {
	var v KeptInventoryUpdate
	if len(raw) > maxRecordPayload || len(raw) < len(inventoryUpdateDomain)+9 || !bytes.HasPrefix(raw, []byte(inventoryUpdateDomain)) || raw[len(inventoryUpdateDomain)] != 0 {
		return v, errInventoryUpdate
	}
	at := len(inventoryUpdateDomain) + 1
	get := func() (int, error) {
		if len(raw)-at < 4 {
			return 0, errInventoryUpdate
		}
		n := binary.BigEndian.Uint32(raw[at:])
		at += 4
		if uint64(n) > uint64(len(raw)) {
			return 0, errInventoryUpdate
		}
		return int(n), nil
	}
	take := func(n int) ([]byte, error) {
		if n > len(raw)-at {
			return nil, errInventoryUpdate
		}
		b := bytes.Clone(raw[at : at+n])
		at += n
		return b, nil
	}
	n, err := get()
	if err != nil {
		return v, err
	}
	v.Update, err = take(n)
	if err != nil {
		return KeptInventoryUpdate{}, err
	}
	count, err := get()
	if err != nil || count > MaxKeptInventoryPaths {
		return KeptInventoryUpdate{}, errInventoryUpdate
	}
	v.Additions = make([]string, 0, count)
	for range count {
		n, err = get()
		if err != nil {
			return KeptInventoryUpdate{}, err
		}
		b, e := take(n)
		if e != nil {
			return KeptInventoryUpdate{}, e
		}
		v.Additions = append(v.Additions, string(b))
	}
	if at != len(raw) || CheckKeptTextUpdate(v.Update) != nil || !validInventoryPaths(v.Additions) {
		return KeptInventoryUpdate{}, errInventoryUpdate
	}
	return v, nil
}
