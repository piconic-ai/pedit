package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/piconic-ai/pedit/internal/session"
)

func (l *liveSharer) Comments(ctx context.Context) error {
	threads, err := l.readComments()
	if err != nil {
		return err
	}
	return sendCommentsPages(threads, func(seq int, done bool, parts []commentsPart) error {
		return l.st.EventContext(ctx, "comments_page", answerWith(ctx, map[string]any{"seq": seq, "done": done, "parts": parts}))
	})
}

func (l *liveSharer) readComments() ([]session.PlacedThread, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cur != nil {
		return l.cur.session.PlacedThreads(), nil
	}
	cfg, err := loadProject(filepath.Dir(l.srv.Path()))
	if err != nil {
		return nil, err
	}
	saved, err := session.ReadSavedComments(cfg.root, l.srv.Path())
	if errors.Is(err, session.ErrNoSavedComments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return session.PlaceSavedComments(saved, l.srv.Text()), nil
}

type commentsPart struct {
	Thread   threadView    `json:"thread"`
	Offset   int           `json:"offset"`
	Total    int           `json:"total"`
	Messages []messageView `json:"messages"`
}

const commentsPageBudget = maxCommentsEvent - 1024

type commentsPages struct {
	parts     []commentsPart
	size, seq int
	send      func(int, bool, []commentsPart) error
}

func sendCommentsPages(threads []session.PlacedThread, send func(int, bool, []commentsPart) error) error {
	pages := commentsPages{parts: []commentsPart{}, size: 2, send: send}
	for _, t := range threads {
		if err := pages.thread(t); err != nil {
			return err
		}
	}
	return pages.flush(true)
}

func (p *commentsPages) flush(done bool) error {
	if err := p.send(p.seq, done, p.parts); err != nil {
		return err
	}
	p.parts, p.size, p.seq = []commentsPart{}, 2, p.seq+1
	return nil
}

func (p *commentsPages) thread(t session.PlacedThread) error {
	v := viewOf(t)
	messages := v.Messages
	v.Messages = nil
	for offset := 0; offset < len(messages) || offset == 0; {
		part, n, end := fitCommentsPart(v, messages, offset, commentsPageBudget-p.size)
		if p.size+n > commentsPageBudget || end == offset && len(messages) > 0 {
			if len(p.parts) == 0 {
				return fmt.Errorf("comment thread %s cannot fit a response page", t.ID)
			}
			if err := p.flush(false); err != nil {
				return err
			}
			continue
		}
		p.parts = append(p.parts, part)
		p.size += n + 1
		offset = end
		if offset == len(messages) {
			return nil
		}
		if err := p.flush(false); err != nil {
			return err
		}
	}
	return nil
}

func fitCommentsPart(v threadView, messages []messageView, offset, room int) (commentsPart, int, int) {
	part := commentsPart{Thread: v, Offset: offset, Total: len(messages), Messages: []messageView{}}
	size, end := jsonSize(part), offset
	for end < len(messages) {
		n := jsonSize(messages[end]) + 1
		if size+n > room {
			break
		}
		part.Messages = append(part.Messages, messages[end])
		size += n
		end++
	}
	return part, size, end
}
