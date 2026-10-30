module github.com/piconic-ai/pedit

go 1.26.0

// The Go release that builds pedit (CI and the release archives, through
// setup-go). `go 1.25.0` above stays the minimum version, and it also keeps
// the GODEBUG defaults of 1.25, so moving this line only brings in a newer
// compiler and standard library: bump it with each Go patch release.
toolchain go1.27.2

// The TypeScript packages live alongside; keep ./... out of node_modules.
ignore (
	./node_modules
	./packages
)

require (
	github.com/coder/websocket v1.8.15
	github.com/fsnotify/fsnotify v1.10.1
	github.com/reearth/ygo v1.54.0
	github.com/sergi/go-diff v1.4.0
	golang.org/x/sys v0.49.0
	golang.org/x/term v0.47.0
	gopkg.in/yaml.v3 v3.0.1
)

require golang.org/x/text v0.43.0
