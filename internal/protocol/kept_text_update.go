package protocol

import (
	"errors"

	"github.com/reearth/ygo/encoding"
)

// ValidateKeptTextUpdate checks V1 root metadata before ygo can create named types.
// Parent IDs and inferred parents are safe: their defining item must name a root.
func ValidateKeptTextUpdate(update []byte) error {
	r := keptUpdateReader{Decoder: encoding.NewDecoder(update)}
	clients := r.count()
	for range clients {
		structs := r.count()
		r.uint()
		r.uint() // client and starting clock
		for range structs {
			r.item()
		}
	}
	clients = r.count()
	for range clients {
		r.uint()
		ranges := r.count()
		for range ranges {
			r.uint()
			r.uint()
		}
	}
	if r.err != nil || r.HasContent() {
		return errors.New("invalid kept text document domain")
	}
	return nil
}

type keptUpdateReader struct {
	*encoding.Decoder
	err error
}

func (r *keptUpdateReader) uint() uint64 {
	if r.err != nil {
		return 0
	}
	value, err := r.ReadVarUint()
	r.err = err
	return value
}
func (r *keptUpdateReader) count() uint64 {
	n := r.uint()
	if n > uint64(r.Remaining()) {
		r.err = errors.New("invalid kept update count")
		return 0
	}
	return n
}
func (r *keptUpdateReader) byte() byte {
	if r.err != nil {
		return 0
	}
	value, err := r.ReadUint8()
	r.err = err
	return value
}
func (r *keptUpdateReader) string() string {
	if r.err != nil {
		return ""
	}
	value, err := r.ReadVarString()
	r.err = err
	return value
}
func (r *keptUpdateReader) any() {
	if r.err == nil {
		_, r.err = r.ReadAny()
	}
}
func (r *keptUpdateReader) binary() {
	if r.err == nil {
		_, r.err = r.ReadVarBytes()
	}
}
func (r *keptUpdateReader) item() {
	info := r.byte()
	ref := info & 31
	if ref == 0 || ref == 10 {
		r.uint()
		return
	}
	if info&128 != 0 {
		r.uint()
		r.uint()
	}
	if info&64 != 0 {
		r.uint()
		r.uint()
	}
	if info&192 == 0 {
		switch r.byte() {
		case 1:
			if r.string() != "content" {
				r.err = errors.New("unexpected kept document root")
			}
		case 0:
			r.uint()
			r.uint()
		default:
			r.err = errors.New("invalid kept document parent")
		}
		if info&32 != 0 {
			r.string()
		}
	}
	r.content(ref)
}
func (r *keptUpdateReader) content(ref byte) {
	switch ref {
	case 1:
		r.uint()
	case 2:
		n := r.count()
		for range n {
			r.string()
		}
	case 3:
		r.binary()
	case 4, 5:
		r.string()
	case 6:
		r.string()
		r.string()
	case 7:
		switch r.byte() {
		case 0, 1, 2, 4, 6:
		case 3, 5:
			r.string()
		default:
			r.err = errors.New("invalid kept nested type")
		}
	case 8:
		n := r.count()
		for range n {
			r.any()
		}
	case 9:
		r.binary()
		r.any()
	default:
		r.err = errors.New("invalid kept content reference")
	}
}
