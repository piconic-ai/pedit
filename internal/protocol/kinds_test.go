package protocol_test

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

func TestKindHelpersMirrorTheTypeScriptOnes(t *testing.T) {
	if got := protocol.WithKind(protocol.KindSnapshot, []byte{1}, []byte{2, 3}); !bytes.Equal(got, []byte{2, 1, 2, 3}) {
		t.Fatalf("WithKind = %v", got)
	}
	if kind, payload, ok := protocol.SplitKind([]byte{4, 9}); !ok || kind != 4 || !bytes.Equal(payload, []byte{9}) {
		t.Fatal("SplitKind")
	}
	if _, _, ok := protocol.SplitKind(nil); ok {
		t.Fatal("SplitKind of nothing")
	}
	logged := protocol.EncodeLogged(258, []byte("entry"))
	if !bytes.Equal(logged[:9], []byte{4, 0, 0, 0, 0, 0, 0, 1, 2}) {
		t.Fatalf("EncodeLogged = %v", logged[:9])
	}
	if id, entry, ok := protocol.DecodeLogged(logged[1:]); !ok || id != 258 || string(entry) != "entry" {
		t.Fatal("DecodeLogged")
	}
	if cp := protocol.EncodeCheckpoint(7, []byte("b")); !bytes.Equal(cp, []byte{3, 0, 0, 0, 0, 0, 0, 0, 7, 'b'}) {
		t.Fatalf("EncodeCheckpoint = %v", cp)
	}
	if tail, ok := protocol.DecodeLogEnd(protocol.EncodeLogEnd(5)[1:]); !ok || tail != 5 {
		t.Fatal("DecodeLogEnd")
	}
	if n, ok := protocol.ParseNumbers("keep", "keep 60 1700000000000", 2); !ok || n[0] != 60 || n[1] != 1700000000000 {
		t.Fatal("ParseNumbers")
	}
	for _, text := range []string{"keep 60", "keep 60 x", "keep -1 2", "keepsake 1 2", "keep 1 2 3"} {
		if _, ok := protocol.ParseNumbers("keep", text, 2); ok {
			t.Errorf("ParseNumbers accepted %q", text)
		}
	}
}

// scriptedPeer joins a room on a Scripted dialer.
func scriptedPeer(t *testing.T, s *prototest.Scripted, key string, o protocol.ClientOptions) (*protocol.Client, *crdt.Doc) {
	t.Helper()
	raw, err := protocol.DecodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	o.URL, o.Key, o.Doc, o.Dial = "ws://test", raw, doc, s.Dial
	o.Awareness = awareness.New(uint64(doc.ClientID()))
	o.MinBackoff = 20 * time.Millisecond
	client, err := protocol.NewClient(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Destroy)
	client.Connect()
	return client, doc
}

func firstSent(t *testing.T, c *prototest.ScriptConn) []byte {
	t.Helper()
	select {
	case m := <-c.Sent:
		return m
	case <-time.After(wait):
		t.Fatal("the client sent nothing")
	}
	return nil
}

func TestVersion6FramesStartWithTheLiveKind(t *testing.T) {
	s := &prototest.Scripted{}
	key := protocol.GenerateKey()
	client, _ := scriptedPeer(t, s, key, protocol.ClientOptions{})
	sent := firstSent(t, waitConn(t, s))
	if sent[0] != protocol.KindLive {
		t.Fatalf("first message has kind %d", sent[0])
	}
	cipher, _ := protocol.NewCipher(client.Keys().FrameKey)
	if _, err := cipher.Decrypt(sent[1:]); err != nil {
		t.Fatalf("the payload after the kind is not a frame: %v", err)
	}
	if client.Version() != 6 {
		t.Fatalf("version = %d", client.Version())
	}
}

func waitConn(t *testing.T, s *prototest.Scripted) *prototest.ScriptConn {
	t.Helper()
	prototest.WaitFor(t, wait, func() bool { return len(s.Conns()) > 0 }, "a connection")
	return s.Conns()[0]
}

func TestVersion5HasNoKindByte(t *testing.T) {
	s := &prototest.Scripted{Subprotocol: "pedit-v5"}
	key := protocol.GenerateKey()
	client, _ := scriptedPeer(t, s, key, protocol.ClientOptions{})
	sent := firstSent(t, waitConn(t, s))
	cipher, _ := protocol.NewCipher(client.Keys().FrameKey)
	if _, err := cipher.Decrypt(sent); err != nil {
		t.Fatalf("a version 5 message is a bare frame: %v", err)
	}
	if client.SendMessage(protocol.WithKind(protocol.KindSnapshot, []byte("x"))) {
		t.Fatal("sent a kind to a version 5 relay")
	}
}

// Two version 6 peers behind a relay that passes kind 0 messages on edit each
// other's text; a kind the client does not handle reaches OnKind and
// changes nothing.
func TestVersion6PeersSyncAndUnknownKindsAreIgnored(t *testing.T) {
	sa, sb := &prototest.Scripted{}, &prototest.Scripted{}
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var kinds []byte
	var errs []error
	a, da := scriptedPeer(t, sa, key, protocol.ClientOptions{
		OnError: func(err error) { mu.Lock(); errs = append(errs, err); mu.Unlock() },
		OnKind:  func(kind byte, _ []byte) { mu.Lock(); kinds = append(kinds, kind); mu.Unlock() },
	})
	_, db := scriptedPeer(t, sb, key, protocol.ClientOptions{})
	ca, cb := waitConn(t, sa), waitConn(t, sb)
	forward := func(from, to *prototest.ScriptConn) {
		for m := range from.Sent {
			to.Push(m)
		}
	}
	go forward(ca, cb)
	go forward(cb, ca)
	ca.Push([]byte{9, 1, 2, 3})
	ca.Push([]byte{protocol.KindLogEnd, 0, 0, 0, 0, 0, 0, 0, 3})
	text := da.GetText("content")
	da.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "hello", nil) })
	prototest.WaitFor(t, wait, func() bool { return db.GetText("content").ToString() == "hello" }, "the text to arrive")
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(kinds) == 2 }, "both kinds to be passed on")
	mu.Lock()
	defer mu.Unlock()
	if kinds[0] != 9 || kinds[1] != protocol.KindLogEnd || len(errs) > 0 {
		t.Fatalf("kinds = %v, errors = %v", kinds, errs)
	}
	_ = a
}

func TestSendMessageWritesTheKindAndPayload(t *testing.T) {
	s := &prototest.Scripted{}
	client, _ := scriptedPeer(t, s, protocol.GenerateKey(), protocol.ClientOptions{})
	conn := waitConn(t, s)
	prototest.WaitFor(t, wait, func() bool { return client.Status() == protocol.StatusConnected }, "connected")
	if !client.SendMessage(protocol.WithKind(protocol.KindSnapshot, []byte("bundle"))) {
		t.Fatal("SendKind refused")
	}
	for m := range conn.Sent {
		if m[0] == protocol.KindSnapshot {
			if string(m[1:]) != "bundle" {
				t.Fatalf("payload = %q", m[1:])
			}
			return
		}
	}
}

// Texts of the relay move a guest between connected, waiting and kept; the
// ones the client does not act on go to OnText.
func TestKeptStatusAndRelayTexts(t *testing.T) {
	s := &prototest.Scripted{}
	var mu sync.Mutex
	var texts []string
	client, _ := scriptedPeer(t, s, protocol.GenerateKey(), protocol.ClientOptions{
		OnText: func(text string) { mu.Lock(); texts = append(texts, text); mu.Unlock() },
	})
	conn := waitConn(t, s)
	prototest.WaitFor(t, wait, func() bool { return client.Status() == protocol.StatusConnected }, "connected")
	conn.Say("kept 1700000000000")
	prototest.WaitFor(t, wait, func() bool { return client.Status() == protocol.StatusKept }, "kept")
	if !client.Status().HostAway() || protocol.StatusKept.Final() {
		t.Fatal("kept must be a host-away state that does not end the client")
	}
	conn.Say(protocol.HostBack)
	prototest.WaitFor(t, wait, func() bool { return client.Status() == protocol.StatusConnected }, "connected again")
	conn.Say("keep 60 0")
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(texts) == 1 }, "the keep text")
	if texts[0] != "keep 60 0" {
		t.Fatalf("texts = %v", texts)
	}
}
