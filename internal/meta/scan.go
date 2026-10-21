package meta

import (
	"errors"
	"fmt"
	"math"

	"github.com/reearth/ygo/encoding"
)

// A metadata doc holds only maps of plain values: a Y.Map of threads, each a
// Y.Map, with Y.Maps of comments. scan reads the structs of an update in the
// V1 format without applying it, and refuses any other content, so that
// CheckUpdate can tell what applying it would do from the update alone.

// scanned is what an update's structs and deletions say, as scan reads them.
type scanned struct {
	recs []record
	// The end of the deleted ranges, by client, and their number.
	deleted map[uint64]uint64
	ranges  int
}

// record is one struct: an item, or a run of collected garbage.
type record struct {
	at     id
	length uint64
	item   bool
	// An item goes after its origin, in the same list, or, without one, at
	// the start of the list of key in its parent: an item, or a root type.
	origin, parent *id
	root, key      string
}

type id struct{ client, clock uint64 }

// The wire format's info byte and content kinds (Yjs, internal/crdt).
const (
	hasOrigin      = 0x80
	hasRightOrigin = 0x40
	hasParentSub   = 0x20
	refMask        = 0x1f

	refGC      = 0
	refDeleted = 1
	refType    = 7
	refAny     = 8
	refSkip    = 10

	typeMap = 1
)

var errContent = errors.New("not content a comments doc holds")

// scan reads update, a V1 update of a metadata doc.
func scan(update []byte) (*scanned, error) {
	d := encoding.NewDecoder(update)
	clients, err := d.ReadVarUint()
	if err != nil {
		return nil, err
	}
	s := &scanned{deleted: map[uint64]uint64{}}
	seen := map[uint64]bool{}
	for range clients {
		if err := scanClient(d, s, seen); err != nil {
			return nil, err
		}
	}
	return s, scanDeletes(d, s)
}

// scanClient reads the structs of one client. Yjs and ygo keep only the
// last run of structs an update has for a client, so one with two is
// refused: the first would wait for the gap before the second.
func scanClient(d *encoding.Decoder, s *scanned, seen map[uint64]bool) error {
	n, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	client, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	clock, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	if seen[client] {
		return errors.New("structs of one client twice")
	}
	seen[client] = true
	for range n {
		r := record{at: id{client, clock}}
		if err := scanStruct(d, &r); err != nil {
			return err
		}
		if r.length == 0 || clock > math.MaxUint32-r.length {
			return errors.New("struct out of range")
		}
		clock += r.length
		s.recs = append(s.recs, r)
	}
	return nil
}

// scanStruct reads one struct into r.
func scanStruct(d *encoding.Decoder, r *record) (err error) {
	info, err := d.ReadUint8()
	if err != nil {
		return err
	}
	switch info & refMask {
	case refGC:
		r.length, err = d.ReadVarUint()
		return err
	case refSkip:
		return errors.New("it skips structs")
	}
	if info&hasRightOrigin != 0 {
		// Map entries have none; only lists and text do.
		return errContent
	}
	r.item = true
	if info&hasOrigin != 0 {
		o, err := readID(d)
		if err != nil {
			return err
		}
		r.origin = &o
	} else if err := readParent(d, info, r); err != nil {
		return err
	}
	r.length, err = scanContent(d, info&refMask)
	return err
}

// readParent reads where an item without an origin goes. One with an origin
// goes where its origin is.
func readParent(d *encoding.Decoder, info byte, r *record) error {
	named, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	if named == 1 {
		if r.root, err = d.ReadVarString(); err != nil {
			return err
		}
	} else {
		p, err := readID(d)
		if err != nil {
			return err
		}
		r.parent = &p
	}
	if info&hasParentSub == 0 {
		return errContent
	}
	r.key, err = d.ReadVarString()
	return err
}

// scanContent reads an item's content, and returns its length.
func scanContent(d *encoding.Decoder, ref byte) (uint64, error) {
	switch ref {
	case refDeleted:
		return d.ReadVarUint()
	case refType:
		t, err := d.ReadUint8()
		if err != nil {
			return 0, err
		}
		if t != typeMap {
			return 0, errContent
		}
		return 1, nil
	case refAny:
		n, err := d.ReadVarUint()
		if err != nil {
			return 0, err
		}
		if n > uint64(d.Remaining()) {
			return 0, errors.New("more values than bytes")
		}
		for range n {
			if _, err := d.ReadAny(); err != nil {
				return 0, err
			}
		}
		return n, nil
	}
	return 0, fmt.Errorf("%w: content %d", errContent, ref)
}

func readID(d *encoding.Decoder) (id, error) {
	client, err := d.ReadVarUint()
	if err != nil {
		return id{}, err
	}
	clock, err := d.ReadVarUint()
	return id{client, clock}, err
}

// scanDeletes reads the delete set.
func scanDeletes(d *encoding.Decoder, s *scanned) error {
	clients, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	for range clients {
		client, err := d.ReadVarUint()
		if err != nil {
			return err
		}
		n, err := d.ReadVarUint()
		if err != nil {
			return err
		}
		for range n {
			clock, err := d.ReadVarUint()
			if err != nil {
				return err
			}
			length, err := d.ReadVarUint()
			if err != nil {
				return err
			}
			if clock > math.MaxUint32 || length > math.MaxUint32 {
				return errors.New("deletion out of range")
			}
			s.deleted[client] = max(s.deleted[client], clock+length)
			s.ranges++
		}
	}
	return nil
}
