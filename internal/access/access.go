// Package access signs in to a pedit server behind Cloudflare Access with
// cloudflared, so that sharing a file stays a single command.
package access

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Header is where Access looks for the token of a signed-in user.
const Header = "Cf-Access-Token"

// ErrNoCloudflared means cloudflared is not installed.
var ErrNoCloudflared = errors.New("cloudflared is not installed")

// Cloudflared gets the Access token of whoever runs pedit, signing in with the
// browser when there is no valid token yet. cloudflared keeps the token, so
// the browser opens only once per Access session.
type Cloudflared struct {
	// OnSignIn is called when the browser opens to sign in, with the URL to
	// open by hand in case it did not. cloudflared's own output is not shown.
	OnSignIn func(url string)
	// Run runs cloudflared. Tests replace it.
	Run func(ctx context.Context, stdout, stderr io.Writer, args ...string) error
	Now func() time.Time
}

func runCloudflared(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	path, err := exec.LookPath("cloudflared")
	if err != nil {
		return ErrNoCloudflared
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	return cmd.Run()
}

// Cached returns the token cloudflared keeps for app when it is still valid
// for a minute, without opening the browser: "" when there is none. It is for
// a request the user did not start, such as reading a room's status.
func (c *Cloudflared) Cached(ctx context.Context, app string) (string, error) {
	run := c.Run
	if run == nil {
		run = runCloudflared
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	var out bytes.Buffer
	if err := run(ctx, &out, io.Discard, "access", "token", "-app="+app); err != nil {
		if errors.Is(err, ErrNoCloudflared) {
			return "", err
		}
		return "", nil
	}
	if token := strings.TrimSpace(out.String()); validFor(token, now(), time.Minute) {
		return token, nil
	}
	return "", nil
}

// Token returns a token for the Access application at app, e.g. https://pedit.example.com
func (c *Cloudflared) Token(ctx context.Context, app string) (string, error) {
	run := c.Run
	if run == nil {
		run = runCloudflared
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}

	cached := func() (string, error) {
		var out bytes.Buffer
		if err := run(ctx, &out, io.Discard, "access", "token", "-app="+app); err != nil {
			return "", err
		}
		return strings.TrimSpace(out.String()), nil
	}
	// A token that is about to expire would not last through connecting, so
	// try to get a fresh one first.
	if token, err := cached(); errors.Is(err, ErrNoCloudflared) {
		return "", err
	} else if err == nil && validFor(token, now(), time.Minute) {
		return token, nil
	}

	// --quiet keeps the token itself out of the output. --auto-close is not
	// used for now: the browser tab stays open after signing in.
	out := &lineWatcher{onLine: func(line string) {
		if c.OnSignIn != nil && strings.HasPrefix(line, "https://") && strings.Contains(line, "/cdn-cgi/access/cli") {
			c.OnSignIn(line)
		}
	}}
	if err := run(ctx, out, out, "access", "login", "--quiet", app); err != nil {
		// Stopped by the caller (Ctrl+C or a time limit), not a failed sign-in.
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if msg := strings.TrimSpace(out.all.String()); msg != "" {
			return "", fmt.Errorf("could not sign in to %s: %w\n%s", app, err, msg)
		}
		return "", fmt.Errorf("could not sign in to %s: %w", app, err)
	}
	// cloudflared hands back a cached token until it has expired, even one
	// with seconds left, so take whatever has not expired yet. If it expires
	// while sharing, pedit cannot reconnect; see the README.
	token, err := cached()
	if err != nil || !validFor(token, now(), 0) {
		return "", fmt.Errorf("cloudflared signed in to %s but returned no usable token", app)
	}
	return token, nil
}

// lineWatcher keeps what cloudflared prints and calls onLine as each line
// arrives, so the sign-in URL shows up while cloudflared waits for the browser.
type lineWatcher struct {
	mu     sync.Mutex
	all    bytes.Buffer
	line   []byte
	onLine func(string)
}

func (w *lineWatcher) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.all.Write(p)
	for _, b := range p {
		if b != '\n' {
			w.line = append(w.line, b)
			continue
		}
		w.onLine(strings.TrimSpace(string(w.line)))
		w.line = w.line[:0]
	}
	return len(p), nil
}

type claims struct {
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
}

// parse reads the claims of a JWT without verifying it. Access verifies the
// token; we only look at it to decide whether to sign in and what to show.
func parse(token string) (claims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims{}, false
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return claims{}, false
	}
	return c, true
}

// validFor tells whether token has not expired by now+margin.
func validFor(token string, now time.Time, margin time.Duration) bool {
	c, ok := parse(token)
	return ok && c.Exp > now.Add(margin).Unix()
}

// Email is the email of the user a token was issued to, or "".
func Email(token string) string {
	c, _ := parse(token)
	return c.Email
}
