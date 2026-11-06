package protocol

import (
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

func TestFreshAnswerResendsEditsMadeBeforeItIsQueued(t *testing.T) {
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "later", nil) })
	key, err := DecodeKey(GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewClient(ClientOptions{Key: key, Doc: doc, Awareness: awareness.New(uint64(doc.ClientID()))})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { c.out = nil; c.Destroy() }()
	c.out = &outbox{wake: make(chan struct{}, 1)}
	c.mu.Lock()
	done := make(chan error, 1)
	go func() {
		nonce := c.fresh.current()
		done <- c.receiveFresh(AccessEdit, true, Sender{1}, 1, EncodeFresh(FreshMessage{Nonce: Nonce{1}, Answer: &nonce}))
	}()
	blocked := false
	deadline := time.Now().Add(3 * time.Second)
	stacks := make([]byte, 64*1024)
	for time.Now().Before(deadline) {
		n := runtime.Stack(stacks, true)
		if n == len(stacks) {
			stacks = make([]byte, 2*len(stacks))
			continue
		}
		for _, stack := range strings.Split(string(stacks[:n]), "\n\n") {
			if strings.Contains(stack, "(*Client).sendAt") && strings.Contains(stack, "(*Client).receiveFresh") {
				blocked = true
				break
			}
		}
		if blocked {
			break
		}
		runtime.Gosched()
	}
	c.fresh.wrote()
	c.mu.Unlock()
	if !blocked {
		t.Error("fresh answer did not wait to be queued")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	out := c.out
	c.out = nil
	got := crdt.New()
	defer got.Destroy()
	answered := false
	for _, frame := range out.queue {
		plain, err := c.cipher.Decrypt(frame)
		if err != nil {
			t.Fatal(err)
		}
		_, _, signed, err := DecodeFrame(plain)
		if err != nil {
			t.Fatal(err)
		}
		_, message, err := c.keys.openMessage(plain[:frameHeaderBytes], signed)
		if err != nil {
			t.Fatal(err)
		}
		kind, payload, err := DecodeMessage(message)
		if err != nil {
			t.Fatal(err)
		}
		if kind == MessageFresh {
			answered = true
		}
		if kind == MessageSync {
			if !answered {
				t.Fatal("state was sent before the fresh answer")
			}
			if _, err := ysync.ApplySyncMessage(got, payload, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	if text := got.GetText("content").ToString(); text != "later" {
		t.Fatalf("state sent after the fresh answer = %q, want later", text)
	}
}
