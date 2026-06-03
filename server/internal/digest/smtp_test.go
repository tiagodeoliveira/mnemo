package digest

import (
	"strings"
	"testing"
)

func TestBuildMessageMultipart(t *testing.T) {
	m := &Mailer{From: "mnemo@example.com"}
	raw := m.buildMessage("to@example.com", "mnemo daily digest 2026-06-02",
		"## Projects\n\n- **auris**: fixed audio\n")
	s := string(raw)

	if !strings.Contains(s, "Content-Type: multipart/alternative;") {
		t.Fatalf("not multipart:\n%s", s)
	}
	if !strings.Contains(s, "Content-Type: text/plain; charset=UTF-8") {
		t.Fatalf("missing plain part:\n%s", s)
	}
	if !strings.Contains(s, "Content-Type: text/html; charset=UTF-8") {
		t.Fatalf("missing html part:\n%s", s)
	}
	// Plain part keeps the raw markdown; html part renders it.
	if !strings.Contains(s, "## Projects") {
		t.Fatalf("plain markdown missing:\n%s", s)
	}
	if !strings.Contains(s, "<h2>Projects</h2>") {
		t.Fatalf("rendered html missing:\n%s", s)
	}
	if !strings.Contains(s, "Subject: mnemo daily digest 2026-06-02") {
		t.Fatalf("subject missing:\n%s", s)
	}
	if !strings.Contains(s, "--"+mimeBoundary+"--") {
		t.Fatalf("missing closing multipart boundary:\n%s", s)
	}
}
