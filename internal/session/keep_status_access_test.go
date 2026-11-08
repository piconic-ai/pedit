package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/piconic-ai/pedit/internal/access"
)

// A relay behind Cloudflare Access lets a request through only with the
// session's Access token; the host's own token must still be the bearer.
func TestKeepRequestsCarryTheSessionsAccessToken(t *testing.T) {
	var got []http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Clone())
		if r.Header.Get(access.Header) != "user-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"keep":86400,"host":"here","ends":1,"lifeEnd":2}`))
	}))
	defer srv.Close()

	s := &Session{
		opts: Options{
			HTTPClient: srv.Client(),
			// An Authorization among the extra headers must not replace the host's.
			Header: http.Header{access.Header: {"user-token"}, "Authorization": {"Bearer other"}},
		},
		server:    srv.URL,
		roomID:    "room",
		hostToken: "host-token",
	}
	st, err := s.KeepStatus(context.Background())
	if err != nil {
		t.Fatalf("KeepStatus: %v", err)
	}
	if st.Keep != 86400 || st.Host != "here" {
		t.Fatalf("status = %+v", st)
	}
	if len(got) != 1 || got[0].Get("Authorization") != "Bearer host-token" {
		t.Fatalf("Authorization = %q, want the host's token", got[0].Get("Authorization"))
	}

	// The status of a kept room read from its record takes the header too.
	if _, err := keepCall(context.Background(), srv.Client(), http.Header{access.Header: {"user-token"}}, srv.URL, "room", "host-token", -1); err != nil {
		t.Fatalf("keepCall with the Access header: %v", err)
	}
	if _, err := keepCall(context.Background(), srv.Client(), nil, srv.URL, "room", "host-token", -1); err == nil {
		t.Fatal("keepCall without the Access header passed the gate")
	}
}
