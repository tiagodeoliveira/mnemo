package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type okPinger struct{}

func (okPinger) PingContext(context.Context) error { return nil }

func TestHealthOK(t *testing.T) {
	h := &healthHandler{db: okPinger{}}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/healthz", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200 got %d", rr.Code)
	}
	if got := rr.Body.String(); got != "{\"db\":true}\n" {
		t.Fatalf("unexpected body %q", got)
	}
}
