package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func setupMeTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	dsn := store.StartTestPG(t)
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertActor(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := NewRouter(Deps{
		Store:         s,
		Logger:        logger,
		EmbedClient:   &embed.Stub{},
		EmbedDisabled: true,
		DevActorID:    "alice",
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return srv
}

func TestMeGetReturnsProfile(t *testing.T) {
	srv := setupMeTestServer(t)

	resp, err := http.Get(srv.URL + "/me")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 200, got %d: %s", resp.StatusCode, string(body))
	}

	var result meResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.ActorID != "alice" {
		t.Errorf("actor_id: got %q, want alice", result.ActorID)
	}
	if result.Timezone != "UTC" {
		t.Errorf("timezone: got %q, want UTC", result.Timezone)
	}
	if result.DigestEnabled {
		t.Error("digest_enabled should default to false")
	}
}

func TestMePatchUpdatesProfile(t *testing.T) {
	srv := setupMeTestServer(t)

	body, _ := json.Marshal(map[string]any{
		"email":          "alice@example.com",
		"timezone":       "America/Sao_Paulo",
		"digest_enabled": true,
	})
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 200, got %d: %s", resp.StatusCode, string(raw))
	}

	var result meResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Email != "alice@example.com" {
		t.Errorf("email: got %q", result.Email)
	}
	if result.Timezone != "America/Sao_Paulo" {
		t.Errorf("timezone: got %q", result.Timezone)
	}
	if !result.DigestEnabled {
		t.Error("digest_enabled should be true")
	}

	// Verify GET reflects the update.
	getResp, err := http.Get(srv.URL + "/me")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = getResp.Body.Close() }()
	var getResult meResponse
	if err := json.NewDecoder(getResp.Body).Decode(&getResult); err != nil {
		t.Fatal(err)
	}
	if getResult.Email != "alice@example.com" || getResult.Timezone != "America/Sao_Paulo" || !getResult.DigestEnabled {
		t.Errorf("GET after PATCH mismatch: %+v", getResult)
	}
}

func TestMePatchPartialUpdate(t *testing.T) {
	srv := setupMeTestServer(t)

	// First set email.
	body1, _ := json.Marshal(map[string]any{"email": "alice@test.com"})
	req1, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body1))
	req1.Header.Set("Content-Type", "application/json")
	resp1, err := http.DefaultClient.Do(req1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp1.Body.Close() }()
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp1.StatusCode)
	}

	// Then update only timezone — email should be unchanged.
	body2, _ := json.Marshal(map[string]any{"timezone": "Europe/London"})
	req2, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body2))
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()

	var result meResponse
	if err := json.NewDecoder(resp2.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Email != "alice@test.com" {
		t.Errorf("email should be unchanged, got %q", result.Email)
	}
	if result.Timezone != "Europe/London" {
		t.Errorf("timezone: got %q", result.Timezone)
	}
}

func TestMePatchBadTimezone(t *testing.T) {
	srv := setupMeTestServer(t)

	body, _ := json.Marshal(map[string]any{"timezone": "Mars/Olympus"})
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestMePatchBadEmail(t *testing.T) {
	srv := setupMeTestServer(t)

	body, _ := json.Marshal(map[string]any{"email": "not-an-email"})
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestMePatchEmptyBody(t *testing.T) {
	srv := setupMeTestServer(t)

	body, _ := json.Marshal(map[string]any{})
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/me", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestMeMethodNotAllowed(t *testing.T) {
	srv := setupMeTestServer(t)

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/me", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", resp.StatusCode)
	}
}
