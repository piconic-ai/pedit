package session

import (
	"sync"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// CommentChange is a change to the comments of one of the room's files, as
// the room shows its path (docs/design/comments-cli.md).
type CommentChange struct {
	File string
	meta.Change
}

// commentWatch reports what changes in a comments doc. Every update, from
// the room or from this session, is read as the browser lists threads and
// compared with the last reading; the threads there when it starts are not
// reported.
type commentWatch struct {
	file  string
	queue *callQueue
	on    func(CommentChange)

	mu   sync.Mutex
	last []meta.Shown
}

// watchComments reports the changes of doc to on, in order, through queue.
// The caller holds no lock the doc's updates are applied under.
func watchComments(doc *crdt.Doc, file string, queue *callQueue, on func(CommentChange)) {
	w := &commentWatch{file: file, queue: queue, on: on, last: meta.ShownThreads(doc)}
	doc.OnUpdate(func(_ []byte, _ any) { w.read(doc) })
}

// read compares the doc with the last reading. It runs where updates are
// applied, so it reads the doc as it is and hands the changes on to be
// reported elsewhere.
func (w *commentWatch) read(doc *crdt.Doc) {
	now := meta.ShownThreads(doc)
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, c := range meta.Diff(w.last, now) {
		change := CommentChange{File: w.file, Change: c}
		w.queue.call(func() { w.on(change) })
	}
	w.last = now
}

// callQueue calls functions one at a time, in the order given, on a
// goroutine of its own, so that whoever gives them holds no lock while they
// run.
type callQueue struct {
	mu      sync.Mutex
	pending []func()
	running bool
}

func (q *callQueue) call(fn func()) {
	q.mu.Lock()
	q.pending = append(q.pending, fn)
	if q.running {
		q.mu.Unlock()
		return
	}
	q.running = true
	q.mu.Unlock()
	go q.run()
}

func (q *callQueue) run() {
	for {
		q.mu.Lock()
		if len(q.pending) == 0 {
			q.running = false
			q.mu.Unlock()
			return
		}
		fn := q.pending[0]
		q.pending = q.pending[1:]
		q.mu.Unlock()
		fn()
	}
}

// wait returns once every function given before it was called has run.
func (q *callQueue) wait() {
	done := make(chan struct{})
	q.call(func() { close(done) })
	<-done
}
