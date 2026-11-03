package session

import (
	"errors"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// A guest joins the comments of every file the host pairs with comments in
// its manifest, as the browser does, and never saves them: the host does
// (docs/design/comments-cli.md). What a guest writes counts as delivered
// once the host's answer to a probe shows the host has it.

// deliveryWait is how long a guest waits for the host to have its write, and
// probeEvery how often it asks meanwhile. Tests shorten them.
var (
	deliveryWait = 10 * time.Second
	probeEvery   = time.Second
)

// ErrHostAway means a guest's comment cannot reach the host now: the room is
// kept and the guest has a comment link, or the host dropped and the room is
// not kept (yet).
var ErrHostAway = errors.New("the host is away: a comment link cannot comment until the host is back, and no room takes comments in the minutes before it is kept")

type guestComments struct {
	client *protocol.Client
	name   string
	on     func(CommentChange)
	calls  *callQueue

	mu      sync.Mutex
	docs    map[uint64]*joinedComments // by the comments doc's file id
	order   []uint64
	waiters map[*hostWait]bool
}

type joinedComments struct {
	file     string // the path the room shows the file at
	doc      *crdt.Doc
	watching bool
}

// hostWait waits for the host to have every struct of a doc up to target.
type hostWait struct {
	id      uint64
	target  crdt.StateVector
	reached chan struct{}
	once    sync.Once
}

func newGuestComments(name string, on func(CommentChange), calls *callQueue) *guestComments {
	return &guestComments{name: name, on: on, calls: calls, docs: map[uint64]*joinedComments{}, waiters: map[*hostWait]bool{}}
}

// takeManifest joins the comments docs of a list of the room's files that
// were not joined yet. It runs on the read loop.
func (g *guestComments) takeManifest(files []protocol.FileEntry) {
	paths := map[uint64]string{}
	for _, f := range files {
		paths[f.ID] = f.Path
	}
	for file, id := range protocol.MetaFiles(files) {
		g.mu.Lock()
		_, joined := g.docs[id]
		g.mu.Unlock()
		if joined {
			continue
		}
		doc := crdt.New()
		g.mu.Lock()
		g.docs[id] = &joinedComments{file: paths[file], doc: doc}
		g.order = append(g.order, id)
		g.mu.Unlock()
		_ = g.client.AddCommentsFile(id, doc, meta.CheckUpdate)
	}
}

// synced starts reporting the changes of a comments doc once it holds what
// the room had: the threads there when the guest came are not changes.
// A kept room's replay counts as its sync: the room has no host to answer.
func (g *guestComments) synced(id uint64) {
	g.mu.Lock()
	d := g.docs[id]
	start := d != nil && !d.watching && g.on != nil
	if start {
		d.watching = true
	}
	g.mu.Unlock()
	if start {
		watchComments(d.doc, d.file, g.calls, g.on)
	}
}

// docs are the joined comments docs, in the order the room listed them.
func (g *guestComments) list() []commentDoc {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []commentDoc
	for _, id := range g.order {
		d := g.docs[id]
		out = append(out, commentDoc{id: id, file: d.file, doc: d.doc})
	}
	return out
}

// answered takes an answer to a SyncStep1 of a comments doc: if it is the
// host's, the waits it reaches are over.
func (g *guestComments) answered(id uint64, fromHost bool, update []byte) {
	if !fromHost {
		return
	}
	raw, err := crdt.EncodeStateVectorFromUpdate(update)
	if err != nil {
		return
	}
	has, err := crdt.DecodeStateVectorV1(raw)
	if err != nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for w := range g.waiters {
		if w.id == id && covers(has, w.target) {
			w.once.Do(func() { close(w.reached) })
			delete(g.waiters, w)
		}
	}
}

// covers tells whether an answer to a probe of target lowered by one (has,
// the state vector of the answer) holds every struct of target: for each
// client, the answer reaches its clock.
func covers(has, target crdt.StateVector) bool {
	for client, clock := range target {
		if clock > 0 && has[client] < clock {
			return false
		}
	}
	return true
}

// waitForHost waits until the host has every struct the doc holds now, or
// deliveryWait passes, asking the room every probeEvery meanwhile.
func (g *guestComments) waitForHost(c commentDoc) bool {
	target := c.doc.StateVector()
	if len(target) == 0 {
		return true
	}
	probe := crdt.StateVector{}
	for client, clock := range target {
		if clock > 0 {
			probe[client] = clock - 1
		}
	}
	w := &hostWait{id: c.id, target: target, reached: make(chan struct{})}
	g.mu.Lock()
	g.waiters[w] = true
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.waiters, w)
		g.mu.Unlock()
	}()
	give := time.NewTimer(deliveryWait)
	defer give.Stop()
	ask := time.NewTicker(probeEvery)
	defer ask.Stop()
	_ = g.client.ProbeFile(c.id, probe)
	for {
		select {
		case <-w.reached:
			return true
		case <-ask.C:
			_ = g.client.ProbeFile(c.id, probe)
		case <-give.C:
			return false
		}
	}
}
