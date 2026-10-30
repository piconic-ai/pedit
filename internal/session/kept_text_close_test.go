package session

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// closeRelay wraps the relay of a keptLocalRoom to record what the host asks
// and when. calls holds "METHOD path-suffix" in order; failClose makes /close fail.
func closeRelay(h *keptTextHost) (calls *[]string, failClose *bool) {
	calls, failClose = new([]string), new(bool)
	relay := h.client.Transport
	h.client = &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		*calls = append(*calls, r.Method+" "+r.URL.Path[strings.LastIndex(r.URL.Path, "/keep"):])
		if strings.HasSuffix(r.URL.Path, "/close") {
			if *failClose {
				return &http.Response{StatusCode: 503, Header: http.Header{}, Body: http.NoBody}, nil
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader([]byte("{}")))}, nil
		}
		return relay.RoundTrip(r)
	})}
	return
}

func openKeptRoom(t *testing.T, h *keptTextHost) {
	t.Helper()
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.closeFiles)
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	if err := saveKeptState(h.path, h.state); err != nil {
		t.Fatal(err)
	}
}

func TestKeptCloseWritesTheFileBeforeClosingAndThenRemovesTheRecord(t *testing.T) {
	h, _ := keptLocalRoom(t, "one\ntwo\nthree\n", true)
	calls, _ := closeRelay(h)
	openKeptRoom(t, h)
	if err := h.closeRoom(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one (guest)\ntwo\nthree\n" {
		t.Fatalf("edit not taken in: %q", got)
	}
	want := []string{"GET /keep", "POST /keep/checkpoint", "POST /keep/close"}
	if strings.Join(*calls, ",") != strings.Join(want, ",") {
		t.Fatalf("order: %v", *calls)
	}
	if _, err := os.Stat(h.path); !os.IsNotExist(err) {
		t.Fatal("record kept after a successful close")
	}
}

func TestKeptCloseKeepsRoomAndRecordWhenTheWriteFails(t *testing.T) {
	h, _ := keptLocalRoom(t, "one\ntwo\nthree\n", true)
	calls, _ := closeRelay(h)
	openKeptRoom(t, h)
	// The file changed under the host since the session opened it.
	if err := os.WriteFile(h.state.Files[0].File, []byte("external\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.closeRoom(context.Background()); err == nil {
		t.Fatal("closed after a failed write")
	}
	for _, c := range *calls {
		if strings.HasSuffix(c, "/close") || strings.HasSuffix(c, "/checkpoint") {
			t.Fatalf("asked the relay: %v", *calls)
		}
	}
	if _, err := os.Stat(h.path); err != nil {
		t.Fatal("record removed although the room stayed open")
	}
}

func TestKeptCloseKeepsTheRecordWhenTheRelayRefuses(t *testing.T) {
	h, _ := keptLocalRoom(t, "one\ntwo\nthree\n", true)
	_, failClose := closeRelay(h)
	*failClose = true
	openKeptRoom(t, h)
	if err := h.closeRoom(context.Background()); err == nil {
		t.Fatal("reported a close the relay refused")
	}
	if _, err := os.Stat(h.path); err != nil {
		t.Fatal("record removed although the relay did not close")
	}
}
