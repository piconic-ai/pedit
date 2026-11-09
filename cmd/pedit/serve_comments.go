package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

// Comments from the app (docs/design/embedding.md, "Comments from the app").

var (
	errCommentNotShared = errors.New("not shared, or the host is away: comments are written only while the file is shared and the host is connected")
	errCommentNotLive   = errors.New("the share is not connected to the room now: try again when it is")
)

// hostHere is the share a comment may be written in: this process shares the
// file and its host is connected, so that someone can see the comment. The
// caller holds mu.
func (l *liveSharer) hostHere() (*liveShare, error) {
	switch {
	case l.cur == nil:
		return nil, errCommentNotShared
	case l.cur.session.Client.Status() != protocol.StatusConnected:
		return nil, errCommentNotLive
	}
	return l.cur, nil
}

// Comment starts a thread on a range of the file's text, as the host, and
// answers with its id.
func (l *liveSharer) Comment(ctx context.Context, from, to int, body string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ls, err := l.hostHere()
	if err != nil {
		return err
	}
	thread, message := newCommentID(), newCommentID()
	if _, err := ls.session.StartThread(thread, message, from, to, body); err != nil {
		return err
	}
	ls.feed.flush()
	l.st.Event("commented", answerWith(ctx, map[string]any{"thread": thread, "message": message}))
	return nil
}

// Reply adds a comment to a thread, as the host.
func (l *liveSharer) Reply(ctx context.Context, thread, body string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ls, err := l.hostHere()
	if err != nil {
		return err
	}
	message := newCommentID()
	if _, err := ls.session.Reply("", thread, message, body); err != nil {
		return err
	}
	ls.feed.flush()
	l.st.Event("replied", answerWith(ctx, map[string]any{"thread": thread, "message": message}))
	return nil
}

// Resolve resolves a thread, or reopens it, as the host.
func (l *liveSharer) Resolve(ctx context.Context, thread string, resolved bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ls, err := l.hostHere()
	if err != nil {
		return err
	}
	if _, err := ls.session.Resolve("", thread, resolved); err != nil {
		return err
	}
	ls.feed.flush()
	l.st.Event("resolved", answerWith(ctx, map[string]any{"thread": thread, "resolved": resolved}))
	return nil
}

// commentsDelay is how long changes to the comments are gathered into one
// event.
const commentsDelay = 200 * time.Millisecond

// maxCommentsEvent is what the comments event may take: the app's limit for
// an event is 64 KiB.
const maxCommentsEvent = 60 << 10

// commentsFeed sends the comments event: once when it starts, and after that
// when the threads, or where they point, changed. A change is sent
// commentsDelay after the first change since the last event, so a burst is
// one event, and never when it is the event last sent.
type commentsFeed struct {
	send func(map[string]any)

	// sendMu orders the events, and is held while one is sent; mu guards the
	// timer, and is never held where the doc is locked longer than a call.
	sendMu  sync.Mutex
	src     *session.Session
	last    []byte
	stopped bool

	mu    sync.Mutex
	timer *time.Timer
}

func newCommentsFeed(send func(map[string]any)) *commentsFeed {
	return &commentsFeed{send: send}
}

// start sends the threads as they are, and follows them from now on.
func (f *commentsFeed) start(s *session.Session) {
	f.sendMu.Lock()
	f.src = s
	f.sendMu.Unlock()
	f.flush()
}

// poke notes that the comments, or the text they point into, may have changed.
// It is called under the doc's lock, so it only sets a timer.
func (f *commentsFeed) poke() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.timer == nil {
		f.timer = time.AfterFunc(commentsDelay, f.flush)
	}
}

// flush sends the threads now, unless they are as last sent.
func (f *commentsFeed) flush() {
	f.mu.Lock()
	if f.timer != nil {
		f.timer.Stop()
		f.timer = nil
	}
	f.mu.Unlock()
	f.sendMu.Lock()
	defer f.sendMu.Unlock()
	if f.stopped || f.src == nil {
		return
	}
	ev := commentsEvent(f.src.PlacedThreads())
	now, _ := json.Marshal(ev)
	if bytes.Equal(now, f.last) {
		return
	}
	f.last = now
	f.send(ev)
}

// stop ends the feed: nothing is sent after it returns.
func (f *commentsFeed) stop() {
	f.mu.Lock()
	if f.timer != nil {
		f.timer.Stop()
		f.timer = nil
	}
	f.mu.Unlock()
	f.sendMu.Lock()
	f.stopped = true
	f.sendMu.Unlock()
}

// threadView is a thread as the comments event shows it.
type threadView struct {
	ID       string        `json:"id"`
	Quote    string        `json:"quote"`
	Resolved bool          `json:"resolved"`
	From     *int          `json:"from"`
	To       *int          `json:"to"`
	Cut      int           `json:"cut,omitempty"`
	Messages []messageView `json:"messages"`
}

type messageView struct {
	ID     string `json:"id"`
	Author string `json:"author"`
	Time   string `json:"time"`
	Body   string `json:"body"`
}

func viewOf(t session.PlacedThread) threadView {
	v := threadView{ID: t.ID, Quote: t.Quote, Resolved: t.Resolved, Messages: []messageView{}}
	if t.Placed {
		v.From, v.To = &t.From, &t.To
	}
	for _, m := range t.Messages {
		v.Messages = append(v.Messages, messageView(m))
	}
	return v
}

// commentsEvent is the payload of the comments event. It fits maxCommentsEvent:
// open threads come first, then resolved ones, each in the order of threads;
// one that does not fit is counted in "more", and one whose oldest comments
// do not fit lists the latest ones, "cut" counting those left out.
func commentsEvent(threads []session.PlacedThread) map[string]any {
	views := make([]threadView, len(threads))
	for i, t := range threads {
		views[i] = viewOf(t)
	}
	order := make([]int, len(views))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int { return boolRank(views[a].Resolved) - boolRank(views[b].Resolved) })
	room := maxCommentsEvent - 128
	shown := map[int]threadView{}
	for _, i := range order {
		if v, size, ok := fitThread(views[i], room); ok {
			shown[i], room = v, room-size
		}
	}
	out := []threadView{}
	for i := range views {
		if v, ok := shown[i]; ok {
			out = append(out, v)
		}
	}
	ev := map[string]any{"threads": out}
	if left := len(views) - len(out); left > 0 {
		ev["more"] = left
	}
	return ev
}

func boolRank(b bool) int {
	if b {
		return 1
	}
	return 0
}

// fitThread cuts v to take at most room bytes of JSON, keeping its latest
// comments, and tells its size; not ok when not even one comment fits.
func fitThread(v threadView, room int) (threadView, int, bool) {
	all := v.Messages
	v.Messages = nil
	base := jsonSize(v)
	start, size := len(all), base
	for start > 0 && size+jsonSize(all[start-1])+1 <= room {
		start--
		size += jsonSize(all[start]) + 1
	}
	// A thread whose comments were all invalid has none to show, and fits if
	// its base does; one that has comments needs at least one of them to fit.
	if base > room || (len(all) > 0 && start == len(all)) {
		return v, 0, false
	}
	v.Messages, v.Cut = all[start:], start
	return v, size + 1, true
}

func jsonSize(v any) int {
	b, _ := json.Marshal(v)
	return len(b)
}
