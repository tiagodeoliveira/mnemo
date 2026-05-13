package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

func newTestKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa: %v", err)
	}
	return k, "test-kid"
}

func jwksJSON(t *testing.T, k *rsa.PublicKey, kid string) []byte {
	t.Helper()
	n := base64.RawURLEncoding.EncodeToString(k.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01})
	jwks := map[string]any{
		"keys": []map[string]any{
			{"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": n, "e": e},
		},
	}
	b, _ := json.Marshal(jwks)
	return b
}

func issue(t *testing.T, k *rsa.PrivateKey, kid, iss, aud, sub string, exp time.Time) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": iss, "aud": aud, "sub": sub, "exp": exp.Unix(), "iat": time.Now().Unix(),
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(k)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func TestVerifyAcceptsValidToken(t *testing.T) {
	k, kid := newTestKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(jwksJSON(t, &k.PublicKey, kid))
	}))
	defer srv.Close()

	kf, err := keyfunc.NewDefault([]string{srv.URL})
	if err != nil {
		t.Fatalf("keyfunc: %v", err)
	}
	v := &Verifier{kf: kf, issuer: "https://example/", audience: "aud"}

	tok := issue(t, k, kid, "https://example/", "aud", "auth0|alice", time.Now().Add(time.Hour))
	sub, err := v.Verify(tok)
	if err != nil || sub != "auth0|alice" {
		t.Fatalf("got sub=%q err=%v", sub, err)
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	k, kid := newTestKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(jwksJSON(t, &k.PublicKey, kid))
	}))
	defer srv.Close()
	kf, _ := keyfunc.NewDefault([]string{srv.URL})
	v := &Verifier{kf: kf, issuer: "https://example/", audience: "aud"}

	tok := issue(t, k, kid, "https://example/", "aud", "auth0|alice", time.Now().Add(-time.Hour))
	if _, err := v.Verify(tok); err == nil {
		t.Fatal("expected expiration error")
	}
}

func TestVerifyRejectsWrongAudience(t *testing.T) {
	k, kid := newTestKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(jwksJSON(t, &k.PublicKey, kid))
	}))
	defer srv.Close()
	kf, _ := keyfunc.NewDefault([]string{srv.URL})
	v := &Verifier{kf: kf, issuer: "https://example/", audience: "aud"}

	tok := issue(t, k, kid, "https://example/", "other-aud", "auth0|alice", time.Now().Add(time.Hour))
	if _, err := v.Verify(tok); err == nil {
		t.Fatal("expected audience error")
	}
}
