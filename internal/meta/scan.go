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

// What an update's structs and deletions name, as scan reads them.
type scanned struct {
	// The clocks of each client's structs, from start to end.
	start, end map[uint64]uint64
	// The items each one depends on: origins and parents.
	deps []id
	// How many items share a place: a parent, a key and an origin. Yjs
	// compares each item with the others in its place when it integrates
	// it, so a place with many costs time in the square of their number.
	places map[place]int
	// The end of the deleted ranges, by client, and their number.
	deleted map[uint64]uint64
	ranges  int
	// known is the state of the doc the update is for: places count only
	// the items it does not have yet. Nil for the doc itself.
	known map[uint64]uint64
}

type id struct{ client, clock uint64 }

// place is where an item goes: its parent (an item, or a root type by
// name), its key in it, and the item it was inserted after (none: zero).
type place struct {
	parent    id
	root, key string
	origin    id
	hasOrigin bool
}

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

// scan reads update, a V1 update of a metadata doc, adding to into, which
// may hold another update's scan.
func scan(update []byte, into *scanned) (err error) {
	d := encoding.NewDecoder(update)
	clients, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	for range clients {
		if err := scanClient(d, into); err != nil {
			return err
		}
	}
	return scanDeletes(d, into)
}

func newScanned(known map[uint64]uint64) *scanned {
	return &scanned{
		known:   known,
		start:   map[uint64]uint64{},
		end:     map[uint64]uint64{},
		places:  map[place]int{},
		deleted: map[uint64]uint64{},
	}
}

// scanClient reads the structs of one client.
func scanClient(d *encoding.Decoder, into *scanned) error {
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
	if _, ok := into.start[client]; !ok || clock < into.start[client] {
		into.start[client] = clock
	}
	for range n {
		length, err := scanStruct(d, id{client, clock}, into)
		if err != nil {
			return err
		}
		if length == 0 || clock > math.MaxUint32-length {
			return errors.New("struct out of range")
		}
		clock += length
	}
	into.end[client] = max(into.end[client], clock)
	return nil
}

// scanStruct reads one struct at at, and returns its length.
func scanStruct(d *encoding.Decoder, at id, into *scanned) (uint64, error) {
	info, err := d.ReadUint8()
	if err != nil {
		return 0, err
	}
	switch info & refMask {
	case refGC:
		return d.ReadVarUint()
	case refSkip:
		return 0, errors.New("it skips structs")
	}
	if info&hasRightOrigin != 0 {
		// Map entries have none; only lists and text do.
		return 0, errContent
	}
	p := place{}
	if info&hasOrigin != 0 {
		o, err := readID(d)
		if err != nil {
			return 0, err
		}
		p.origin, p.hasOrigin = o, true
		into.deps = append(into.deps, o)
	} else {
		if err := readParent(d, info, &p, into); err != nil {
			return 0, err
		}
	}
	if at.clock >= into.known[at.client] {
		into.places[p]++
	}
	return scanContent(d, info&refMask)
}

// readParent reads where an item without an origin goes. One with an origin
// goes where its origin is.
func readParent(d *encoding.Decoder, info byte, p *place, into *scanned) error {
	named, err := d.ReadVarUint()
	if err != nil {
		return err
	}
	if named == 1 {
		if p.root, err = d.ReadVarString(); err != nil {
			return err
		}
	} else {
		if p.parent, err = readID(d); err != nil {
			return err
		}
		into.deps = append(into.deps, p.parent)
	}
	if info&hasParentSub == 0 {
		return errContent
	}
	p.key, err = d.ReadVarString()
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
func scanDeletes(d *encoding.Decoder, into *scanned) error {
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
			into.deleted[client] = max(into.deleted[client], clock+length)
			into.ranges++
		}
	}
	return nil
}
