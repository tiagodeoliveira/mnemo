package digest

import (
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

func (m *Mailer) Send(to, subject, body string) error {
	if !m.Enabled() {
		return nil
	}
	host := m.Host
	if i := strings.Index(host, ":"); i > 0 {
		host = host[:i]
	}
	auth := smtp.PlainAuth("", m.User, m.Pass, host)
	msg := []byte(fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n",
		m.From, to, subject, body,
	))
	return smtp.SendMail(m.Host, auth, m.From, []string{to}, msg)
}
