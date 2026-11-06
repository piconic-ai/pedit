package doctor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	timeout      = 10 * time.Second
	maxRedirects = 5
	pageLimit    = 2 << 20
	scriptLimit  = 4 << 20
)

var errOffOrigin = errors.New("redirects to another origin")

// origin is scheme://host[:port] of u, in lower case.
func origin(u *url.URL) string {
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	scheme := strings.ToLower(u.Scheme)
	if port := u.Port(); port != "" && !(scheme == "https" && port == "443") && !(scheme == "http" && port == "80") {
		host += ":" + port
	}
	return scheme + "://" + host
}

func isLocalHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// newClient never keeps cookies, sends no Referer and follows redirects only
// within the origin of the first request.
func newClient() *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("more than %d redirects", maxRedirects)
			}
			if origin(req.URL) != origin(via[0].URL) {
				return errOffOrigin
			}
			// Go sets Referer on a redirect; the page's URL may be private.
			req.Header.Del("Referer")
			return nil
		},
	}
}

// response is a fetched body with the final URL and headers.
type response struct {
	URL    *url.URL
	Header http.Header
	Body   []byte
}

func fetch(ctx context.Context, client *http.Client, u *url.URL, limit int64, version string) (*response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "pedit/"+version+" doctor")
	resp, err := client.Do(req)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("larger than %d MiB", limit>>20)
	}
	return &response{URL: resp.Request.URL, Header: resp.Header, Body: body}, nil
}
