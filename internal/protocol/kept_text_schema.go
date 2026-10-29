package protocol

import "unicode/utf16"

// CheckKeptTextState accepts only the plain-text subset of a complete Yjs V1 snapshot.
func CheckKeptTextState(state []byte) error { return checkKeptSchema(state, keptTextItem, false) }

// CheckKeptTextUpdate validates a possibly incremental text update.
func CheckKeptTextUpdate(update []byte) error {
	return checkKeptSchemaWithStart(update, keptTextItem, false, true)
}

// KeptTextWork counts encoded structs and potential delete boundary splits.
// The caller must include the baseline and all applied updates in its budget.
func KeptTextWork(update []byte, incremental bool) (uint64, error) {
	return measureKeptSchema(update, keptTextItem, false, incremental)
}

func keptTextItem(r *keptSchemaReader) error {
	info, err := r.d.ReadUint8()
	if err != nil || info&0x20 != 0 || (info&31 != 1 && info&31 != 4) {
		return errKeptSchema
	}
	if err := keptTextOrigins(r, info); err != nil {
		return err
	}
	if info&31 == 4 {
		s, err := r.str()
		if err != nil || s == "" {
			return errKeptSchema
		}
		return r.advanceTextClock(uint64(len(utf16.Encode([]rune(s)))))
	}
	n, err := r.uint()
	if err != nil || n == 0 {
		return errKeptSchema
	}
	return r.advanceTextClock(n)
}

func (r *keptSchemaReader) advanceTextClock(n uint64) error {
	if n > (1<<53-1)-r.clock {
		return errKeptSchema
	}
	r.clock += n
	return nil
}

func keptTextOrigins(r *keptSchemaReader, info byte) error {
	if info&0x80 != 0 {
		if err := r.id(); err != nil {
			return err
		}
	}
	if info&0x40 != 0 {
		if err := r.id(); err != nil {
			return err
		}
	}
	if info&0xc0 == 0 {
		named, err := r.uint()
		if err != nil || named != 1 {
			return errKeptSchema
		}
		root, err := r.str()
		if err != nil || root != "content" {
			return errKeptSchema
		}
	}
	return nil
}
