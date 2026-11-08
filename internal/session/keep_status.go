package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// RoomStatus is what the relay says of a room it keeps (GET /api/rooms/:id/keep,
// docs/design/rooms-away.md "Lifecycle"). Host is "here" or "away"; Ends and
// LifeEnd are Unix ms.
type RoomStatus struct {
	Keep    int64  `json:"keep"`
	Host    string `json:"host"`
	Ends    int64  `json:"ends"`
	LifeEnd int64  `json:"lifeEnd"`
}

var (
	// ErrRoomEnded: the room has ended or never opened (HTTP 410).
	ErrRoomEnded = errors.New("the room has ended")
	// ErrRelayTooOld: the relay has no status or keep change (HTTP 404).
	ErrRelayTooOld = errors.New("the relay is too old to report or change a room's keep; it needs an update")
	// ErrKeepRefused: the relay refused the new keep (HTTP 409): the room is
	// kept without the host, live, or the value is not one it takes.
	// errUnanswered: the request got no answer, so the relay may have acted on it.
	errUnanswered = errors.New("could not reach the relay")
	// ErrKeepForbidden: the relay, or Cloudflare Access in front of it, turned
	// the request away (HTTP 403); a caller may retry with an Access token.
	ErrKeepForbidden = errors.New("the relay refused the request (HTTP 403)")
	ErrKeepRefused   = errors.New("the relay refused the keep: the room is live, or the host is away, or the value is not allowed")
)

// keepClient is used when no HTTP client is given.
func keepClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// keepCall asks the relay for the status of room (keep < 0), or changes its
// keep to that many seconds, with the host's token. extra holds what the
// session sends with every request, such as a Cloudflare Access token; it
// never replaces the host's Authorization.
func keepCall(ctx context.Context, client *http.Client, extra http.Header, origin, room, token string, keep int64) (RoomStatus, error) {
	method := http.MethodGet
	if keep >= 0 {
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+"/api/rooms/"+room+"/keep", nil)
	if err != nil {
		return RoomStatus{}, errors.New("invalid keep request")
	}
	for name, values := range extra {
		if http.CanonicalHeaderKey(name) != "Authorization" {
			req.Header[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
		}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if keep >= 0 {
		req.Header.Set(protocol.KeepHeader, strconv.FormatInt(keep, 10))
	}
	resp, err := keepClient(client).Do(req)
	if err != nil {
		return RoomStatus{}, errUnanswered
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusGone:
		return RoomStatus{}, ErrRoomEnded
	case http.StatusNotFound:
		return RoomStatus{}, ErrRelayTooOld
	case http.StatusConflict:
		return RoomStatus{}, ErrKeepRefused
	case http.StatusForbidden:
		return RoomStatus{}, ErrKeepForbidden
	default:
		return RoomStatus{}, fmt.Errorf("the relay refused the request (HTTP %d)", resp.StatusCode)
	}
	var st RoomStatus
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&st); err != nil || (st.Host != "here" && st.Host != "away") {
		return RoomStatus{}, errors.New("the relay's answer is not a room status")
	}
	return st, nil
}

// KeepStatus asks the relay about the room this session hosts.
func (s *Session) KeepStatus(ctx context.Context) (RoomStatus, error) {
	return keepCall(ctx, s.opts.HTTPClient, s.opts.Header, s.server, s.roomID, s.hostToken, -1)
}

// SetKeep changes how long the relay keeps the room after the host leaves,
// while the host is here. The new keep (as the relay grants it) is what a
// later reconnect sends and what the record holds.
func (s *Session) SetKeep(ctx context.Context, keep time.Duration) (RoomStatus, error) {
	if keep <= 0 || keep%time.Second != 0 {
		return RoomStatus{}, errors.New("keep must be positive whole seconds")
	}
	// A reconnect while the request is out asks for the new keep too, as the
	// relay replaces the keep on every connection that sends one. Only a
	// definite refusal takes it back: after a network failure the relay may
	// have applied the change, and the next reconnect then agrees with it.
	previous := s.Client.Header(protocol.KeepHeader)
	s.Client.SetHeader(protocol.KeepHeader, strconv.FormatInt(int64(keep/time.Second), 10))
	st, err := keepCall(ctx, s.opts.HTTPClient, s.opts.Header, s.server, s.roomID, s.hostToken, int64(keep/time.Second))
	if err != nil {
		if previous != "" && !errors.Is(err, errUnanswered) {
			s.Client.SetHeader(protocol.KeepHeader, previous)
		}
		return st, err
	}
	s.Client.SetHeader(protocol.KeepHeader, strconv.FormatInt(st.Keep, 10))
	if a := s.away; a != nil && st.Keep > 0 {
		a.mu.Lock()
		a.granted, a.told = st.Keep, st.Keep
		a.mu.Unlock()
		a.report(a.saveRecord(false))
	}
	return st, nil
}

// KeptRoomStatus is the status of a room that is kept without its host, and
// the fragments of its links.
type KeptRoomStatus struct {
	RoomStatus
	Room string
	// Origin is the relay the record names, also on an error from it.
	Origin string
	// Edit, Comment and Read are the fragments that follow '#' in the links;
	// Comment is empty when no file of the room offers comments.
	Edit, Comment, Read string
}

// KeptStatus reads the record of room in project and asks the relay about it,
// sending header besides the host's token (the record holds no Access token:
// a caller signed in to an Access-protected relay passes its own). A relay
// that says the room has ended gives ErrRoomEnded; the record is left as it is.
func KeptStatus(ctx context.Context, project, room string, client *http.Client, header http.Header) (KeptRoomStatus, error) {
	project, err := filepath.Abs(project)
	if err != nil {
		return KeptRoomStatus{}, errors.New("invalid kept project")
	}
	directory, err := keptTextDirectory(filepath.Clean(project))
	if err != nil {
		return KeptRoomStatus{}, err
	}
	if !keptTextRoomID.MatchString(room) {
		return KeptRoomStatus{}, errors.New("invalid room")
	}
	var state keptTextState
	if err := readKeptState(filepath.Join(directory, room+".json"), &state); err != nil {
		return KeptRoomStatus{}, err
	}
	raw, err := protocol.DecodeKey(state.Fragment)
	if err != nil {
		return KeptRoomStatus{}, err
	}
	keys, err := protocol.EditKeys(raw, room)
	if err != nil {
		return KeptRoomStatus{}, err
	}
	out := KeptRoomStatus{Room: room, Origin: state.Origin, Edit: keys.Fragments[protocol.AccessEdit], Read: keys.Fragments[protocol.AccessRead]}
	for _, f := range state.Files {
		if f.Meta != nil {
			out.Comment = keys.Fragments[protocol.AccessComment]
		}
	}
	out.RoomStatus, err = keepCall(ctx, client, header, state.Origin, room, state.HostToken, -1)
	return out, err
}
