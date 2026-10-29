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
	// The deleted ranges, [clock, clock+length), by client.
	deleted map[uint64][][2]uint64
}

// record is one struct: an item, or a run of collected garbage.
type record struct {
	at     id
	length uint64
	item   bool
	// values: an item of plain values, which a map's are one of; deleted:
	// one whose content is gone.
	values, deleted bool
	// bytes is what a live item takes, by the measure size uses.
	bytes int
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
	return scanUpdate(update, false)
}

func scanUpdate(update []byte, complete bool) (*scanned, error) {
	d := encoding.NewDecoder(update)
	clients, err := d.ReadVarUint()
	if err != nil {
		return nil, err
	}
	s := &scanned{deleted: map[uint64][][2]uint64{}}
	seen := map[uint64]bool{}
	for range clients {
		if err := scanClient(d, s, seen); err != nil {
			return nil, err
		}
	}
	if err := scanDeletes(d, s); err != nil {
		return nil, err
	}
	if complete && d.HasContent() {
		return nil, errors.New("trailing bytes in comments update")
	}
	return s, nil
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
	r.values = info&refMask == refAny
	r.deleted = info&refMask == refDeleted
	var content int
	r.length, content, err = scanContent(d, info&refMask)
	r.bytes = r.header() + content
	return err
}

// maxKey bounds a key in the comments: ids of threads and comments are
// at most 32 characters.
const maxKey = 64

// header is what an item's place takes, as Yjs writes it.
func (r *record) header() int {
	if r.origin != nil {
		return 1 + varLen(r.origin.client) + varLen(r.origin.clock)
	}
	n := 2 + strLen(r.key)
	if r.parent != nil {
		return n + varLen(r.parent.client) + varLen(r.parent.clock)
	}
	return n + strLen(r.root)
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
		if r.root != CommentsKey {
			return errContent
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
	if r.key, err = d.ReadVarString(); err != nil {
		return err
	}
	if len(r.key) > maxKey {
		return fmt.Errorf("%w: a key of %d bytes", errContent, len(r.key))
	}
	return nil
}

// scanContent reads an item's content, and returns its length and what it
// takes, by the measure size uses.
func scanContent(d *encoding.Decoder, ref byte) (length uint64, bytes int, err error) {
	switch ref {
	case refDeleted:
		n, err := d.ReadVarUint()
		return n, varLen(n), err
	case refType:
		t, err := d.ReadUint8()
		if err != nil {
			return 0, 0, err
		}
		if t != typeMap {
			return 0, 0, errContent
		}
		return 1, 1, nil
	case refAny:
		n, err := d.ReadVarUint()
		if err != nil {
			return 0, 0, err
		}
		if n > uint64(d.Remaining()) {
			return 0, 0, errors.New("more values than bytes")
		}
		bytes := varLen(n)
		for range n {
			v, err := d.ReadAny()
			if err != nil {
				return 0, 0, err
			}
			bytes += anyLen(v)
		}
		return n, bytes, nil
	}
	return 0, 0, fmt.Errorf("%w: content %d", errContent, ref)
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
			s.deleted[client] = append(s.deleted[client], [2]uint64{clock, length})
		}
	}
	return nil
}

// varLen is how many bytes x takes as a varuint.
func varLen(x uint64) int {
	n := 1
	for ; x >= 0x80; x >>= 7 {
		n++
	}
	return n
}
