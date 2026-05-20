package api

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/time/rate"
)

// ── clientIP ─────────────────────────────────────────────────────────

func TestClientIP(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		xff        string
		want       string
	}{
		{"remote addr only", "10.0.0.1:1234", "", "10.0.0.1"},
		{"xff single", "10.0.0.1:1234", "203.0.113.50", "203.0.113.50"},
		{"xff chain uses first", "10.0.0.1:1234", "203.0.113.50, 70.41.3.18, 150.172.238.178", "203.0.113.50"},
		{"xff with spaces", "10.0.0.1:1234", "  203.0.113.50 ", "203.0.113.50"},
		{"remote addr no port", "10.0.0.1", "", "10.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			got := clientIP(r)
			if got != tc.want {
				t.Errorf("clientIP() = %q, want %q", got, tc.want)
			}
		})
	}
}

// ── Rate limiting ────────────────────────────────────────────────────

func TestRateLimitMiddleware(t *testing.T) {
	// 1 req/s, burst of 2 — third request should be rejected.
	rl := newIPRateLimiter(rate.Limit(1), 2)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := rateLimitMiddleware(rl)(ok)

	for i := 0; i < 2; i++ {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "10.0.0.1:1234"
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: want 200, got %d", i, rr.Code)
		}
	}

	// Third request (burst exhausted) should be rate-limited.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("request 3: want 429, got %d", rr.Code)
	}

	// Different IP should still be allowed.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.2:5678"
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("different IP: want 200, got %d", rr.Code)
	}
}

// ── Body limiting ────────────────────────────────────────────────────

func TestLimitBodyMiddleware(t *testing.T) {
	const limit int64 = 64

	echoHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	handler := limitBodyMiddleware(limit)(echoHandler)

	t.Run("within limit", func(t *testing.T) {
		body := bytes.NewReader(bytes.Repeat([]byte("a"), int(limit)))
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("POST", "/", body))
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200, got %d", rr.Code)
		}
	})

	t.Run("exceeds limit", func(t *testing.T) {
		body := bytes.NewReader(bytes.Repeat([]byte("a"), int(limit)+1))
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("POST", "/", body))
		if rr.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("want 413, got %d", rr.Code)
		}
	})

	t.Run("nil body", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("want 200, got %d", rr.Code)
		}
	})
}

// ── parseTimeRange ───────────────────────────────────────────────────

func TestParseTimeRange(t *testing.T) {
	t.Run("valid RFC3339", func(t *testing.T) {
		s, u, err := parseTimeRange("2024-06-01T12:00:00Z", "2024-06-30T23:59:59Z")
		if err != nil {
			t.Fatal(err)
		}
		if !s.Valid || !u.Valid {
			t.Fatal("expected both to be valid")
		}
	})

	t.Run("valid date-only", func(t *testing.T) {
		s, u, err := parseTimeRange("2024-06-01", "2024-06-30")
		if err != nil {
			t.Fatal(err)
		}
		if !s.Valid || !u.Valid {
			t.Fatal("expected both to be valid")
		}
	})

	t.Run("empty strings", func(t *testing.T) {
		s, u, err := parseTimeRange("", "")
		if err != nil {
			t.Fatal(err)
		}
		if s.Valid || u.Valid {
			t.Fatal("expected both to be invalid (no filter)")
		}
	})

	t.Run("bad since", func(t *testing.T) {
		_, _, err := parseTimeRange("not-a-date", "")
		if err == nil {
			t.Fatal("expected error for bad since")
		}
		if !strings.Contains(err.Error(), "since") {
			t.Errorf("error should mention 'since': %v", err)
		}
	})

	t.Run("bad until", func(t *testing.T) {
		_, _, err := parseTimeRange("", "2024-13-01")
		if err == nil {
			t.Fatal("expected error for bad until (month 13)")
		}
		if !strings.Contains(err.Error(), "until") {
			t.Errorf("error should mention 'until': %v", err)
		}
	})

	t.Run("bad both returns since error first", func(t *testing.T) {
		_, _, err := parseTimeRange("nope", "also-nope")
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "since") {
			t.Errorf("should report since first: %v", err)
		}
	})
}
