package digest

import (
	"bytes"
	"fmt"
	"net/smtp"
	"strings"
)

type Mailer struct {
	Host string // "smtp.example.com:587"
	User string
	Pass string
	From string
}

func (m *Mailer) Enabled() bool { return m.Host != "" && m.From != "" }

// mimeBoundary is a fixed multipart separator. The digest body is generated
// prose/markdown and will not contain this token.
const mimeBoundary = "mnemo-digest-boundary-7f3a2b1c9d"

// toCRLF normalizes line endings to CRLF. SMTP is a CRLF protocol; the digest
// body arrives with bare LF newlines, which strict relays can reject in a
// message body. Collapse any existing CRLF first to avoid doubling.
func toCRLF(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
}

// buildMessage assembles the full RFC822 multipart/alternative message: a
// text/plain part carrying the raw markdown (fallback) and a text/html part
// carrying the rendered, styled digest. If HTML rendering fails, the html part
// falls back to the raw body so a digest still goes out.
func (m *Mailer) buildMessage(to, subject, body string) []byte {
	htmlBody := body
	if rendered, err := renderHTML(body); err == nil {
		htmlBody = wrapEmail(rendered)
	}

	var msg bytes.Buffer
	fmt.Fprintf(&msg, "From: %s\r\n", m.From)
	fmt.Fprintf(&msg, "To: %s\r\n", to)
	fmt.Fprintf(&msg, "Subject: %s\r\n", subject)
	msg.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&msg, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", mimeBoundary)

	fmt.Fprintf(&msg, "--%s\r\n", mimeBoundary)
	msg.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	msg.WriteString(toCRLF(body))
	msg.WriteString("\r\n")

	fmt.Fprintf(&msg, "--%s\r\n", mimeBoundary)
	msg.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	msg.WriteString(toCRLF(htmlBody))
	msg.WriteString("\r\n")

	fmt.Fprintf(&msg, "--%s--\r\n", mimeBoundary)
	return msg.Bytes()
}

func (m *Mailer) Send(to, subject, body string) error {
	if !m.Enabled() {
		return nil
	}
	host := m.Host
	if i := strings.Index(host, ":"); i > 0 {
		host = host[:i]
	}
	auth := smtp.PlainAuth("", m.User, m.Pass, host)
	return smtp.SendMail(m.Host, auth, m.From, []string{to}, m.buildMessage(to, subject, body))
}
