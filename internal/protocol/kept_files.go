package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

var keptFilesDomain = []byte("pedit kept files snapshot v1\x00")
var keptFileUpdateDomain = []byte("pedit kept file update v1\x00")

type KeptFileSnapshot struct {
	ID     uint32
	Path   string
	Update []byte
}

func SealKeptBundle(keys *RoomKeys, files []KeptFileSnapshot) ([]byte, error) {
	if err := CheckKeptBundle(files); err != nil {
		return nil, err
	}
	var body bytes.Buffer
	binary.Write(&body, binary.BigEndian, uint16(len(files)))
	for _, file := range files {
		binary.Write(&body, binary.BigEndian, file.ID)
		binary.Write(&body, binary.BigEndian, uint16(len(file.Path)))
		body.WriteString(file.Path)
		binary.Write(&body, binary.BigEndian, uint32(len(file.Update)))
		body.Write(file.Update)
	}
	return sealKeptPayload(keys, keptFilesDomain, body.Bytes())
}

// CheckKeptBundle also bounds the complete encrypted snapshot before room creation.
func CheckKeptBundle(files []KeptFileSnapshot) error {
	if len(files) < 1 || len(files) > 64 || files[0].ID != 0 {
		return errors.New("invalid kept file inventory")
	}
	ids := map[uint32]bool{}
	paths := map[string]bool{}
	size := 2 + len(keptFilesDomain) + 64 + 28
	for _, file := range files {
		if ids[file.ID] || paths[file.Path] || CheckPath(file.Path) != nil || len(file.Update) == 0 {
			return errors.New("invalid kept file inventory")
		}
		ids[file.ID], paths[file.Path] = true, true
		size += 10 + len(file.Path) + len(file.Update)
		if size > MaxFrameBytes {
			return errors.New("kept files snapshot exceeds 1 MiB")
		}
	}
	return nil
}

func OpenKeptBundle(keys *RoomKeys, frame []byte) ([]KeptFileSnapshot, error) {
	body, err := openKeptPayload(keys, keptFilesDomain, frame)
	if err != nil {
		name, raw, legacyErr := OpenKeptTextSnapshot(keys, frame)
		if legacyErr != nil {
			return nil, legacyErr
		}
		return []KeptFileSnapshot{{ID: 0, Path: name, Update: raw}}, nil
	}
	r := bytes.NewReader(body)
	var count uint16
	if binary.Read(r, binary.BigEndian, &count) != nil || count < 1 || count > 64 {
		return nil, errors.New("invalid kept file inventory")
	}
	files := make([]KeptFileSnapshot, 0, count)
	for range count {
		var file KeptFileSnapshot
		var nameSize uint16
		var updateSize uint32
		if binary.Read(r, binary.BigEndian, &file.ID) != nil || binary.Read(r, binary.BigEndian, &nameSize) != nil || nameSize > MaxPathBytes || int(nameSize) > r.Len() {
			return nil, errors.New("invalid kept file inventory")
		}
		name := make([]byte, nameSize)
		io.ReadFull(r, name)
		file.Path = string(name)
		if binary.Read(r, binary.BigEndian, &updateSize) != nil || uint64(updateSize) > uint64(r.Len()) {
			return nil, errors.New("invalid kept file update")
		}
		file.Update = make([]byte, updateSize)
		io.ReadFull(r, file.Update)
		files = append(files, file)
	}
	if r.Len() != 0 {
		return nil, errors.New("trailing kept bundle data")
	}
	if err := CheckKeptBundle(files); err != nil {
		return nil, err
	}
	return files, nil
}

func SealKeptFileUpdate(keys *RoomKeys, id uint32, update []byte) ([]byte, error) {
	if len(update) == 0 || len(update) > MaxFrameBytes {
		return nil, errors.New("invalid kept file update")
	}
	body := make([]byte, 4+len(update))
	binary.BigEndian.PutUint32(body, id)
	copy(body[4:], update)
	return sealKeptPayload(keys, keptFileUpdateDomain, body)
}
func OpenKeptFileUpdate(keys *RoomKeys, frame []byte) (uint32, []byte, error) {
	body, err := openKeptPayload(keys, keptFileUpdateDomain, frame)
	if err != nil {
		raw, legacyErr := OpenKeptText(keys, frame)
		return 0, raw, legacyErr
	}
	if len(body) <= 4 {
		return 0, nil, errors.New("invalid kept file update")
	}
	return binary.BigEndian.Uint32(body), body[4:], nil
}
