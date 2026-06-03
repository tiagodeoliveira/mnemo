package digest

import (
	"bytes"
	"fmt"

	"github.com/yuin/goldmark"
)

// renderHTML converts the digest markdown into an HTML fragment (no document
// wrapper). Used for the text/html part of the digest email.
func renderHTML(md string) (string, error) {
	var buf bytes.Buffer
	if err := goldmark.Convert([]byte(md), &buf); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// emailCSS is a minimal stylesheet for the digest email, kept in a <style>
// block in <head> — adequate for the modern mail clients the actor uses.
const emailCSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #eee; color: #111; }
  ul { margin: 4px 0 12px; padding-left: 20px; }
  li { margin: 2px 0; }
  p  { margin: 6px 0; }
  strong { color: #000; }
`

// wrapEmail wraps an HTML fragment in a complete, styled HTML document.
func wrapEmail(htmlBody string) string {
	return fmt.Sprintf(
		`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>%s</style></head><body>%s</body></html>`,
		emailCSS, htmlBody,
	)
}
