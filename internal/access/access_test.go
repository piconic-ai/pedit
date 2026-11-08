package access

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

var now = time.Unix(1_800_000_000, 0)

func jwt(email string, exp time.Time) string {
	payload := fmt.Sprintf(`{"email":%q,"exp":%d}`, email, exp.Unix())
	return "eyJhbGciOiJSUzI1NiJ9." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

// fakeCloudflared keeps a token like cloudflared does and records its calls.
type fakeCloudflared struct {
	token    string // what `access token` prints; "" means not signed in
	login    string // what `access login` stores
	loginErr error
	now      time.Time
	calls    []string
}

func (f *fakeCloudflared) run(_ context.Context, stdout, stderr io.Writer, args ...string) error {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch args[1] {
	case "token":
		if f.token == "" {
			fmt.Fprintln(stderr, "Unable to find token for provided application.")
			return errors.New("exit status 1")
		}
		fmt.Fprintln(stdout, f.token)
	case "login":
		// Like cloudflared, in pieces.
		fmt.Fprint(stderr, "A browser window should have opened at the following URL:\n\nhttps://pedit.example.com/cdn-cgi/")
		fmt.Fprint(stderr, "access/cli?token=abc\n\nIf the browser failed to open, please visit the URL above directly in your browser.\n")
		if f.loginErr != nil {
			return f.loginErr
		}
		// Like cloudflared, keep a cached token until it has expired.
		if c, ok := parse(f.token); !ok || c.Exp <= f.now.Unix() {
			f.token = f.login
		}
	}
	return nil
}

func TestTokenUsesSignedInToken(t *testing.T) {
	token := jwt("k@example.com", now.Add(time.Hour))
	f := &fakeCloudflared{token: token}
	got, err := (&Cloudflared{Run: f.run, Now: func() time.Time { return now }}).Token(context.Background(), "https://pedit.example.com")
	if err != nil || got != token {
		t.Fatalf("Token = %q, %v", got, err)
	}
	if want := []string{"access token -app=https://pedit.example.com"}; fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls = %q", f.calls)
	}
}

func TestTokenSignsInWhenNeeded(t *testing.T) {
	fresh := jwt("k@example.com", now.Add(24*time.Hour))
	for name, f := range map[string]*fakeCloudflared{
		"not signed in": {login: fresh, now: now},
		"expired":       {token: jwt("k@example.com", now.Add(-time.Hour)), login: fresh, now: now},
		"not a JWT":     {token: "garbage", login: fresh, now: now},
	} {
		t.Run(name, func(t *testing.T) {
			var urls []string
			c := &Cloudflared{Run: f.run, Now: func() time.Time { return now }, OnSignIn: func(u string) { urls = append(urls, u) }}
			got, err := c.Token(context.Background(), "https://pedit.example.com")
			if err != nil || got != fresh {
				t.Fatalf("Token = %q, %v", got, err)
			}
			if !strings.Contains(fmt.Sprint(f.calls), "access login --quiet https://pedit.example.com") {
				t.Fatalf("calls = %q", f.calls)
			}
			// Kept off for now; see the comment in Token.
			if strings.Contains(fmt.Sprint(f.calls), "--auto-close") {
				t.Fatalf("passes --auto-close: %q", f.calls)
			}
			if want := []string{"https://pedit.example.com/cdn-cgi/access/cli?token=abc"}; fmt.Sprint(urls) != fmt.Sprint(want) {
				t.Fatalf("sign-in URLs = %q", urls)
			}
		})
	}
}

// cloudflared does not replace a token that has not expired yet, so in the
// last minute of an Access session pedit gets the same token back after login.
func TestTokenAboutToExpire(t *testing.T) {
	last := jwt("k@example.com", now.Add(10*time.Second))
	f := &fakeCloudflared{token: last, login: jwt("k@example.com", now.Add(24*time.Hour)), now: now}
	got, err := (&Cloudflared{Run: f.run, Now: func() time.Time { return now }}).Token(context.Background(), "https://pedit.example.com")
	if err != nil || got != last {
		t.Fatalf("Token = %q, %v", got, err)
	}
	if !strings.Contains(fmt.Sprint(f.calls), "access login") {
		t.Fatalf("did not try to sign in: %q", f.calls)
	}
}

func TestTokenReportsFailedSignIn(t *testing.T) {
	f := &fakeCloudflared{loginErr: errors.New("exit status 1")}
	_, err := (&Cloudflared{Run: f.run, Now: func() time.Time { return now }}).Token(context.Background(), "https://pedit.example.com")
	// cloudflared's output explains what went wrong.
	if err == nil || !strings.Contains(err.Error(), "could not sign in to https://pedit.example.com") || !strings.Contains(err.Error(), "browser failed to open") {
		t.Fatalf("err = %v", err)
	}
}

// When the caller stops waiting (Ctrl+C or a time limit), cloudflared is
// killed, and Token reports why rather than a failed sign-in.
func TestTokenReportsCallerStoppingSignIn(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	timedOut, cancelTimeout := context.WithTimeout(context.Background(), 0)
	defer cancelTimeout()

	// Like exec.CommandContext: cloudflared is killed once ctx is done.
	run := func(ctx context.Context, _, _ io.Writer, args ...string) error {
		if args[1] == "token" {
			return errors.New("exit status 1")
		}
		<-ctx.Done()
		return errors.New("signal: killed")
	}
	for ctx, want := range map[context.Context]error{cancelled: context.Canceled, timedOut: context.DeadlineExceeded} {
		_, err := (&Cloudflared{Run: run}).Token(ctx, "https://pedit.example.com")
		if !errors.Is(err, want) {
			t.Errorf("err = %v, want %v", err, want)
		}
	}
}

func TestTokenWithoutCloudflared(t *testing.T) {
	run := func(context.Context, io.Writer, io.Writer, ...string) error { return ErrNoCloudflared }
	_, err := (&Cloudflared{Run: run}).Token(context.Background(), "https://pedit.example.com")
	if !errors.Is(err, ErrNoCloudflared) {
		t.Fatalf("err = %v", err)
	}
}

func TestEmail(t *testing.T) {
	if got := Email(jwt("k@example.com", now)); got != "k@example.com" {
		t.Fatalf("Email = %q", got)
	}
	for _, token := range []string{"", "a.b", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte("[]")) + ".c"} {
		if got := Email(token); got != "" {
			t.Fatalf("Email(%q) = %q", token, got)
		}
	}
}

func TestCachedNeverSignsIn(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for name, tc := range map[string]struct {
		token string
		want  bool
	}{
		"valid":      {jwt("k@example.com", now.Add(time.Hour)), true},
		"expiring":   {jwt("k@example.com", now.Add(10*time.Second)), false},
		"signed out": {"", false},
	} {
		f := &fakeCloudflared{token: tc.token, now: now}
		c := &Cloudflared{Run: f.run, Now: func() time.Time { return now }}
		got, err := c.Cached(context.Background(), "https://pedit.example.com")
		if err != nil || (got != "") == !tc.want || (tc.want && got != tc.token) {
			t.Errorf("%s: %q, %v", name, got, err)
		}
		for _, call := range f.calls {
			if strings.HasPrefix(call, "access login") {
				t.Errorf("%s: signed in: %v", name, f.calls)
			}
		}
	}
	c := &Cloudflared{Run: func(context.Context, io.Writer, io.Writer, ...string) error { return ErrNoCloudflared }}
	if _, err := c.Cached(context.Background(), "https://pedit.example.com"); !errors.Is(err, ErrNoCloudflared) {
		t.Errorf("without cloudflared: %v", err)
	}
}
