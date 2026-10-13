package filewriter

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// TestStressEditorSavesWhilePeditWrites saves a file from a separate process,
// at a random moment around pedit's write, and counts the saves that are lost.
// A separate process is what makes it honest: an editor's open, truncate and
// rename do not wait for pedit's goroutines. The editor starts when the
// temporary file appears in the directory, as a file watcher would see it, so
// its save lands around pedit's exchange rather than long before or after it.
//
// It is opt-in, as it takes a while and is probabilistic:
//
//	PEDIT_STRESS=1 go test -race -run TestStress -v ./internal/filewriter/
//
// Three editors take turns: one renames a new file over the old one, one
// truncates and writes the file in place, and one opens the file, then
// truncates and writes it a moment later. PEDIT_STRESS_RUNS (300 per editor),
// PEDIT_STRESS_JITTER_US (1500, how long after the temporary file appeared the
// editor may start), PEDIT_STRESS_SIZE (1 MiB, the padding of pedit's content:
// the longer it takes to write, the more saves land before the exchange, not
// after it), PEDIT_STRESS_GAP_US (3000, how long the third waits after opening;
// saves later than about 5 ms are expected to be lost) and
// PEDIT_STRESS_MAX_LOST (0) tune it. PEDIT_STRESS_FALLBACK=1 forces the write
// that renames over the file, where losses are expected and only counted.
//
// The third editor's save can still land after pedit's second read when the
// machine is busy: under 4x CPU load, about 1 run in 2,000 lost it. The default
// of 0 therefore reports an occasional loss on a loaded machine; raise
// PEDIT_STRESS_MAX_LOST to a few there.
//
// Every .pedit-*.tmp file left in a run's directory fails the run, except one
// that Flush returned in a *KeptError: a save pedit could not put back, which
// is counted as kept aside.
func TestStressEditorSavesWhilePeditWrites(t *testing.T) {
	if os.Getenv("PEDIT_STRESS") != "1" {
		t.Skip("opt-in: set PEDIT_STRESS=1")
	}
	fallback := os.Getenv("PEDIT_STRESS_FALLBACK") == "1"
	if !fallback {
		requireExchange(t)
	}
	runs := stressEnv(t, "PEDIT_STRESS_RUNS", 300)
	jitter := stressEnv(t, "PEDIT_STRESS_JITTER_US", 1500)
	gap := stressEnv(t, "PEDIT_STRESS_GAP_US", 3000)
	maxLost := stressEnv(t, "PEDIT_STRESS_MAX_LOST", 0)
	size := stressEnv(t, "PEDIT_STRESS_SIZE", 1<<20)
	for _, style := range []string{"rename", "inplace", "late"} {
		t.Run(style, func(t *testing.T) {
			stressStyle(t, style, runs, jitter, gap, maxLost, size, fallback)
		})
	}
}

func stressEnv(t *testing.T, name string, def int) int {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		t.Fatalf("%s=%q is not a count", name, v)
	}
	return n
}

func stressStyle(t *testing.T, style string, runs, jitter, gap, maxLost, size int, fallback bool) {
	editor := startEditor(t)
	var kept, landed, keptAside, reported, silent, garbled int
	for i := range runs {
		dir := t.TempDir()
		path := filepath.Join(dir, "a.md")
		if err := os.WriteFile(path, []byte("v0"), 0o640); err != nil {
			t.Fatal(err)
		}
		bound, err := OpenBound(path)
		if err != nil {
			t.Fatal(err)
		}
		if fallback {
			bound.noExchange.Store(true)
		}
		w := New(path, "v0", Options{Bound: bound, Delay: time.Hour})
		// The padding makes pedit's content take a while to write, which is the
		// stretch between the temporary file appearing and the exchange.
		pedit, save := "pedit "+strconv.Itoa(i)+strings.Repeat("x", size), "editor "+strconv.Itoa(i)
		w.Schedule(pedit)
		micros := rand.IntN(jitter + 1)
		switch {
		case i%2 == 0:
			// Close to the exchange, where the write is most exposed.
			micros /= 4
		case i%4 == 3:
			// Well after it.
			micros *= 4
		}
		editor.save(t, style, time.Duration(micros)*time.Microsecond, time.Duration(rand.IntN(gap+1))*time.Microsecond, path, save)
		flushErr := w.Flush()
		editor.wait(t)

		disk, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		aside := false
		// A save kept under a temporary name is the documented pathological
		// case when Flush names it in a *KeptError. Any other temporary file
		// left behind is a leak: pedit's own content, or the old file Write
		// should have removed.
		var keptErr *KeptError
		_ = errors.As(flushErr, &keptErr)
		left, _ := filepath.Glob(filepath.Join(dir, ".pedit-*.tmp"))
		for _, name := range left {
			if b, err := os.ReadFile(name); err == nil && string(b) == save {
				aside = true
			}
			if keptErr == nil || keptErr.Name != filepath.Base(name) {
				t.Errorf("run %d: left %s behind (Flush = %v)", i, filepath.Base(name), flushErr)
			}
		}
		switch {
		case string(disk) == save && errors.Is(flushErr, ErrExternalChange):
			kept++
		case string(disk) == save:
			landed++
		case aside:
			keptAside++
		case string(disk) == pedit && errors.Is(flushErr, ErrSaveOverwritten):
			reported++
		case string(disk) == pedit:
			silent++
		default:
			garbled++
			t.Logf("run %d: file %q, Flush = %v, kept %v", i, disk, flushErr, left)
		}
		_ = bound.Close()
	}
	t.Logf("%s, %d runs: save put back %d, landed after the write %d, kept aside %d, lost and reported %d, lost silently %d, other %d",
		style, runs, kept, landed, keptAside, reported, silent, garbled)
	if garbled != 0 {
		t.Errorf("%d runs ended in a state that is neither pedit's write nor the save", garbled)
	}
	if !fallback && reported+silent > maxLost {
		t.Errorf("lost %d saves (%d silently), want at most %d", reported+silent, silent, maxLost)
	}
}

// editorProcess is a separate process that saves files when told to.
type editorProcess struct {
	in  io.Writer
	out *bufio.Reader
}

func startEditor(t *testing.T) *editorProcess {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestStressEditorChild$", "-test.count=1")
	cmd.Env = append(os.Environ(), "PEDIT_STRESS_CHILD=1")
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = in.Close()
		if err := cmd.Wait(); err != nil {
			t.Errorf("editor process: %v", err)
		}
	})
	e := &editorProcess{in: in, out: bufio.NewReader(out)}
	e.expect(t, "ready")
	return e
}

// save tells the editor to save content to path, delay after a temporary file
// appears in path's directory, and returns once the editor is watching it. A
// "late" editor opens the file then, and writes it gap later.
func (e *editorProcess) save(t *testing.T, style string, delay, gap time.Duration, path, content string) {
	t.Helper()
	_, _ = fmt.Fprintf(e.in, "%s\t%d\t%d\t%s\t%s\n", style, delay.Microseconds(), gap.Microseconds(), path, content)
	e.expect(t, "armed")
}

func (e *editorProcess) wait(t *testing.T) { t.Helper(); e.expect(t, "done") }

func (e *editorProcess) expect(t *testing.T, want string) {
	t.Helper()
	line, err := e.out.ReadString('\n')
	if strings.TrimSpace(line) != want {
		t.Fatalf("editor process said %q (%v), want %q", line, err, want)
	}
}

// waitForTemp returns when a temporary file of pedit's is created in dir.
func waitForTemp(t *testing.T, watcher *fsnotify.Watcher, dir string) {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev := <-watcher.Events:
			// Events of an earlier run's directory may still be queued.
			if ev.Has(fsnotify.Create) && filepath.Dir(ev.Name) == dir && strings.HasPrefix(filepath.Base(ev.Name), ".pedit-") {
				return
			}
		case err := <-watcher.Errors:
			t.Fatal(err)
		case <-timeout:
			t.Fatal("pedit never created a temporary file")
		}
	}
}

// TestStressEditorChild is the editor process of the stress test. It saves
// what it is told to, one line at a time on standard input, once pedit creates
// its temporary file, and says "armed" when it watches for it, "done" when it
// saved.
func TestStressEditorChild(t *testing.T) {
	if os.Getenv("PEDIT_STRESS_CHILD") != "1" {
		t.Skip("the editor process of TestStressEditorSavesWhilePeditWrites")
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	fmt.Println("ready")
	lines := bufio.NewScanner(os.Stdin)
	for lines.Scan() {
		fields := strings.SplitN(lines.Text(), "\t", 5)
		if len(fields) != 5 {
			t.Fatalf("bad command %q", lines.Text())
		}
		delay, err := strconv.Atoi(fields[1])
		if err != nil {
			t.Fatal(err)
		}
		gap, err := strconv.Atoi(fields[2])
		if err != nil {
			t.Fatal(err)
		}
		path, content := fields[3], fields[4]
		dir := filepath.Dir(path)
		if err := watcher.Add(dir); err != nil {
			t.Fatal(err)
		}
		fmt.Println("armed")
		waitForTemp(t, watcher, dir)
		_ = watcher.Remove(dir)
		time.Sleep(time.Duration(delay) * time.Microsecond)
		switch fields[0] {
		case "rename":
			editorSave(t, path, renameSave, content)
		case "inplace":
			editorSave(t, path, inPlaceSave, content)
		case "late":
			// An open() that found the old file, and a write that comes after.
			f, err := os.OpenFile(path, os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
				break
			}
			time.Sleep(time.Duration(gap) * time.Microsecond)
			if err := f.Truncate(0); err != nil {
				t.Error(err)
			}
			if _, err := f.WriteAt([]byte(content), 0); err != nil {
				t.Error(err)
			}
			if err := f.Close(); err != nil {
				t.Error(err)
			}
		default:
			t.Fatalf("unknown style %q", fields[0])
		}
		fmt.Println("done")
	}
}
