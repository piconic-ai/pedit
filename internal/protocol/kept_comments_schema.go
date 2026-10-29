package protocol

import "math"

// CheckKeptCommentsState accepts the map-only Yjs V1 subset used by comments.
// The caller must also apply the update and reject pending dependencies.
func CheckKeptCommentsState(state []byte) error { return checkKeptSchema(state, keptCommentItem, true) }

// CheckKeptCommentsUpdate validates a possibly incremental comments update.
func CheckKeptCommentsUpdate(update []byte) error {
	return checkKeptSchemaWithStart(update, keptCommentItem, true, true)
}

// KeptCommentsWork counts comment structs and potential delete boundary splits.
func KeptCommentsWork(update []byte, incremental bool) (uint64, error) {
	return measureKeptSchema(update, keptCommentItem, true, incremental)
}

func keptCommentParent(r *keptSchemaReader, info byte) error {
	if info&0x80 != 0 {
		return r.id()
	}
	named, err := r.uint()
	if err != nil || named > 1 {
		return errKeptSchema
	}
	if named == 1 {
		root, err := r.str()
		if err != nil || root != "comments" {
			return errKeptSchema
		}
	} else if r.id() != nil {
		return errKeptSchema
	}
	if info&0x20 == 0 {
		return errKeptSchema
	}
	key, err := r.str()
	if err != nil || len(key) > 64 {
		return errKeptSchema
	}
	return nil
}
func keptCommentItem(r *keptSchemaReader) error {
	info, err := r.d.ReadUint8()
	if err != nil {
		return err
	}
	ref := info & 31
	if ref == 0 {
		n, err := r.uint()
		if err != nil || n == 0 {
			return errKeptSchema
		}
		return r.advance(n)
	}
	if (ref != 1 && ref != 7 && ref != 8) || info&0x40 != 0 {
		return errKeptSchema
	}
	if err = keptCommentParent(r, info); err != nil {
		return err
	}
	return keptCommentContent(r, ref)
}
func keptCommentContent(r *keptSchemaReader, ref byte) error {
	switch ref {
	case 1:
		n, err := r.uint()
		if err != nil || n == 0 {
			return errKeptSchema
		}
		return r.advance(n)
	case 7:
		n, err := r.uint()
		if err != nil || n != 1 {
			return errKeptSchema
		}
		return r.advance(1)
	case 8:
		n, err := r.count(true)
		if err != nil {
			return err
		}
		if err = r.advance(n); err != nil {
			return err
		}
		for range n {
			if err = r.any(0); err != nil {
				return err
			}
		}
	}
	return nil
}
func (r *keptSchemaReader) anyInt() error {
	before := r.d.Remaining()
	first := r.d.RemainingBytes()
	if len(first) == 0 {
		return errKeptSchema
	}
	n, err := r.d.ReadVarInt()
	if err != nil || n > 1<<53-1 || n < -(1<<53-1) || before-r.d.Remaining() > 1 && r.input[len(r.input)-r.d.Remaining()-1] == 0 || n == 0 && first[0]&0x40 != 0 {
		return errKeptSchema
	}
	return nil
}
func (r *keptSchemaReader) anyCollection(depth int, tag byte) error {
	n, err := r.count(false)
	if err != nil || n > 100000 {
		return errKeptSchema
	}
	for range n {
		if tag == 118 {
			key, e := r.str()
			if e != nil || key == "__proto__" {
				return errKeptSchema
			}
		}
		if err = r.any(depth + 1); err != nil {
			return err
		}
	}
	return nil
}
func (r *keptSchemaReader) any(depth int) error {
	if depth > 100 {
		return errKeptSchema
	}
	tag, err := r.d.ReadUint8()
	if err != nil {
		return err
	}
	switch tag {
	case 126, 121, 120:
		return nil
	case 125:
		return r.anyInt()
	case 124:
		value, e := r.d.ReadFloat32()
		if e != nil {
			return e
		}
		return validCommentFloat(float64(value))
	case 123:
		value, e := r.d.ReadFloat64()
		if e != nil {
			return e
		}
		return validCommentFloat(value)
	case 119:
		_, err = r.str()
		return err
	case 116:
		return r.bytes()
	case 117, 118:
		return r.anyCollection(depth, tag)
	default:
		return errKeptSchema
	}
}

func validCommentFloat(v float64) error {
	if math.IsNaN(v) || math.IsInf(v, 0) || (v == 0 && math.Signbit(v)) {
		return errKeptSchema
	}
	return nil
}
