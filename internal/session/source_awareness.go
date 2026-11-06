package session

import (
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/awareness"
)

// A Source's pages (the app's own, each with an awareness client ID) are
// people in the room too. Their states go to the room in frames of their own,
// each at the access of the page, and the room's states go the other way:
//
//   - Into the room, a page's state is sent through the host's connection,
//     which holds every key, at the access the page has: signed as an editor
//     for an editing page, plain as a read link sends it for a reader
//     (Client.SendStateAt). So peers show a reader as read-only, and a state
//     is never re-signed above its page's role.
//   - The host renews each state as it renews its own, and sends them again
//     when someone new shows up. A removal goes out at the access the state
//     had; peers time it out as well, should it get lost.
//   - Out of the room, OnRoomAwareness is told the states the presence rules
//     accepted, and their removals, with the access each was heard with. The
//     source's own pages, which the room may echo, and the host, whom the app
//     is not shown, are not.
var errAwarenessID = errors.New("the awareness update is of another client than the page")

type sourceAwareness struct {
	mu sync.Mutex
	// pages are the states sent for the source, by client ID.
	pages map[uint64]*pageState
	// heard is the access each room state, given to OnRoomAwareness, had,
	// for the removal that follows it.
	heard map[uint64]protocol.Access
	stop  func()
	// every is the least time between the batches newcomers cause, as the
	// Client spaces its own announcements; last is when the latest began,
	// and timer sends the one batch that waits for the next slot.
	every time.Duration
	last  time.Time
	timer *time.Timer
	// batches counts the renewals of all the pages.
	batches int
	// next is the least clock the next state sent for any page may have.
	next uint64
}

// maxPageClock is the highest clock a read state may have: peers drop one
// above it (protocol.SendStateAt).
const maxPageClock = 1 << 32

type pageState struct {
	access protocol.Access
	state  []byte
}

// send sends a page's state at a clock above every one sent for any page
// before, and not below the source's own; under mu. Peers keep the clock of
// a removed ID for good, a browser in its awareness meta, so a clock that
// only rises, shared by all pages, needs no memory of each ID to stay above
// what was sent for it. When the clock would pass maxPageClock, nothing is
// sent: the state is refused with errClockSpent, and renewals stop (the
// states time out), rather than wrap around or be dropped by peers. At one
// renewal per page every 15 s that takes thousands of years.
func (s *Session) send(id, clock uint64, state []byte, access protocol.Access) error {
	a := &s.srcAw
	clock = max(clock, a.next)
	if clock > maxPageClock {
		return errClockSpent
	}
	if err := s.Client.SendStateAt(protocol.EncodeState(id, clock, state), access); err != nil {
		return err
	}
	a.next = clock + 1
	return nil
}

var errClockSpent = errors.New("the clocks of the pages' awareness states are used up")

// FromSourceAwareness sends the state of one of the source's pages, whose
// awareness client ID is id, to the room. update holds that one entry; a
// removal is one whose state is null. reader tells that the page may only
// read: its state is sent at read access.
func (s *Session) FromSourceAwareness(id uint64, reader bool, update []byte) error {
	uid, clock, state, err := protocol.ParseState(update)
	if err != nil {
		return err
	}
	if uid != id {
		return errAwarenessID
	}
	access := protocol.AccessEdit
	if reader {
		access = protocol.AccessRead
	}
	removal := string(state) == "null"
	a := &s.srcAw
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, known := a.pages[id]; !known && removal {
		return nil
	}
	if err := s.send(id, clock, state, access); err != nil {
		return err
	}
	if removal {
		delete(a.pages, id)
		return nil
	}
	if a.pages == nil {
		a.pages = map[uint64]*pageState{}
	}
	a.pages[id] = &pageState{access: access, state: state}
	return nil
}

// renewPages sends every page's state again, at the next clock.
func (s *Session) renewPages() {
	a := &s.srcAw
	a.mu.Lock()
	defer a.mu.Unlock()
	a.batches++
	for id, p := range a.pages {
		_ = s.send(id, 0, p.state, p.access)
	}
}

// startSourceAwareness renews the pages' states, and hands the room's states
// to opts.OnRoomAwareness.
func (s *Session) startSourceAwareness() {
	if s.opts.Source == nil {
		return
	}
	s.srcAw.every = 2 * time.Second
	ticker := time.NewTicker(renewInterval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				s.renewPages()
			case <-done:
				return
			}
		}
	}()
	unsub := s.awareness.OnUpdate(s.roomAwareness)
	s.srcAw.stop = func() {
		ticker.Stop()
		close(done)
		unsub()
		s.srcAw.mu.Lock()
		if s.srcAw.timer != nil {
			s.srcAw.timer.Stop()
		}
		s.srcAw.mu.Unlock()
	}
}

// stopSourceAwareness ends what startSourceAwareness began.
func (s *Session) stopSourceAwareness() {
	if s.srcAw.stop != nil {
		s.srcAw.stop()
	}
}

// renewSoon renews the pages for newcomers: at once for the first, then at
// most one batch per a.every, so that clients that come and go cannot make
// the host queue a batch for each.
func (s *Session) renewSoon() {
	a := &s.srcAw
	a.mu.Lock()
	wait := time.Until(a.last.Add(a.every))
	switch {
	case wait <= 0:
		a.last = time.Now()
		a.mu.Unlock()
		s.renewPages()
	case a.timer == nil:
		a.timer = time.AfterFunc(wait, func() {
			a.mu.Lock()
			a.timer = nil
			a.last = time.Now()
			a.mu.Unlock()
			s.renewPages()
		})
		a.mu.Unlock()
	default:
		a.mu.Unlock()
	}
}

// roomAwareness is called on every state the room's awareness applies.
func (s *Session) roomAwareness(ev awareness.UpdateEvent) {
	self := s.awareness.ClientID()
	a := &s.srcAw
	// Heard from the room: not our own heartbeat, nor a state we only
	// expired. Someone new gets the pages' states without waiting for renewal.
	if ev.Origin == s.Client && len(ev.Added) > 0 {
		s.renewSoon()
	}
	if s.opts.OnRoomAwareness == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, id := range slices.Concat(ev.Added, ev.Updated) {
		if _, page := a.pages[id]; page || id == self || ev.Origin != s.Client {
			continue
		}
		access, _ := s.Client.AccessOf(id)
		if a.heard == nil {
			a.heard = map[uint64]protocol.Access{}
		}
		a.heard[id] = access
		s.opts.OnRoomAwareness(id, access, s.awareness.EncodeUpdate([]uint64{id}))
	}
	for _, id := range ev.Removed {
		access, ok := a.heard[id]
		if _, page := a.pages[id]; page || id == self || !ok {
			continue
		}
		delete(a.heard, id)
		s.opts.OnRoomAwareness(id, access, s.awareness.EncodeUpdate([]uint64{id}))
	}
}

// isSourcePage tells whether id is a page of the source. The pages' states
// are not in the host's awareness, but a guest may take a page's ID; such a
// state is not one of the app's people.
func (s *Session) isSourcePage(id uint64) bool {
	s.srcAw.mu.Lock()
	defer s.srcAw.mu.Unlock()
	_, ok := s.srcAw.pages[id]
	return ok
}
