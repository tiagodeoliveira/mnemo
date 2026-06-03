package digest

import (
	"strings"
	"testing"
)

func TestRenderHTML(t *testing.T) {
	md := "## Projects\n\n- **auris**: fixed audio resume\n- mnemo: decay shipped\n"
	html, err := renderHTML(md)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "<h2>Projects</h2>") {
		t.Fatalf("heading not rendered:\n%s", html)
	}
	if !strings.Contains(html, "<li>") || !strings.Contains(html, "<strong>auris</strong>") {
		t.Fatalf("list/bold not rendered:\n%s", html)
	}
}

func TestWrapEmail(t *testing.T) {
	out := wrapEmail("<h2>Projects</h2>")
	if !strings.HasPrefix(out, "<!DOCTYPE html>") {
		t.Fatalf("missing doctype:\n%s", out)
	}
	if !strings.Contains(out, "<style>") || !strings.Contains(out, "font-family") {
		t.Fatalf("missing stylesheet:\n%s", out)
	}
	if !strings.Contains(out, "<h2>Projects</h2>") {
		t.Fatalf("body not embedded:\n%s", out)
	}
}
