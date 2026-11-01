package session

import (
	"bytes"
	"fmt"

	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/reearth/ygo/crdt"
)

func keptRoot(path string) string {
	if isCanvas(path) {
		return formatCanvas
	}
	return "content"
}

func (h *keptTextDocument) render(previous string) string {
	if h.root != formatCanvas {
		return h.doc.GetText("content").ToString()
	}
	prior, _ := canvas.Parse([]byte(previous))
	return string(canvas.Render(canvas.Read(h.doc), prior))
}

func resumeCanvasContent(doc *crdt.Doc, file, initial string, state []byte) (*canvasContent, error) {
	previous, err := canvas.Parse([]byte(initial))
	if err != nil {
		return nil, describeCanvasError(file, err)
	}
	target := &keptTextDocument{doc: doc, root: formatCanvas}
	if err := target.apply(doc, state); err != nil || !completeKeptText(doc) || !target.matches(initial) {
		return nil, fmt.Errorf("%s changed after pedit took in the kept room; run pedit resume again", file)
	}
	return &canvasContent{doc: doc, last: previous}, nil
}

func (h *keptTextDocument) matches(text string) bool {
	if h.root != formatCanvas {
		return h.render(text) == text
	}
	parsed, err := canvas.Parse([]byte(text))
	return err == nil && bytes.Equal(canvas.Render(canvas.Read(h.doc), nil), canvas.Render(parsed.Canvas, nil))
}
