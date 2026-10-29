package protocol

import (
	"errors"
	"github.com/reearth/ygo/encoding"
)

var errKeptSchema = errors.New("unsupported recovery state")

type keptSchemaReader struct {
	d            *encoding.Decoder
	input        []byte
	work         uint64
	clock        uint64
	structs      uint64
	deleteRanges uint64
}

func (r *keptSchemaReader) uint() (uint64, error) {
	before := r.d.Remaining()
	n, err := r.d.ReadVarUint()
	if err != nil {
		return 0, err
	}
	if n > 1<<53-1 || (before-r.d.Remaining() > 1 && r.input[len(r.input)-r.d.Remaining()-1] == 0) {
		return 0, errKeptSchema
	}
	return n, nil
}
func (r *keptSchemaReader) str() (string, error) {
	before := r.d.Remaining()
	s, err := r.d.ReadVarString()
	if err != nil {
		return "", err
	}
	consumed := before - r.d.Remaining() - len(s)
	if consumed > 1 && r.input[len(r.input)-before+consumed-1] == 0 {
		return "", errKeptSchema
	}
	return s, nil
}
func (r *keptSchemaReader) bytes() error {
	before := r.d.Remaining()
	v, err := r.d.ReadVarBytes()
	if err != nil {
		return err
	}
	consumed := before - r.d.Remaining() - len(v)
	if consumed > 1 && r.input[len(r.input)-before+consumed-1] == 0 {
		return errKeptSchema
	}
	return nil
}
func (r *keptSchemaReader) id() error {
	if _, err := r.uint(); err != nil {
		return err
	}
	_, err := r.uint()
	return err
}
func (r *keptSchemaReader) count(nonzero bool) (uint64, error) {
	n, err := r.uint()
	if err != nil || nonzero && n == 0 || n > uint64(r.d.Remaining()) {
		return 0, errKeptSchema
	}
	return n, nil
}
func (r *keptSchemaReader) client(seen map[uint64]bool, item func(*keptSchemaReader) error, allowStart bool) error {
	count, err := r.count(true)
	if err != nil {
		return err
	}
	id, err := r.uint()
	if err != nil || seen[id] {
		return errKeptSchema
	}
	seen[id] = true
	r.structs += count
	r.clock = 0
	clock, err := r.uint()
	if err != nil || (!allowStart && clock != 0) {
		return errKeptSchema
	}
	r.clock = clock
	for range count {
		if err = item(r); err != nil {
			return err
		}
	}
	return nil
}
func (r *keptSchemaReader) deletions() (uint64, error) {
	n, err := r.count(false)
	if err != nil {
		return 0, err
	}
	for range n {
		if _, err = r.uint(); err != nil {
			return 0, err
		}
		count, err := r.count(false)
		if err != nil {
			return 0, err
		}
		r.deleteRanges += count
		for range count {
			if err = r.id(); err != nil {
				return 0, err
			}
		}
	}
	return n, nil
}
func checkKeptSchema(input []byte, item func(*keptSchemaReader) error, comments bool) error {
	return checkKeptSchemaWithStart(input, item, comments, false)
}
func checkKeptSchemaWithStart(input []byte, item func(*keptSchemaReader) error, comments, allowStart bool) error {
	work, err := measureKeptSchema(input, item, comments, allowStart)
	if err != nil || (!comments && work > MaxKeptYjsWork) {
		return errKeptSchema
	}
	return nil
}

func measureKeptSchema(input []byte, item func(*keptSchemaReader) error, comments, allowStart bool) (uint64, error) {
	if len(input) == 0 || len(input) > MaxFrameBytes {
		return 0, errKeptSchema
	}
	r := &keptSchemaReader{d: encoding.NewDecoder(input), input: input}
	clients, err := r.count(false)
	if err != nil {
		return 0, errKeptSchema
	}
	seen := map[uint64]bool{}
	for range clients {
		if r.client(seen, item, allowStart) != nil {
			return 0, errKeptSchema
		}
	}
	deletes, err := r.deletions()
	if err != nil || r.d.Remaining() != 0 {
		return 0, errKeptSchema
	}
	if comments && uint64(len(input))+112*r.work+32*(clients+deletes)+2 > MaxFrameBytes-(4<<10) {
		return 0, errKeptSchema
	}
	return r.structs + 2*r.deleteRanges, nil
}

func (r *keptSchemaReader) advance(n uint64) error {
	if n > 1024 || r.work > 1024-n {
		return errKeptSchema
	}
	r.work += n
	return nil
}
