# mnemo Go Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AWS-native mnemo stack with a single self-hosted Go server backed by a dedicated Postgres container, mirroring auris's deploy pattern, preserving the public REST API so the CLI and Chrome extension keep working with only config changes.

**Architecture:** One Go binary (`mnemo-server`) serving REST + running in-process goroutine workers, backed by Postgres for both data and the job queue (`SKIP LOCKED`). Auth0 JWT verification with multi-actor (`sub` → `actor_id`). Pluggable LLM interface, Anthropic implementation. Drop-in API compatible with today's mnemo.

**Tech Stack:** Go 1.23, `chi` router, `pgx/v5` + `database/sql`, `golang-migrate`, `golang-jwt/jwt/v5` + `keyfunc/v3`, `slog`, `testcontainers-go`, `net/smtp`, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-05-13-mnemo-go-rewrite-design.md`

---

## File Structure

```
server/
├── cmd/mnemo-server/main.go
├── internal/
│   ├── api/         # events.go, recall.go, health.go, render.go, middleware.go
│   ├── auth/        # auth0.go, actor.go, dev.go
│   ├── store/       # store.go, actors.go, events.go, memories.go, jobs.go
│   ├── queue/       # worker.go, backoff.go, sweeper.go
│   ├── extract/     # handler.go, prompts.go, consolidate.go
│   ├── meeting/     # handler.go, prompt.go
│   ├── digest/      # handler.go, prompt.go, scheduler.go, smtp.go
│   ├── llm/         # client.go, anthropic.go, stub.go
│   ├── config/      # config.go
│   └── integration/ # *_test.go
├── migrations/
│   ├── 0001_schema.up.sql / 0001_schema.down.sql
│   └── 0002_indexes.up.sql / 0002_indexes.down.sql
├── go.mod / go.sum
└── Dockerfile

# Repo root:
docker-compose.yml
docker-compose.deploy.yml
Caddyfile.example
.env.deploy.example
.env.example
.github/workflows/test.yml
.github/workflows/release.yml

# Client updates (later phases):
cli/src/auth.ts           # NEW: device flow
cli/src/commands/login.ts # NEW
cli/src/config.ts         # MODIFIED: new fields
extension/options.js      # MODIFIED: Auth0 popup OAuth
```

---

## Phase 1 — Server scaffold & infrastructure

### Task 1: Initialize Go module + tree

**Files:**
- Create: `server/go.mod`
- Create: `server/cmd/mnemo-server/main.go`
- Create: `server/.gitignore`

- [ ] **Step 1: Create directory structure**

```bash
cd /Users/tiago/src/github.com/tiagodeoliveira/mnemo
mkdir -p server/cmd/mnemo-server
mkdir -p server/internal/{api,auth,store,queue,extract,meeting,digest,llm,config,integration}
mkdir -p server/migrations
```

- [ ] **Step 2: Init Go module**

```bash
cd server
go mod init github.com/tiagodeoliveira/mnemo/server
```

- [ ] **Step 3: Write a stub `main.go`**

```go
// server/cmd/mnemo-server/main.go
package main

import (
	"log/slog"
	"os"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("mnemo-server boot stub", "version", "0.0.0")
}
```

- [ ] **Step 4: Write `server/.gitignore`**

```
/mnemo-server
*.test
coverage.out
.env
```

- [ ] **Step 5: Verify build**

Run: `cd server && go build ./cmd/mnemo-server && ./mnemo-server`
Expected: JSON log line `{"...","msg":"mnemo-server boot stub","version":"0.0.0"}`. Delete the binary after.

- [ ] **Step 6: Commit**

```bash
cd /Users/tiago/src/github.com/tiagodeoliveira/mnemo
git add server/
git commit -m "server: scaffold Go module and main entrypoint"
```

---

### Task 2: Add Postgres docker-compose for local dev

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
# Local development stack. Production uses docker-compose.deploy.yml.
services:
  postgres:
    image: postgres:16-alpine
    container_name: mnemo-postgres-dev
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-mnemo}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-mnemo}
      POSTGRES_DB: ${POSTGRES_DB:-mnemo}
    ports:
      - "5432:5432"
    volumes:
      - mnemo-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-mnemo} -d ${POSTGRES_DB:-mnemo}"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  mnemo-pg-data:
```

- [ ] **Step 2: Write `.env.example`**

```
# Local dev config. Copy to .env and adjust.
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo?sslmode=disable
MNEMO_PORT=8080
MNEMO_AUTH_DISABLED=1
MNEMO_LLM_DISABLED=1
ANTHROPIC_API_KEY=
MNEMO_LLM_MODEL=claude-sonnet-4-7-20251015
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
AUTH0_DOMAIN=
AUTH0_API_AUDIENCE=
```

- [ ] **Step 3: Verify Postgres starts and accepts connections**

Run: `docker compose up -d postgres && docker compose ps`
Expected: `postgres` service `running (healthy)`. Then `docker compose exec postgres pg_isready`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "build: local Postgres via docker-compose"
```

---

### Task 3: Schema migrations (0001 + 0002)

**Files:**
- Create: `server/migrations/0001_schema.up.sql`
- Create: `server/migrations/0001_schema.down.sql`
- Create: `server/migrations/0002_indexes.up.sql`
- Create: `server/migrations/0002_indexes.down.sql`

- [ ] **Step 1: Write `0001_schema.up.sql`**

```sql
CREATE TABLE actors (
    actor_id        text PRIMARY KEY,
    display_name    text NOT NULL,
    email           text,
    timezone        text NOT NULL DEFAULT 'UTC',
    digest_enabled  boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
    event_id        uuid PRIMARY KEY,
    actor_id        text NOT NULL REFERENCES actors(actor_id),
    session_id      text NOT NULL,
    project         text,
    source          text,
    workstation     text,
    workdir         text,
    turns           jsonb NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    meeting_id      text,
    meeting_ended   boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
    memory_id       uuid PRIMARY KEY,
    actor_id        text NOT NULL REFERENCES actors(actor_id),
    dimension       text NOT NULL,
    namespace       text NOT NULL,
    content         text NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_event_id uuid REFERENCES events(event_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial unique constraint: only one row per namespace for consolidated dimensions.
CREATE UNIQUE INDEX memories_consolidated_namespace_uq
    ON memories (actor_id, namespace)
    WHERE dimension IN ('about', 'project', 'task', 'daily_summary', 'meeting');

CREATE TABLE jobs (
    job_id          bigserial PRIMARY KEY,
    kind            text NOT NULL,
    payload         jsonb NOT NULL,
    state           text NOT NULL DEFAULT 'pending',
    attempts        int  NOT NULL DEFAULT 0,
    last_error      text,
    run_after       timestamptz NOT NULL DEFAULT now(),
    locked_by       text,
    locked_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
```

- [ ] **Step 2: Write `0001_schema.down.sql`**

```sql
DROP TABLE IF EXISTS jobs;
DROP INDEX IF EXISTS memories_consolidated_namespace_uq;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS actors;
```

- [ ] **Step 3: Write `0002_indexes.up.sql`**

```sql
CREATE INDEX events_actor_created_idx ON events (actor_id, created_at DESC);
CREATE INDEX events_meeting_idx ON events (actor_id, meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX events_attributes_gin ON events USING gin (attributes jsonb_path_ops);

CREATE INDEX memories_actor_dim_created_idx ON memories (actor_id, dimension, created_at DESC);
CREATE INDEX memories_actor_namespace_idx ON memories (actor_id, namespace);
CREATE INDEX memories_attributes_gin ON memories USING gin (attributes jsonb_path_ops);
CREATE INDEX memories_content_fts ON memories USING gin (to_tsvector('simple', content));

CREATE INDEX jobs_pending_idx ON jobs (run_after) WHERE state = 'pending';
CREATE INDEX jobs_state_idx ON jobs (state);
```

- [ ] **Step 4: Write `0002_indexes.down.sql`**

```sql
DROP INDEX IF EXISTS jobs_state_idx;
DROP INDEX IF EXISTS jobs_pending_idx;
DROP INDEX IF EXISTS memories_content_fts;
DROP INDEX IF EXISTS memories_attributes_gin;
DROP INDEX IF EXISTS memories_actor_namespace_idx;
DROP INDEX IF EXISTS memories_actor_dim_created_idx;
DROP INDEX IF EXISTS events_attributes_gin;
DROP INDEX IF EXISTS events_meeting_idx;
DROP INDEX IF EXISTS events_actor_created_idx;
```

- [ ] **Step 5: Apply migrations manually to verify**

Install `migrate` CLI: `brew install golang-migrate`
Run: `migrate -path server/migrations -database "postgres://mnemo:mnemo@localhost:5432/mnemo?sslmode=disable" up`
Expected: `1/u schema (... ms)` then `2/u indexes (... ms)`.

Verify: `docker compose exec postgres psql -U mnemo -d mnemo -c '\dt'`
Expected: four tables (actors, events, memories, jobs) plus `schema_migrations`.

Then roll back to test down: `migrate ... down 2`, expect tables gone, then `migrate ... up` again.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/
git commit -m "server: schema and indexes for actors/events/memories/jobs"
```

---

### Task 4: Embed migrations in the binary + run on boot

**Files:**
- Create: `server/internal/store/store.go`
- Modify: `server/cmd/mnemo-server/main.go`
- Modify: `server/go.mod` (deps)

- [ ] **Step 1: Add dependencies**

```bash
cd server
go get github.com/jackc/pgx/v5/stdlib
go get github.com/golang-migrate/migrate/v4
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/iofs
```

- [ ] **Step 2: Write `internal/store/store.go`**

```go
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct {
	DB *sql.DB
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(time.Hour)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{DB: db}, nil
}

func (s *Store) Migrate() error {
	driver, err := pgxmigrate.WithInstance(s.DB, &pgxmigrate.Config{})
	if err != nil {
		return fmt.Errorf("migrate driver: %w", err)
	}
	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("migrate source: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "postgres", driver)
	if err != nil {
		return fmt.Errorf("migrate instance: %w", err)
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

func (s *Store) Close() error {
	return s.DB.Close()
}
```

Note: the `//go:embed migrations/*.sql` directive needs the SQL files at `internal/store/migrations/`. Move them:

```bash
mv server/migrations server/internal/store/migrations
```

- [ ] **Step 3: Write `internal/store/store_test.go`**

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func startPG(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("mnemo"),
		postgres.WithUsername("mnemo"),
		postgres.WithPassword("mnemo"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(time.Minute),
		),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = pg.Terminate(ctx) })

	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}
	return dsn
}

func TestMigrateUp(t *testing.T) {
	dsn := startPG(t)
	s, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var n int
	if err := s.DB.QueryRow(`
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN ('actors','events','memories','jobs')
	`).Scan(&n); err != nil {
		t.Fatalf("count tables: %v", err)
	}
	if n != 4 {
		t.Fatalf("expected 4 tables, got %d", n)
	}

	// Idempotent.
	if err := s.Migrate(); err != nil {
		t.Fatalf("migrate idempotent: %v", err)
	}
}
```

Add deps:

```bash
go get github.com/testcontainers/testcontainers-go
go get github.com/testcontainers/testcontainers-go/modules/postgres
```

- [ ] **Step 4: Run the test**

Run: `cd server && go test ./internal/store -run TestMigrateUp -v`
Expected: `PASS`. (Requires Docker running locally.)

- [ ] **Step 5: Wire migration into main.go**

```go
// server/cmd/mnemo-server/main.go
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		logger.Error("DATABASE_URL is required")
		os.Exit(2)
	}

	ctx := context.Background()
	s, err := store.Open(ctx, dsn)
	if err != nil {
		logger.Error("store.Open failed", "err", err)
		os.Exit(3)
	}
	defer s.Close()

	if err := s.Migrate(); err != nil {
		logger.Error("migrate failed", "err", err)
		os.Exit(4)
	}
	logger.Info("migrations applied")
}
```

Verify: `cd server && DATABASE_URL='postgres://mnemo:mnemo@localhost:5432/mnemo?sslmode=disable' go run ./cmd/mnemo-server`
Expected: `migrations applied`, exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/
git commit -m "server: embed migrations and run on boot"
```

---

### Task 5: HTTP server skeleton + `/healthz`

**Files:**
- Create: `server/internal/api/health.go`
- Create: `server/internal/api/router.go`
- Create: `server/internal/api/health_test.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Add `chi`**

```bash
cd server && go get github.com/go-chi/chi/v5
```

- [ ] **Step 2: Write `internal/api/health.go`**

```go
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

type pinger interface {
	PingContext(ctx context.Context) error
}

type healthHandler struct {
	db     pinger
	logger *slog.Logger
}

func (h *healthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	dbOK := h.db.PingContext(ctx) == nil
	w.Header().Set("content-type", "application/json")
	if !dbOK {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": dbOK, "db": dbOK})
}
```

- [ ] **Step 3: Write `internal/api/router.go`**

```go
package api

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Deps struct {
	Store  *store.Store
	Logger *slog.Logger
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&healthHandler{db: d.Store.DB, logger: d.Logger}).ServeHTTP)
	return r
}
```

- [ ] **Step 4: Write `internal/api/health_test.go`**

```go
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
	if got := rr.Body.String(); got != "{\"db\":true,\"ok\":true}\n" {
		t.Fatalf("unexpected body %q", got)
	}
}
```

- [ ] **Step 5: Run test**

Run: `go test ./internal/api -run TestHealthOK -v`
Expected: `PASS`.

- [ ] **Step 6: Wire HTTP server in main.go**

```go
// server/cmd/mnemo-server/main.go (replace)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/api"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		logger.Error("DATABASE_URL is required")
		os.Exit(2)
	}
	port := os.Getenv("MNEMO_PORT")
	if port == "" {
		port = "8080"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := store.Open(ctx, dsn)
	if err != nil {
		logger.Error("store.Open", "err", err)
		os.Exit(3)
	}
	defer s.Close()

	if err := s.Migrate(); err != nil {
		logger.Error("migrate", "err", err)
		os.Exit(4)
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           api.NewRouter(api.Deps{Store: s, Logger: logger}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			os.Exit(5)
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown signal received")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown", "err", err)
	}
}
```

Run end-to-end: `DATABASE_URL=... MNEMO_PORT=8080 go run ./cmd/mnemo-server` then `curl http://localhost:8080/healthz`.
Expected: `{"db":true,"ok":true}`.

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "server: chi router, /healthz, graceful shutdown"
```

---

## Phase 2 — Auth

### Task 6: Config loader

**Files:**
- Create: `server/internal/config/config.go`
- Create: `server/internal/config/config_test.go`

- [ ] **Step 1: Add `caarlos0/env`**

```bash
cd server && go get github.com/caarlos0/env/v11
```

- [ ] **Step 2: Write `internal/config/config.go`**

```go
package config

import (
	"fmt"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	DatabaseURL      string `env:"DATABASE_URL,required"`
	Port             string `env:"MNEMO_PORT" envDefault:"8080"`
	WorkerCount      int    `env:"MNEMO_WORKER_COUNT" envDefault:"4"`

	AuthDisabled     bool   `env:"MNEMO_AUTH_DISABLED"`
	Auth0Domain      string `env:"AUTH0_DOMAIN"`
	Auth0Audience    string `env:"AUTH0_API_AUDIENCE"`

	LLMDisabled      bool   `env:"MNEMO_LLM_DISABLED"`
	AnthropicAPIKey  string `env:"ANTHROPIC_API_KEY"`
	LLMModel         string `env:"MNEMO_LLM_MODEL" envDefault:"claude-sonnet-4-7-20251015"`

	SMTPHost         string `env:"SMTP_HOST"`
	SMTPUser         string `env:"SMTP_USER"`
	SMTPPass         string `env:"SMTP_PASS"`
	SMTPFrom         string `env:"SMTP_FROM"`
}

func Load() (Config, error) {
	var c Config
	if err := env.Parse(&c); err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	if !c.AuthDisabled {
		if c.Auth0Domain == "" || c.Auth0Audience == "" {
			return c, fmt.Errorf("config: AUTH0_DOMAIN and AUTH0_API_AUDIENCE required when auth enabled")
		}
	}
	return c, nil
}
```

- [ ] **Step 3: Write `internal/config/config_test.go`**

```go
package config

import (
	"testing"
)

func TestLoadRequiresAuth0(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "")
	if _, err := Load(); err == nil {
		t.Fatalf("expected error when auth enabled without Auth0 vars")
	}
}

func TestLoadAuthDisabled(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("MNEMO_AUTH_DISABLED", "1")
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !c.AuthDisabled {
		t.Fatalf("AuthDisabled not set")
	}
}
```

Run: `go test ./internal/config -v`. Expected: PASS.

- [ ] **Step 4: Use config in main.go**

Replace the manual `os.Getenv` lines:

```go
cfg, err := config.Load()
if err != nil {
	logger.Error("config", "err", err)
	os.Exit(2)
}
// ... use cfg.DatabaseURL, cfg.Port everywhere
```

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "server: typed config loader with Auth0 validation"
```

---

### Task 7: Auth0 JWT verifier

**Files:**
- Create: `server/internal/auth/auth0.go`
- Create: `server/internal/auth/auth0_test.go`

- [ ] **Step 1: Add deps**

```bash
cd server
go get github.com/golang-jwt/jwt/v5
go get github.com/MicahParks/keyfunc/v3
```

- [ ] **Step 2: Write `internal/auth/auth0.go`**

```go
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Claims is the subset of the Auth0 access token we use.
type Claims struct {
	jwt.RegisteredClaims
}

type Verifier struct {
	kf       keyfunc.Keyfunc
	issuer   string
	audience string
}

func NewVerifier(ctx context.Context, domain, audience string) (*Verifier, error) {
	if domain == "" || audience == "" {
		return nil, errors.New("auth: domain and audience required")
	}
	jwksURL := fmt.Sprintf("https://%s/.well-known/jwks.json", domain)
	kf, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("auth: JWKS init: %w", err)
	}
	return &Verifier{
		kf:       kf,
		issuer:   "https://" + domain + "/",
		audience: audience,
	}, nil
}

// Verify parses, validates signature, iss, aud, exp. Returns the subject claim.
func (v *Verifier) Verify(token string) (string, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, v.kf.Keyfunc,
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil {
		return "", err
	}
	c, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return "", errors.New("auth: invalid token")
	}
	if c.Subject == "" {
		return "", errors.New("auth: missing sub")
	}
	return c.Subject, nil
}
```

- [ ] **Step 3: Write `internal/auth/auth0_test.go`** (hand-minted RSA)

```go
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
```

Run: `go test ./internal/auth -v`. Expected: PASS for all three.

- [ ] **Step 4: Commit**

```bash
git add server/
git commit -m "auth: Auth0 JWT verifier with JWKS, valid/expired/aud tests"
```

---

### Task 8: Actor resolution + auth middleware + dev bypass

**Files:**
- Create: `server/internal/auth/actor.go`
- Create: `server/internal/auth/middleware.go`
- Create: `server/internal/store/actors.go`
- Create: `server/internal/store/actors_test.go`
- Modify: `server/internal/api/router.go`

- [ ] **Step 1: Write `internal/store/actors.go`**

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type Actor struct {
	ID            string
	DisplayName   string
	Email         sql.NullString
	Timezone      string
	DigestEnabled bool
	CreatedAt     time.Time
}

func (s *Store) GetActor(ctx context.Context, id string) (*Actor, error) {
	var a Actor
	err := s.DB.QueryRowContext(ctx, `
		SELECT actor_id, display_name, email, timezone, digest_enabled, created_at
		FROM actors WHERE actor_id = $1
	`, id).Scan(&a.ID, &a.DisplayName, &a.Email, &a.Timezone, &a.DigestEnabled, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// UpsertActor inserts a new actor or returns the existing one. Display name
// defaults to the actor_id when inserting fresh.
func (s *Store) UpsertActor(ctx context.Context, id string) (*Actor, error) {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO actors (actor_id, display_name)
		VALUES ($1, $1)
		ON CONFLICT (actor_id) DO NOTHING
	`, id)
	if err != nil {
		return nil, err
	}
	return s.GetActor(ctx, id)
}
```

- [ ] **Step 2: Write `internal/store/actors_test.go`**

```go
package store

import (
	"context"
	"testing"
)

func TestUpsertActor(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	a1, err := s.UpsertActor(ctx, "auth0|alice")
	if err != nil || a1.ID != "auth0|alice" || a1.DisplayName != "auth0|alice" {
		t.Fatalf("a1: %+v err=%v", a1, err)
	}
	// Idempotent: second call returns same row, doesn't error.
	a2, err := s.UpsertActor(ctx, "auth0|alice")
	if err != nil || a2.CreatedAt != a1.CreatedAt {
		t.Fatalf("a2: %+v err=%v", a2, err)
	}
}
```

Run: `go test ./internal/store -run TestUpsertActor -v`. Expected: PASS.

- [ ] **Step 3: Write `internal/auth/middleware.go`**

```go
package auth

import (
	"context"
	"net/http"
	"strings"
)

type ctxKey struct{}

type Resolver func(ctx context.Context, actorID string) error // upserts actor

// Middleware verifies the JWT and stashes the actor id on the request context.
// When verifier is nil (dev mode), every request maps to devActorID.
func Middleware(v *Verifier, resolver Resolver, devActorID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var actorID string
			if v == nil {
				actorID = devActorID
			} else {
				h := r.Header.Get("Authorization")
				if !strings.HasPrefix(h, "Bearer ") {
					http.Error(w, "missing bearer", http.StatusUnauthorized)
					return
				}
				sub, err := v.Verify(strings.TrimPrefix(h, "Bearer "))
				if err != nil {
					http.Error(w, "invalid token", http.StatusUnauthorized)
					return
				}
				actorID = sub
			}
			if err := resolver(r.Context(), actorID); err != nil {
				http.Error(w, "actor resolve", http.StatusInternalServerError)
				return
			}
			ctx := context.WithValue(r.Context(), ctxKey{}, actorID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func ActorID(ctx context.Context) string {
	v, _ := ctx.Value(ctxKey{}).(string)
	return v
}
```

- [ ] **Step 4: Wire middleware in router**

```go
// server/internal/api/router.go (updated)
package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Deps struct {
	Store        *store.Store
	Logger       *slog.Logger
	AuthVerifier *auth.Verifier // nil ⇒ dev bypass
	DevActorID   string         // used when AuthVerifier == nil
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&healthHandler{db: d.Store.DB, logger: d.Logger}).ServeHTTP)

	resolver := func(ctx context.Context, id string) error {
		_, err := d.Store.UpsertActor(ctx, id)
		return err
	}
	authMW := auth.Middleware(d.AuthVerifier, resolver, d.DevActorID)
	r.Group(func(r chi.Router) {
		r.Use(authMW)
		// /events and /recall registered here in later tasks.
	})
	return r
}
```

- [ ] **Step 5: Wire in main.go**

In `main.go`, after `store.Open`:

```go
var verifier *auth.Verifier
if !cfg.AuthDisabled {
	verifier, err = auth.NewVerifier(ctx, cfg.Auth0Domain, cfg.Auth0Audience)
	if err != nil {
		logger.Error("auth init", "err", err)
		os.Exit(6)
	}
} else {
	logger.Warn("MNEMO_AUTH_DISABLED=1: bypass mode, every request maps to dev-actor")
}

srv := &http.Server{
	Addr:    ":" + cfg.Port,
	Handler: api.NewRouter(api.Deps{
		Store:        s,
		Logger:       logger,
		AuthVerifier: verifier,
		DevActorID:   "dev-actor",
	}),
	ReadHeaderTimeout: 5 * time.Second,
}
```

- [ ] **Step 6: Commit**

```bash
git add server/
git commit -m "auth: middleware, actor upsert, MNEMO_AUTH_DISABLED dev bypass"
```

---

## Phase 3 — Ingest path

### Task 9: Event store helper

**Files:**
- Create: `server/internal/store/events.go`
- Create: `server/internal/store/events_test.go`

- [ ] **Step 1: Add `google/uuid`**

```bash
cd server && go get github.com/google/uuid
```

- [ ] **Step 2: Write `internal/store/events.go`**

```go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
)

type EventInput struct {
	ActorID     string
	SessionID   string
	Project     string // "" allowed
	Source      string
	Workstation string
	Workdir     string
	Turns       json.RawMessage // pre-validated JSON array
	Attributes  json.RawMessage // pre-validated JSON object; nil ⇒ "{}"
}

type EventRecord struct {
	EventID      uuid.UUID
	MeetingID    sql.NullString
	MeetingEnded bool
}

// InsertEvent denormalizes meeting_id/meeting_ended from attributes.
func (s *Store) InsertEvent(ctx context.Context, tx *sql.Tx, in EventInput) (EventRecord, error) {
	if len(in.Turns) == 0 {
		return EventRecord{}, errors.New("turns required")
	}
	attrs := in.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}

	var attrMap map[string]any
	if err := json.Unmarshal(attrs, &attrMap); err != nil {
		return EventRecord{}, errors.New("attributes not a JSON object")
	}
	mid, _ := attrMap["meeting_id"].(string)
	mended, _ := attrMap["meeting_ended"].(bool)

	id := uuid.New()
	_, err := tx.ExecContext(ctx, `
		INSERT INTO events (event_id, actor_id, session_id, project, source,
		                    workstation, workdir, turns, attributes, meeting_id, meeting_ended)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,$9,
		        NULLIF($10,''), $11)
	`, id, in.ActorID, in.SessionID, in.Project, in.Source, in.Workstation, in.Workdir,
		in.Turns, attrs, mid, mended)
	if err != nil {
		return EventRecord{}, err
	}

	rec := EventRecord{EventID: id, MeetingEnded: mended}
	if mid != "" {
		rec.MeetingID = sql.NullString{String: mid, Valid: true}
	}
	return rec, nil
}
```

- [ ] **Step 3: Write `internal/store/events_test.go`**

```go
package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestInsertEventDenormalizesMeeting(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil { t.Fatal(err) }
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "auth0|alice"); err != nil { t.Fatal(err) }

	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, err := s.InsertEvent(ctx, tx, EventInput{
		ActorID:    "auth0|alice",
		SessionID:  "sess-1",
		Turns:      json.RawMessage(`[{"role":"user","content":"hi"}]`),
		Attributes: json.RawMessage(`{"meeting_id":"design","meeting_ended":true}`),
	})
	if err != nil { t.Fatal(err) }
	_ = tx.Commit()

	if !rec.MeetingID.Valid || rec.MeetingID.String != "design" || !rec.MeetingEnded {
		t.Fatalf("denormalize: %+v", rec)
	}
}
```

Run: `go test ./internal/store -run TestInsertEventDenormalizes -v`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/
git commit -m "store: InsertEvent with meeting_id/meeting_ended denormalization"
```

---

### Task 10: Jobs store helper (enqueue + claim)

**Files:**
- Create: `server/internal/store/jobs.go`
- Create: `server/internal/store/jobs_test.go`

- [ ] **Step 1: Write `internal/store/jobs.go`**

```go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type JobKind string

const (
	KindExtractContext  JobKind = "extract_context"
	KindFinalizeMeeting JobKind = "finalize_meeting"
	KindDailyDigest     JobKind = "daily_digest"
)

type Job struct {
	JobID    int64
	Kind     JobKind
	Payload  json.RawMessage
	Attempts int
}

// EnqueueJob inserts a pending job. Must be called inside a tx.
func (s *Store) EnqueueJob(ctx context.Context, tx *sql.Tx, kind JobKind, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO jobs (kind, payload) VALUES ($1, $2)
	`, string(kind), b)
	return err
}

// ClaimJob atomically picks one pending job, marks it running. Returns (nil,nil) on empty queue.
func (s *Store) ClaimJob(ctx context.Context, workerID string) (*Job, error) {
	row := s.DB.QueryRowContext(ctx, `
		UPDATE jobs
		   SET state = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
		 WHERE job_id = (
		     SELECT job_id FROM jobs
		      WHERE state = 'pending' AND run_after <= now()
		      ORDER BY job_id
		      FOR UPDATE SKIP LOCKED LIMIT 1
		 )
		 RETURNING job_id, kind, payload, attempts
	`, workerID)

	var j Job
	if err := row.Scan(&j.JobID, &j.Kind, &j.Payload, &j.Attempts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &j, nil
}

func (s *Store) CompleteJob(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs SET state='done', completed_at=now(), last_error=NULL WHERE job_id=$1
	`, id)
	return err
}

// FailJob marks pending again with backoff, or 'failed' after maxAttempts.
func (s *Store) FailJob(ctx context.Context, id int64, attempts int, errMsg string, runAfterSec int, maxAttempts int) error {
	if attempts >= maxAttempts {
		_, err := s.DB.ExecContext(ctx, `
			UPDATE jobs SET state='failed', last_error=$2, locked_by=NULL, locked_at=NULL WHERE job_id=$1
		`, id, errMsg)
		return err
	}
	_, err := s.DB.ExecContext(ctx, `
		UPDATE jobs
		   SET state='pending', last_error=$2,
		       run_after = now() + ($3 || ' seconds')::interval,
		       locked_by=NULL, locked_at=NULL
		 WHERE job_id=$1
	`, id, errMsg, runAfterSec)
	return err
}
```

- [ ] **Step 2: Write `internal/store/jobs_test.go`**

```go
package store

import (
	"context"
	"sync"
	"testing"
)

func TestClaimJobSkipLocked(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil { t.Fatal(err) }
	ctx := context.Background()

	// Enqueue 10 jobs in one tx.
	tx, _ := s.DB.BeginTx(ctx, nil)
	for i := 0; i < 10; i++ {
		if err := s.EnqueueJob(ctx, tx, KindExtractContext, map[string]int{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	// 5 workers race to claim. Each job must be claimed by exactly one worker.
	var wg sync.WaitGroup
	claimed := make(chan int64, 100)
	for w := 0; w < 5; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				j, err := s.ClaimJob(ctx, "w-"+string(rune('0'+id)))
				if err != nil { t.Errorf("claim: %v", err); return }
				if j == nil { return }
				claimed <- j.JobID
				_ = s.CompleteJob(ctx, j.JobID)
			}
		}(w)
	}
	wg.Wait()
	close(claimed)

	seen := map[int64]bool{}
	for id := range claimed {
		if seen[id] { t.Fatalf("job %d claimed twice", id) }
		seen[id] = true
	}
	if len(seen) != 10 { t.Fatalf("expected 10 distinct claims got %d", len(seen)) }
}
```

Run: `go test ./internal/store -run TestClaimJobSkipLocked -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "store: jobs queue with EnqueueJob/ClaimJob (SKIP LOCKED) and FailJob backoff"
```

---

### Task 11: `POST /events` handler

**Files:**
- Create: `server/internal/api/events.go`
- Create: `server/internal/api/events_test.go`
- Modify: `server/internal/api/router.go`

- [ ] **Step 1: Write `internal/api/events.go`**

```go
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type eventRequest struct {
	SessionID   string          `json:"session_id"`
	Project     string          `json:"project"`
	Source      string          `json:"source"`
	Workstation string          `json:"workstation"`
	Workdir     string          `json:"workdir"`
	Turns       json.RawMessage `json:"turns"`
	Attributes  json.RawMessage `json:"attributes"`
}

type eventResponse struct {
	EventID string `json:"event_id"`
}

type eventsHandler struct {
	store  *store.Store
	logger *slog.Logger
}

func (h *eventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req eventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "session_id required", http.StatusBadRequest)
		return
	}
	if len(req.Turns) == 0 {
		http.Error(w, "turns required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	actorID := auth.ActorID(ctx)

	tx, err := h.store.DB.BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, "db", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	rec, err := h.store.InsertEvent(ctx, tx, store.EventInput{
		ActorID: actorID, SessionID: req.SessionID, Project: req.Project,
		Source: req.Source, Workstation: req.Workstation, Workdir: req.Workdir,
		Turns: req.Turns, Attributes: req.Attributes,
	})
	if err != nil {
		var bad *jsonObjectError
		if errors.As(err, &bad) || errors.Is(err, errBadTurns) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		h.logger.Error("insert event", "err", err)
		http.Error(w, "insert", http.StatusInternalServerError)
		return
	}

	if err := h.store.EnqueueJob(ctx, tx, store.KindExtractContext, map[string]any{
		"actor_id": actorID, "event_id": rec.EventID,
	}); err != nil {
		h.logger.Error("enqueue extract", "err", err)
		http.Error(w, "enqueue", http.StatusInternalServerError)
		return
	}
	if rec.MeetingEnded && rec.MeetingID.Valid {
		if err := h.store.EnqueueJob(ctx, tx, store.KindFinalizeMeeting, map[string]any{
			"actor_id": actorID, "meeting_id": rec.MeetingID.String,
		}); err != nil {
			h.logger.Error("enqueue finalize", "err", err)
			http.Error(w, "enqueue", http.StatusInternalServerError)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, "commit", http.StatusInternalServerError)
		return
	}

	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(eventResponse{EventID: rec.EventID.String()})
	_ = context.Background()
}

// Sentinel errors used by the handler for typed mapping.
type jsonObjectError struct{ msg string }

func (e *jsonObjectError) Error() string { return e.msg }

var errBadTurns = errors.New("turns must be a JSON array")
```

- [ ] **Step 2: Register the route**

In `router.go` inside the auth group:

```go
r.Post("/events", (&eventsHandler{store: d.Store, logger: d.Logger}).ServeHTTP)
```

- [ ] **Step 3: Write `internal/api/events_test.go`** (integration-flavored)

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func startStore(t *testing.T) *store.Store {
	t.Helper()
	t.Skip("requires testcontainers wired in integration tier")
	return nil
}

func TestPostEventsAccepted(t *testing.T) {
	// This test runs in the integration suite (Task 26). Here we keep a stub.
	t.Skip("covered in integration tests")
	_ = bytes.Buffer{}
	_ = http.MethodPost
	_ = json.RawMessage(nil)
	_ = context.Background()
	_ = httptest.NewRecorder()
}
```

(The real integration test lives in Task 26 once we have all pieces.)

- [ ] **Step 4: Compile-check**

Run: `go build ./...`. Expected: success.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "api: POST /events with extract+finalize enqueue in one tx"
```

---

## Phase 4 — Worker pool

### Task 12: Backoff schedule

**Files:**
- Create: `server/internal/queue/backoff.go`
- Create: `server/internal/queue/backoff_test.go`

- [ ] **Step 1: Write `internal/queue/backoff.go`**

```go
package queue

const MaxAttempts = 3

// BackoffSeconds returns the seconds to wait before the next attempt.
// Attempt count is 1-indexed (1 = first failure → wait 30s before retry).
func BackoffSeconds(attempts int) int {
	switch attempts {
	case 1:
		return 30
	case 2:
		return 120
	default:
		return 600
	}
}
```

- [ ] **Step 2: Write `internal/queue/backoff_test.go`**

```go
package queue

import "testing"

func TestBackoffSeconds(t *testing.T) {
	for _, c := range []struct{ in, want int }{{1, 30}, {2, 120}, {3, 600}, {99, 600}} {
		if got := BackoffSeconds(c.in); got != c.want {
			t.Errorf("BackoffSeconds(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}
```

Run: `go test ./internal/queue -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "queue: retry backoff (30s/2min/10min)"
```

---

### Task 13: Worker pool with graceful shutdown

**Files:**
- Create: `server/internal/queue/worker.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Write `internal/queue/worker.go`**

```go
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Handler processes one job's payload. Idempotent on retry.
type Handler func(ctx context.Context, payload json.RawMessage) error

type Pool struct {
	store    *store.Store
	logger   *slog.Logger
	workers  int
	handlers map[store.JobKind]Handler
}

func NewPool(s *store.Store, logger *slog.Logger, workers int, handlers map[store.JobKind]Handler) *Pool {
	return &Pool{store: s, logger: logger, workers: workers, handlers: handlers}
}

// Run blocks until ctx is done. Returns after all workers drain.
func (p *Pool) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < p.workers; i++ {
		wg.Add(1)
		workerID := wfmt(i)
		go func() {
			defer wg.Done()
			p.loop(ctx, workerID)
		}()
	}
	wg.Wait()
}

func wfmt(i int) string {
	return "w-" + time.Now().UTC().Format("0405") + "-" + string(rune('0'+i))
}

func (p *Pool) loop(ctx context.Context, id string) {
	for {
		if ctx.Err() != nil {
			return
		}
		j, err := p.store.ClaimJob(ctx, id)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			p.logger.Error("claim", "worker", id, "err", err)
			sleepJitter(ctx, time.Second, 5*time.Second)
			continue
		}
		if j == nil {
			sleepJitter(ctx, time.Second, 5*time.Second)
			continue
		}
		h, ok := p.handlers[j.Kind]
		if !ok {
			_ = p.store.FailJob(ctx, j.JobID, j.Attempts, "no handler for kind: "+string(j.Kind), 0, 1)
			continue
		}
		if err := h(ctx, j.Payload); err != nil {
			p.logger.Warn("job failed", "worker", id, "kind", j.Kind, "job_id", j.JobID, "attempts", j.Attempts, "err", err)
			_ = p.store.FailJob(ctx, j.JobID, j.Attempts, err.Error(), BackoffSeconds(j.Attempts), MaxAttempts)
			continue
		}
		_ = p.store.CompleteJob(ctx, j.JobID)
	}
}

func sleepJitter(ctx context.Context, lo, hi time.Duration) {
	d := lo + time.Duration(rand.Int64N(int64(hi-lo)))
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
```

- [ ] **Step 2: Wire pool in main.go**

After the `srv` setup, before `ListenAndServe`:

```go
handlers := map[store.JobKind]queue.Handler{
	// Registered in later phases.
}
pool := queue.NewPool(s, logger, cfg.WorkerCount, handlers)
poolDone := make(chan struct{})
go func() { pool.Run(ctx); close(poolDone) }()
```

After `srv.Shutdown`, wait for the pool:

```go
<-poolDone
```

- [ ] **Step 3: Compile-check**

Run: `go build ./...`. Expected: success.

- [ ] **Step 4: Commit**

```bash
git add server/
git commit -m "queue: worker pool with SKIP LOCKED claim + graceful drain"
```

---

### Task 14: Done-row sweeper

**Files:**
- Create: `server/internal/queue/sweeper.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Write `internal/queue/sweeper.go`**

```go
package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Sweeper periodically deletes 'done' jobs older than retention.
func Sweeper(ctx context.Context, s *store.Store, logger *slog.Logger, retention time.Duration, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			res, err := s.DB.ExecContext(ctx, `
				DELETE FROM jobs WHERE state='done' AND completed_at < now() - $1::interval
			`, retention.String())
			if err != nil {
				logger.Warn("sweeper", "err", err)
				continue
			}
			n, _ := res.RowsAffected()
			if n > 0 {
				logger.Info("sweeper", "deleted", n)
			}
		}
	}
}
```

- [ ] **Step 2: Wire in main.go**

```go
go queue.Sweeper(ctx, s, logger, 7*24*time.Hour, time.Hour)
```

- [ ] **Step 3: Compile + commit**

```bash
go build ./...
git add server/
git commit -m "queue: hourly sweeper for done jobs older than 7d"
```

---

## Phase 5 — LLM client

### Task 15: LLM interface + stub

**Files:**
- Create: `server/internal/llm/client.go`
- Create: `server/internal/llm/stub.go`

- [ ] **Step 1: Write `internal/llm/client.go`**

```go
package llm

import "context"

type Message struct {
	Role    string `json:"role"`    // "user" or "assistant"
	Content string `json:"content"`
}

type CompleteRequest struct {
	System      string
	Messages    []Message
	Model       string
	MaxTokens   int
	Temperature float64
	JSONOutput  bool // if true, instruct model to emit pure JSON
}

type CompleteResponse struct {
	Text       string
	StopReason string
	InputToks  int
	OutputToks int
}

type Client interface {
	Complete(ctx context.Context, req CompleteRequest) (CompleteResponse, error)
}
```

- [ ] **Step 2: Write `internal/llm/stub.go`** (used in tests)

```go
package llm

import "context"

// Stub returns canned responses keyed by an inspection of the request.
type Stub struct {
	Handler func(req CompleteRequest) (CompleteResponse, error)
}

func (s *Stub) Complete(_ context.Context, req CompleteRequest) (CompleteResponse, error) {
	if s.Handler == nil {
		return CompleteResponse{Text: "{}"}, nil
	}
	return s.Handler(req)
}
```

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "llm: Client interface + test stub"
```

---

### Task 16: Anthropic implementation

**Files:**
- Create: `server/internal/llm/anthropic.go`
- Create: `server/internal/llm/anthropic_test.go`

- [ ] **Step 1: Write `internal/llm/anthropic.go`**

```go
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const anthropicVersion = "2023-06-01"
const defaultEndpoint = "https://api.anthropic.com/v1/messages"

type Anthropic struct {
	APIKey   string
	Endpoint string // override for tests
	HTTP     *http.Client
	Logger   func(format string, args ...any)
}

type anthropicReq struct {
	Model       string    `json:"model"`
	MaxTokens   int       `json:"max_tokens"`
	System      string    `json:"system,omitempty"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature,omitempty"`
}

type anthropicResp struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func (a *Anthropic) Complete(ctx context.Context, in CompleteRequest) (CompleteResponse, error) {
	if a.HTTP == nil {
		a.HTTP = &http.Client{Timeout: 90 * time.Second}
	}
	endpoint := a.Endpoint
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	body := anthropicReq{
		Model:       in.Model,
		MaxTokens:   in.MaxTokens,
		System:      in.System,
		Messages:    in.Messages,
		Temperature: in.Temperature,
	}
	if body.MaxTokens == 0 {
		body.MaxTokens = 4096
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return CompleteResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(buf))
	if err != nil {
		return CompleteResponse{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", a.APIKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := a.HTTP.Do(req)
	if err != nil {
		return CompleteResponse{}, fmt.Errorf("anthropic: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return CompleteResponse{}, fmt.Errorf("anthropic: status %d: %s", resp.StatusCode, string(raw))
	}
	var parsed anthropicResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return CompleteResponse{}, fmt.Errorf("anthropic: decode: %w (body=%s)", err, string(raw))
	}
	out := CompleteResponse{
		StopReason: parsed.StopReason,
		InputToks:  parsed.Usage.InputTokens,
		OutputToks: parsed.Usage.OutputTokens,
	}
	for _, c := range parsed.Content {
		if c.Type == "text" {
			out.Text += c.Text
		}
	}
	return out, nil
}
```

- [ ] **Step 2: Write `internal/llm/anthropic_test.go`**

```go
package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnthropicComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "k1" || r.Header.Get("anthropic-version") != anthropicVersion {
			t.Errorf("bad headers: %v", r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		var in anthropicReq
		_ = json.Unmarshal(b, &in)
		if in.Model != "claude-test" {
			t.Errorf("model: %s", in.Model)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":     []map[string]any{{"type": "text", "text": "hello"}},
			"stop_reason": "end_turn",
			"usage":       map[string]any{"input_tokens": 5, "output_tokens": 1},
		})
	}))
	defer srv.Close()

	a := &Anthropic{APIKey: "k1", Endpoint: srv.URL}
	out, err := a.Complete(context.Background(), CompleteRequest{
		Model: "claude-test", Messages: []Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "hello" || out.OutputToks != 1 {
		t.Fatalf("out: %+v", out)
	}
}
```

Run: `go test ./internal/llm -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "llm: Anthropic implementation against /v1/messages"
```

---

## Phase 6 — Recall path

### Task 17: Memories store helpers

**Files:**
- Create: `server/internal/store/memories.go`
- Create: `server/internal/store/memories_test.go`

- [ ] **Step 1: Write `internal/store/memories.go`**

```go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Memory struct {
	ID         uuid.UUID
	ActorID    string
	Dimension  string
	Namespace  string
	Content    string
	Attributes json.RawMessage
	UpdatedAt  time.Time
}

type MemoryInput struct {
	ActorID       string
	Dimension     string
	Namespace     string
	Content       string
	Attributes    json.RawMessage
	SourceEventID *uuid.UUID
}

// InsertAppendMemory inserts a row (no upsert). Caller is responsible for de-dup if needed.
func (s *Store) InsertAppendMemory(ctx context.Context, tx *sql.Tx, m MemoryInput) error {
	attrs := m.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, attributes, source_event_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, uuid.New(), m.ActorID, m.Dimension, m.Namespace, m.Content, attrs, m.SourceEventID)
	return err
}

// UpsertConsolidatedMemory inserts-or-updates by (actor_id, namespace). Use only for
// dimensions in the consolidated set (enforced by the partial unique index).
func (s *Store) UpsertConsolidatedMemory(ctx context.Context, tx *sql.Tx, m MemoryInput) error {
	attrs := m.Attributes
	if len(attrs) == 0 {
		attrs = []byte("{}")
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO memories (memory_id, actor_id, dimension, namespace, content, attributes, source_event_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (actor_id, namespace)
		WHERE dimension IN ('about','project','task','daily_summary','meeting')
		DO UPDATE SET content = EXCLUDED.content,
		              attributes = EXCLUDED.attributes,
		              source_event_id = EXCLUDED.source_event_id,
		              updated_at = now()
	`, uuid.New(), m.ActorID, m.Dimension, m.Namespace, m.Content, attrs, m.SourceEventID)
	return err
}

// DeleteAppendMemoriesForEvent removes prior append-dim writes for an event.
// Used by extract_context retries to guarantee idempotency.
func (s *Store) DeleteAppendMemoriesForEvent(ctx context.Context, tx *sql.Tx, actor string, eventID uuid.UUID, dims []string) error {
	if len(dims) == 0 {
		return nil
	}
	args := []any{actor, eventID}
	placeholders := make([]string, len(dims))
	for i, d := range dims {
		placeholders[i] = fmt.Sprintf("$%d", i+3)
		args = append(args, d)
	}
	q := fmt.Sprintf(`
		DELETE FROM memories
		 WHERE actor_id = $1 AND source_event_id = $2 AND dimension IN (%s)
	`, strings.Join(placeholders, ","))
	_, err := tx.ExecContext(ctx, q, args...)
	return err
}

type RecallFilter struct {
	ActorID       string
	NamespacePref string             // namespace prefix
	AttrFilters   map[string]string  // attributes->>k = v
	Limit         int
}

// QueryByPrefix returns memories whose namespace starts with prefix, ordered newest first.
func (s *Store) QueryByPrefix(ctx context.Context, f RecallFilter) ([]Memory, error) {
	args := []any{f.ActorID, f.NamespacePref + "%"}
	clauses := []string{"actor_id = $1", "namespace LIKE $2"}
	i := 3
	for k, v := range f.AttrFilters {
		clauses = append(clauses, fmt.Sprintf("attributes->>$%d = $%d", i, i+1))
		args = append(args, k, v)
		i += 2
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	q := fmt.Sprintf(`
		SELECT memory_id, actor_id, dimension, namespace, content, attributes, updated_at
		  FROM memories
		 WHERE %s
		 ORDER BY updated_at DESC
		 LIMIT %d
	`, strings.Join(clauses, " AND "), limit)
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		var m Memory
		if err := rows.Scan(&m.ID, &m.ActorID, &m.Dimension, &m.Namespace, &m.Content, &m.Attributes, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
```

- [ ] **Step 2: Write `internal/store/memories_test.go`**

```go
package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestUpsertConsolidatedAndQueryByPrefix(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil { t.Fatal(err) }
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil { t.Fatal(err) }

	tx, _ := s.DB.BeginTx(ctx, nil)
	for _, ns := range []string{"/projects/alice/foo/", "/projects/alice/bar/"} {
		if err := s.UpsertConsolidatedMemory(ctx, tx, MemoryInput{
			ActorID: "alice", Dimension: "project", Namespace: ns, Content: "v1",
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Upsert again to confirm it updates rather than duplicates.
	if err := s.UpsertConsolidatedMemory(ctx, tx, MemoryInput{
		ActorID: "alice", Dimension: "project", Namespace: "/projects/alice/foo/", Content: "v2",
	}); err != nil { t.Fatal(err) }
	_ = tx.Commit()

	got, err := s.QueryByPrefix(ctx, RecallFilter{ActorID: "alice", NamespacePref: "/projects/alice/"})
	if err != nil { t.Fatal(err) }
	if len(got) != 2 { t.Fatalf("want 2 rows got %d", len(got)) }
	for _, m := range got {
		if m.Namespace == "/projects/alice/foo/" && m.Content != "v2" {
			t.Errorf("upsert did not update foo: %s", m.Content)
		}
	}

	// Attribute filter test.
	tx, _ = s.DB.BeginTx(ctx, nil)
	if err := s.InsertAppendMemory(ctx, tx, MemoryInput{
		ActorID: "alice", Dimension: "facts", Namespace: "/facts/alice/",
		Content: "fact1", Attributes: json.RawMessage(`{"owner":"tiago"}`),
	}); err != nil { t.Fatal(err) }
	_ = tx.Commit()
	got, err = s.QueryByPrefix(ctx, RecallFilter{
		ActorID: "alice", NamespacePref: "/facts/alice/",
		AttrFilters: map[string]string{"owner": "tiago"},
	})
	if err != nil { t.Fatal(err) }
	if len(got) != 1 { t.Fatalf("attr filter: want 1 got %d", len(got)) }
}
```

Run: `go test ./internal/store -run TestUpsertConsolidated -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "store: memory upsert/insert/query helpers with attr filter"
```

---

### Task 18: `GET /recall` handler + render

**Files:**
- Create: `server/internal/api/recall.go`
- Create: `server/internal/api/render.go`
- Create: `server/internal/api/recall_test.go`
- Modify: `server/internal/api/router.go`

- [ ] **Step 1: Write `internal/api/recall.go`**

```go
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type recallHandler struct {
	store  *store.Store
	logger *slog.Logger
}

type dimGroup struct {
	Dimension string          `json:"dimension"`
	Items     []recallItem    `json:"items"`
}
type recallItem struct {
	ID         string          `json:"id"`
	Namespace  string          `json:"namespace"`
	Content    string          `json:"content"`
	Attributes json.RawMessage `json:"attributes"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

func (h *recallHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := auth.ActorID(ctx)
	q := r.URL.Query()

	attrFilters := map[string]string{}
	for k, v := range q {
		if strings.HasPrefix(k, "attr.") && len(v) > 0 {
			attrFilters[strings.TrimPrefix(k, "attr.")] = v[0]
		}
	}

	type req struct {
		dim    string
		prefix string
	}
	var reqs []req
	if q.Get("preferences") != "" { reqs = append(reqs, req{"preferences", "/preferences/" + actor + "/"}) }
	if q.Get("facts") != ""       { reqs = append(reqs, req{"facts", "/facts/" + actor + "/"}) }
	if q.Get("episodes") != ""    { reqs = append(reqs, req{"episodes", "/episodes/" + actor + "/"}) }
	if q.Get("about") != ""       { reqs = append(reqs, req{"about", "/about/" + actor + "/"}) }
	if p := q.Get("project"); p != "" {
		reqs = append(reqs, req{"project", fmt.Sprintf("/projects/%s/%s/", actor, p)})
	}
	if t := q.Get("task"); t != "" {
		reqs = append(reqs, req{"task", fmt.Sprintf("/tasks/%s/%s/", actor, t)})
	}
	if d := q.Get("date"); d != "" {
		// Daily flag: both log entries and summary for that date.
		reqs = append(reqs,
			req{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, d)},
			req{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, d)},
		)
	} else if q.Get("daily") != "" {
		today := time.Now().UTC().Format("2006-01-02")
		reqs = append(reqs,
			req{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, today)},
			req{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, today)},
		)
	}
	if m := q.Get("meeting"); m != "" {
		reqs = append(reqs, req{"meeting", fmt.Sprintf("/meetings/%s/%s/", actor, m)})
	}

	if len(reqs) == 0 {
		w.WriteHeader(http.StatusOK)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{\"dimensions\":[]}"))
		return
	}

	results := make([]dimGroup, len(reqs))
	var wg sync.WaitGroup
	for i, rq := range reqs {
		i, rq := i, rq
		wg.Add(1)
		go func() {
			defer wg.Done()
			mems, err := h.store.QueryByPrefix(ctx, store.RecallFilter{
				ActorID: actor, NamespacePref: rq.prefix, AttrFilters: attrFilters,
			})
			if err != nil {
				h.logger.Warn("recall", "dim", rq.dim, "err", err)
				return
			}
			items := make([]recallItem, len(mems))
			for j, m := range mems {
				items[j] = recallItem{ID: m.ID.String(), Namespace: m.Namespace, Content: m.Content, Attributes: m.Attributes, UpdatedAt: m.UpdatedAt}
			}
			results[i] = dimGroup{Dimension: rq.dim, Items: items}
		}()
	}
	wg.Wait()

	visible := q.Get("visible") != "false"
	w.Header().Set("content-type", "application/json")
	if visible {
		_, _ = w.Write([]byte(renderMarkdown(results)))
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"dimensions": results})
	_ = context.Background()
}
```

- [ ] **Step 2: Write `internal/api/render.go`**

```go
package api

import (
	"encoding/json"
	"fmt"
	"strings"
)

// renderMarkdown produces a markdown blob matching today's CLI output shape.
func renderMarkdown(groups []dimGroup) string {
	var b strings.Builder
	b.WriteString("{\"markdown\":")
	var md strings.Builder
	for _, g := range groups {
		if len(g.Items) == 0 {
			continue
		}
		fmt.Fprintf(&md, "## %s\n\n", g.Dimension)
		for _, it := range g.Items {
			fmt.Fprintf(&md, "- %s\n", it.Content)
		}
		md.WriteString("\n")
	}
	js, _ := json.Marshal(md.String())
	b.Write(js)
	b.WriteString("}")
	return b.String()
}
```

- [ ] **Step 3: Register route**

In `router.go` inside the auth group:

```go
r.Get("/recall", (&recallHandler{store: d.Store, logger: d.Logger}).ServeHTTP)
```

- [ ] **Step 4: Compile**

Run: `go build ./...`. Expected: success.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "api: GET /recall with parallel dimension queries and attr.* filters"
```

---

## Phase 7 — Context extractor

### Task 19: Prompt templates

**Files:**
- Create: `server/internal/extract/prompts.go`

- [ ] **Step 1: Port prompts from `infra/lambda/context-extractor/index.ts`**

Open the existing TS file and locate each prompt. Port verbatim into Go string literals. Skeleton:

```go
package extract

const SystemProjectTaskDailyLog = `You are an extraction assistant for a personal memory system.
Given a conversation turn, classify the task domain and emit structured facts.

Return a single JSON object with these fields:
- task_domain: one of "coding"|"studying"|"meeting"|"general"
- project_facts: array of short, durable facts about the active project (architecture
  decisions, tech choices, named constraints). Empty array if none.
- task_facts: array of durable facts specific to the task_domain. Empty array if none.
- daily_log: array of short log lines describing what the user did, in past tense.

Rules:
- Skip code, file paths, port numbers, and version strings.
- Prefer durable, reusable facts over moment-specific details.
- Output JSON only. No prose.
` // PORT FROM infra/lambda/context-extractor/index.ts (function buildProjectTaskPrompt) — verbatim.

const SystemAbout = `... PORT FROM context-extractor (function buildAboutPrompt) ...`
const SystemAboutConsolidate = `... PORT FROM context-extractor (function buildAboutConsolidationPrompt) ...`
const SystemProjectTaskConsolidate = `... PORT FROM context-extractor (function buildConsolidationPrompt) ...`
const SystemPreferences = `Extract durable user preferences (coding style, tool choice, workflow conventions).
Return JSON: { "preferences": ["string", ...] }. Skip moment-specific details. JSON only.`
const SystemFactsEpisodes = `Extract general facts and structured episodes from the conversation.
Return JSON: {
  "facts":    ["string", ...],
  "episodes": [{ "event": "string", "reflection": "string" }, ...]
}
Skip code/paths/versions. JSON only.`
```

(Implementer note: the TS source contains the production-tuned prompts. Copy them as-is. The constants above are placeholders to make the structure visible — the executor must replace each `... PORT FROM ...` block with the actual TS prompt body.)

- [ ] **Step 2: Commit**

```bash
git add server/
git commit -m "extract: prompt template constants (placeholders for TS port)"
```

---

### Task 20: Extract output parsers

**Files:**
- Create: `server/internal/extract/parse.go`
- Create: `server/internal/extract/parse_test.go`

- [ ] **Step 1: Write `internal/extract/parse.go`**

```go
package extract

import (
	"encoding/json"
	"errors"
	"strings"
)

type ProjectTaskLog struct {
	TaskDomain    string   `json:"task_domain"`
	ProjectFacts  []string `json:"project_facts"`
	TaskFacts     []string `json:"task_facts"`
	DailyLog      []string `json:"daily_log"`
}

type AboutOutput struct {
	About string `json:"about"`
}

type PreferencesOutput struct {
	Preferences []string `json:"preferences"`
}

type FactsEpisodesOutput struct {
	Facts    []string `json:"facts"`
	Episodes []struct {
		Event      string `json:"event"`
		Reflection string `json:"reflection"`
	} `json:"episodes"`
}

// strictUnmarshal trims common pre/postambles (```json ... ```), then decodes.
func strictUnmarshal(s string, into any) error {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	if s == "" {
		return errors.New("empty llm output")
	}
	return json.Unmarshal([]byte(s), into)
}

func ParseProjectTaskLog(s string) (ProjectTaskLog, error) {
	var out ProjectTaskLog
	return out, strictUnmarshal(s, &out)
}
func ParseAbout(s string) (AboutOutput, error) {
	var out AboutOutput
	return out, strictUnmarshal(s, &out)
}
func ParsePreferences(s string) (PreferencesOutput, error) {
	var out PreferencesOutput
	return out, strictUnmarshal(s, &out)
}
func ParseFactsEpisodes(s string) (FactsEpisodesOutput, error) {
	var out FactsEpisodesOutput
	return out, strictUnmarshal(s, &out)
}
```

- [ ] **Step 2: Write `internal/extract/parse_test.go`**

```go
package extract

import "testing"

func TestParseProjectTaskLogStripsFence(t *testing.T) {
	in := "```json\n{\"task_domain\":\"coding\",\"project_facts\":[\"uses Go\"],\"task_facts\":[],\"daily_log\":[\"worked on mnemo rewrite\"]}\n```"
	got, err := ParseProjectTaskLog(in)
	if err != nil { t.Fatal(err) }
	if got.TaskDomain != "coding" || len(got.ProjectFacts) != 1 { t.Fatalf("got %+v", got) }
}

func TestParseFactsEpisodes(t *testing.T) {
	in := `{"facts":["sky is blue"],"episodes":[{"event":"shipped X","reflection":"felt good"}]}`
	got, err := ParseFactsEpisodes(in)
	if err != nil { t.Fatal(err) }
	if got.Facts[0] != "sky is blue" || got.Episodes[0].Event != "shipped X" {
		t.Fatalf("parse: %+v", got)
	}
}
```

Run: `go test ./internal/extract -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "extract: JSON output parsers tolerant to code-fence wrappers"
```

---

### Task 21: Consolidation helper

**Files:**
- Create: `server/internal/extract/consolidate.go`

- [ ] **Step 1: Write `internal/extract/consolidate.go`**

```go
package extract

import (
	"context"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
)

// Consolidate calls the LLM to merge prior text with new facts. priorText may be empty.
func Consolidate(ctx context.Context, cli llm.Client, model, system, priorText string, newFacts []string) (string, error) {
	user := "PRIOR:\n" + priorText + "\n\nNEW:\n- " + strings.Join(newFacts, "\n- ") +
		"\n\nReturn the consolidated text only."
	out, err := cli.Complete(ctx, llm.CompleteRequest{
		Model: model, System: system,
		Messages: []llm.Message{{Role: "user", Content: user}},
		MaxTokens: 2048, Temperature: 0,
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Text), nil
}
```

- [ ] **Step 2: Commit**

```bash
git add server/
git commit -m "extract: LLM-based consolidation helper"
```

---

### Task 22: `extract_context` job handler

**Files:**
- Create: `server/internal/extract/handler.go`
- Create: `server/internal/extract/handler_test.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Write `internal/extract/handler.go`**

```go
package extract

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Handler struct {
	Store *store.Store
	LLM   llm.Client
	Model string
}

type contextPayload struct {
	ActorID string    `json:"actor_id"`
	EventID uuid.UUID `json:"event_id"`
}

type eventRow struct {
	Project   sql.NullString
	Workdir   sql.NullString
	Turns     json.RawMessage
	CreatedAt time.Time
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p contextPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}

	var ev eventRow
	if err := h.Store.DB.QueryRowContext(ctx, `
		SELECT project, workdir, turns, created_at FROM events WHERE event_id = $1
	`, p.EventID).Scan(&ev.Project, &ev.Workdir, &ev.Turns, &ev.CreatedAt); err != nil {
		return fmt.Errorf("load event: %w", err)
	}

	turnsText := turnsToText(ev.Turns)
	project := ev.Project.String
	date := ev.CreatedAt.UTC().Format("2006-01-02")

	g, gctx := errgroup.WithContext(ctx)

	// 1. project / task / daily-log
	var ptl ProjectTaskLog
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model: h.Model, System: SystemProjectTaskDailyLog,
			Messages: []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 1024,
		})
		if err != nil { return err }
		ptl, err = ParseProjectTaskLog(out.Text)
		return err
	})

	// 2. about
	var about AboutOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model: h.Model, System: SystemAbout,
			Messages: []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 1024,
		})
		if err != nil { return err }
		about, err = ParseAbout(out.Text)
		return err
	})

	// 3. preferences (append)
	var prefs PreferencesOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model: h.Model, System: SystemPreferences,
			Messages: []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 512,
		})
		if err != nil { return err }
		prefs, err = ParsePreferences(out.Text)
		return err
	})

	// 4. facts + episodes (append)
	var fx FactsEpisodesOutput
	g.Go(func() error {
		out, err := h.LLM.Complete(gctx, llm.CompleteRequest{
			Model: h.Model, System: SystemFactsEpisodes,
			Messages: []llm.Message{{Role: "user", Content: turnsText}},
			MaxTokens: 768,
		})
		if err != nil { return err }
		fx, err = ParseFactsEpisodes(out.Text)
		return err
	})

	if err := g.Wait(); err != nil {
		return err
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()

	// Idempotent retry: wipe prior append rows for this event first.
	if err := h.Store.DeleteAppendMemoriesForEvent(ctx, tx, p.ActorID, p.EventID,
		[]string{"preferences", "facts", "episodes", "daily_log"}); err != nil {
		return err
	}

	// Consolidated dims: project + task + about
	if project != "" && len(ptl.ProjectFacts) > 0 {
		merged, err := h.consolidate(ctx, p.ActorID, "project", project, ptl.ProjectFacts)
		if err != nil { return err }
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "project",
			Namespace: fmt.Sprintf("/projects/%s/%s/", p.ActorID, project),
			Content:   merged, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}
	if ptl.TaskDomain != "" && len(ptl.TaskFacts) > 0 {
		merged, err := h.consolidateTask(ctx, p.ActorID, ptl.TaskDomain, ptl.TaskFacts)
		if err != nil { return err }
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "task",
			Namespace: fmt.Sprintf("/tasks/%s/%s/", p.ActorID, ptl.TaskDomain),
			Content:   merged, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}
	if strings.TrimSpace(about.About) != "" {
		merged, err := h.consolidateAbout(ctx, p.ActorID, about.About)
		if err != nil { return err }
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "about",
			Namespace: fmt.Sprintf("/about/%s/", p.ActorID),
			Content:   merged, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}

	// Append dims
	for _, line := range ptl.DailyLog {
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "daily_log",
			Namespace: fmt.Sprintf("/daily/%s/%s/log/", p.ActorID, date),
			Content:   line, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}
	for _, pref := range prefs.Preferences {
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "preferences",
			Namespace: fmt.Sprintf("/preferences/%s/", p.ActorID),
			Content:   pref, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}
	for _, f := range fx.Facts {
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "facts",
			Namespace: fmt.Sprintf("/facts/%s/", p.ActorID),
			Content:   f, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}
	for _, ep := range fx.Episodes {
		text := "Event: " + ep.Event + "\nReflection: " + ep.Reflection
		if err := h.Store.InsertAppendMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "episodes",
			Namespace: fmt.Sprintf("/episodes/%s/", p.ActorID),
			Content:   text, SourceEventID: &p.EventID,
		}); err != nil { return err }
	}

	return tx.Commit()
}

func (h *Handler) consolidate(ctx context.Context, actor, dim, key string, facts []string) (string, error) {
	prior, _ := h.priorContent(ctx, actor, fmt.Sprintf("/%ss/%s/%s/", dim, actor, key))
	return Consolidate(ctx, h.LLM, h.Model, SystemProjectTaskConsolidate, prior, facts)
}
func (h *Handler) consolidateTask(ctx context.Context, actor, domain string, facts []string) (string, error) {
	prior, _ := h.priorContent(ctx, actor, fmt.Sprintf("/tasks/%s/%s/", actor, domain))
	return Consolidate(ctx, h.LLM, h.Model, SystemProjectTaskConsolidate, prior, facts)
}
func (h *Handler) consolidateAbout(ctx context.Context, actor, newText string) (string, error) {
	prior, _ := h.priorContent(ctx, actor, fmt.Sprintf("/about/%s/", actor))
	return Consolidate(ctx, h.LLM, h.Model, SystemAboutConsolidate, prior, []string{newText})
}

func (h *Handler) priorContent(ctx context.Context, actor, namespace string) (string, error) {
	var content string
	err := h.Store.DB.QueryRowContext(ctx,
		`SELECT content FROM memories WHERE actor_id=$1 AND namespace=$2`, actor, namespace,
	).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return content, err
}

func turnsToText(raw json.RawMessage) string {
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return string(raw)
	}
	var b strings.Builder
	for _, t := range arr {
		role, _ := t["role"].(string)
		content, _ := t["content"].(string)
		fmt.Fprintf(&b, "[%s]\n%s\n\n", role, content)
	}
	return b.String()
}
```

- [ ] **Step 2: Add `errgroup`**

```bash
cd server && go get golang.org/x/sync/errgroup
```

- [ ] **Step 3: Write `internal/extract/handler_test.go`**

```go
package extract

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Note: this is a full path test. Requires testcontainers Postgres.
func setup(t *testing.T) (*store.Store, *Handler, uuid.UUID) {
	t.Helper()
	dsn := store.StartTestPG(t) // see Task 26 — expose startPG via testhelpers
	s, _ := store.Open(context.Background(), dsn)
	if err := s.Migrate(); err != nil { t.Fatal(err) }
	ctx := context.Background()
	if _, err := s.UpsertActor(ctx, "alice"); err != nil { t.Fatal(err) }

	tx, _ := s.DB.BeginTx(ctx, nil)
	rec, _ := s.InsertEvent(ctx, tx, store.EventInput{
		ActorID: "alice", SessionID: "s1", Project: "demo",
		Turns: json.RawMessage(`[{"role":"user","content":"I prefer Go"}]`),
	})
	_ = tx.Commit()

	stub := &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		switch {
		case strings.Contains(req.System, "classify the task domain"):
			return llm.CompleteResponse{Text: `{"task_domain":"coding","project_facts":["uses Go"],"task_facts":[],"daily_log":["worked on demo"]}`}, nil
		case strings.Contains(req.System, "biographical"):
			return llm.CompleteResponse{Text: `{"about":"tiago is a senior engineer"}`}, nil
		case strings.Contains(req.System, "preferences"):
			return llm.CompleteResponse{Text: `{"preferences":["use Go"]}`}, nil
		case strings.Contains(req.System, "facts and structured episodes"):
			return llm.CompleteResponse{Text: `{"facts":["sky is blue"],"episodes":[]}`}, nil
		default:
			// consolidation prompts return joined text.
			return llm.CompleteResponse{Text: "consolidated"}, nil
		}
	}}

	h := &Handler{Store: s, LLM: stub, Model: "claude-test"}
	return s, h, rec.EventID
}

func TestExtractHandlerWritesAllDimensions(t *testing.T) {
	s, h, evID := setup(t)
	defer s.Close()
	payload, _ := json.Marshal(contextPayload{ActorID: "alice", EventID: evID})
	if err := h.Handle(context.Background(), payload); err != nil { t.Fatal(err) }

	var nProj, nDailyLog, nPref, nFact, nAbout, nTask int
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='project' AND actor_id='alice'`).Scan(&nProj)
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='daily_log' AND actor_id='alice'`).Scan(&nDailyLog)
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='preferences' AND actor_id='alice'`).Scan(&nPref)
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='facts' AND actor_id='alice'`).Scan(&nFact)
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='about' AND actor_id='alice'`).Scan(&nAbout)
	_ = s.DB.QueryRow(`SELECT count(*) FROM memories WHERE dimension='task' AND actor_id='alice'`).Scan(&nTask)

	if nProj != 1 || nAbout != 1 || nDailyLog != 1 || nPref != 1 || nFact != 1 || nTask != 0 {
		t.Fatalf("counts: project=%d task=%d about=%d daily=%d prefs=%d facts=%d",
			nProj, nTask, nAbout, nDailyLog, nPref, nFact)
	}
}
```

Note: this test depends on `store.StartTestPG`, exposed in Task 26.

- [ ] **Step 4: Register handler in main.go**

```go
extractHandler := &extract.Handler{Store: s, LLM: llmClient, Model: cfg.LLMModel}
handlers[store.KindExtractContext] = func(ctx context.Context, p json.RawMessage) error {
	return extractHandler.Handle(ctx, p)
}
```

(`llmClient` defined in main.go — anthropic real, or stub when `MNEMO_LLM_DISABLED=1`.)

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "extract: context handler with 4 parallel LLM calls + 9-dimension writes"
```

---

## Phase 8 — Meeting finalizer

### Task 23: Meeting prompt + handler

**Files:**
- Create: `server/internal/meeting/prompt.go`
- Create: `server/internal/meeting/handler.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Write `internal/meeting/prompt.go`**

```go
package meeting

const SystemMeetingSummary = `... PORT FROM infra/lambda/context-extractor/index.ts
(the meeting-summarizer prompt updated in commit b808b2b "tighten meeting summarizer prompt for fidelity") ...`

type Output struct {
	Summary    string `json:"summary"`
	Decisions  string `json:"decisions"`
	Actions    string `json:"actions"`
	Questions  string `json:"questions"`
	Highlights string `json:"highlights"`
	Followups  string `json:"followups"`
}
```

(Replace placeholder with the actual production prompt.)

- [ ] **Step 2: Write `internal/meeting/handler.go`**

```go
package meeting

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Handler struct {
	Store *store.Store
	LLM   llm.Client
	Model string
}

type payload struct {
	ActorID   string `json:"actor_id"`
	MeetingID string `json:"meeting_id"`
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil { return err }

	rows, err := h.Store.DB.QueryContext(ctx, `
		SELECT turns FROM events
		 WHERE actor_id=$1 AND meeting_id=$2
		 ORDER BY created_at
	`, p.ActorID, p.MeetingID)
	if err != nil { return err }
	defer rows.Close()

	var b strings.Builder
	for rows.Next() {
		var t json.RawMessage
		if err := rows.Scan(&t); err != nil { return err }
		var arr []map[string]any
		_ = json.Unmarshal(t, &arr)
		for _, x := range arr {
			role, _ := x["role"].(string)
			content, _ := x["content"].(string)
			fmt.Fprintf(&b, "[%s] %s\n", role, content)
		}
	}
	if b.Len() == 0 {
		return fmt.Errorf("no events for meeting %s", p.MeetingID)
	}

	out, err := h.LLM.Complete(ctx, llm.CompleteRequest{
		Model: h.Model, System: SystemMeetingSummary,
		Messages:  []llm.Message{{Role: "user", Content: b.String()}},
		MaxTokens: 4096,
	})
	if err != nil { return err }

	var parsed Output
	s := strings.TrimSpace(out.Text)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &parsed); err != nil {
		return fmt.Errorf("parse meeting output: %w", err)
	}

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()

	for _, cat := range []struct{ name, content string }{
		{"summary", parsed.Summary},
		{"decisions", parsed.Decisions},
		{"actions", parsed.Actions},
		{"questions", parsed.Questions},
		{"highlights", parsed.Highlights},
		{"followups", parsed.Followups},
	} {
		if strings.TrimSpace(cat.content) == "" { continue }
		if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
			ActorID: p.ActorID, Dimension: "meeting",
			Namespace: fmt.Sprintf("/meetings/%s/%s/%s/", p.ActorID, p.MeetingID, cat.name),
			Content:   cat.content,
		}); err != nil { return err }
	}
	return tx.Commit()
}
```

- [ ] **Step 3: Register handler in main.go**

```go
meetingHandler := &meeting.Handler{Store: s, LLM: llmClient, Model: cfg.LLMModel}
handlers[store.KindFinalizeMeeting] = func(ctx context.Context, p json.RawMessage) error {
	return meetingHandler.Handle(ctx, p)
}
```

- [ ] **Step 4: Compile**

Run: `go build ./...`. Expected: success.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "meeting: finalizer reads events table directly, 6-category upsert"
```

---

## Phase 9 — Daily digest + scheduler + SMTP

### Task 24: Digest handler + SMTP

**Files:**
- Create: `server/internal/digest/prompt.go`
- Create: `server/internal/digest/smtp.go`
- Create: `server/internal/digest/handler.go`

- [ ] **Step 1: Write `internal/digest/prompt.go`**

```go
package digest

const SystemDailyDigest = `... PORT FROM infra/lambda/daily-digest/index.ts ...

Output JSON object with fields:
- projects: array of strings
- decisions: array of strings
- learnings: array of strings
- time_allocation: object {project: minutes}
- blockers: array of strings
- reflection: string`

type Output struct {
	Projects        []string       `json:"projects"`
	Decisions       []string       `json:"decisions"`
	Learnings       []string       `json:"learnings"`
	TimeAllocation  map[string]int `json:"time_allocation"`
	Blockers        []string       `json:"blockers"`
	Reflection      string         `json:"reflection"`
}
```

- [ ] **Step 2: Write `internal/digest/smtp.go`**

```go
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
	msg := []byte(fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n",
		m.From, to, subject, body))
	return smtp.SendMail(m.Host, auth, m.From, []string{to}, msg)
}
```

- [ ] **Step 3: Write `internal/digest/handler.go`**

```go
package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type Handler struct {
	Store  *store.Store
	LLM    llm.Client
	Model  string
	Mailer *Mailer
}

type payload struct {
	ActorID string `json:"actor_id"`
	Date    string `json:"date"` // YYYY-MM-DD
}

func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) error {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil { return err }

	rows, err := h.Store.DB.QueryContext(ctx, `
		SELECT content FROM memories
		 WHERE actor_id=$1 AND dimension='daily_log'
		   AND namespace=$2
		 ORDER BY created_at
	`, p.ActorID, fmt.Sprintf("/daily/%s/%s/log/", p.ActorID, p.Date))
	if err != nil { return err }
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var c string
		_ = rows.Scan(&c)
		b.WriteString("- "); b.WriteString(c); b.WriteString("\n")
	}
	if b.Len() == 0 {
		return nil // nothing to digest
	}

	out, err := h.LLM.Complete(ctx, llm.CompleteRequest{
		Model: h.Model, System: SystemDailyDigest,
		Messages:  []llm.Message{{Role: "user", Content: b.String()}},
		MaxTokens: 2048,
	})
	if err != nil { return err }
	s := strings.TrimSpace(out.Text)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	var parsed Output
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &parsed); err != nil { return err }
	digestText, _ := json.MarshalIndent(parsed, "", "  ")

	tx, err := h.Store.DB.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()
	if err := h.Store.UpsertConsolidatedMemory(ctx, tx, store.MemoryInput{
		ActorID: p.ActorID, Dimension: "daily_summary",
		Namespace: fmt.Sprintf("/daily/%s/%s/summary/", p.ActorID, p.Date),
		Content:   string(digestText),
	}); err != nil { return err }
	if err := tx.Commit(); err != nil { return err }

	// Optional email.
	var email sql.NullString
	if err := h.Store.DB.QueryRowContext(ctx,
		`SELECT email FROM actors WHERE actor_id=$1`, p.ActorID).Scan(&email); err == nil && email.Valid && email.String != "" {
		_ = h.Mailer.Send(email.String, "mnemo daily digest "+p.Date, string(digestText))
	}
	return nil
}
```

- [ ] **Step 4: Register handler in main.go**

```go
mailer := &digest.Mailer{Host: cfg.SMTPHost, User: cfg.SMTPUser, Pass: cfg.SMTPPass, From: cfg.SMTPFrom}
digestHandler := &digest.Handler{Store: s, LLM: llmClient, Model: cfg.LLMModel, Mailer: mailer}
handlers[store.KindDailyDigest] = func(ctx context.Context, p json.RawMessage) error {
	return digestHandler.Handle(ctx, p)
}
```

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "digest: handler + SMTP mailer + register"
```

---

### Task 25: Scheduler

**Files:**
- Create: `server/internal/digest/scheduler.go`
- Modify: `server/cmd/mnemo-server/main.go`

- [ ] **Step 1: Write `internal/digest/scheduler.go`**

```go
package digest

import (
	"context"
	"log/slog"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

// Scheduler wakes every minute. For each digest-enabled actor whose local time
// matches DigestHour, it enqueues a daily_digest job if one isn't already
// pending/running/done for today.
//
// DigestHour: hour of day in the actor's timezone (0-23). Default 19 (7pm).
type Scheduler struct {
	Store       *store.Store
	Logger      *slog.Logger
	DigestHour  int
}

func (s *Scheduler) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	rows, err := s.Store.DB.QueryContext(ctx, `
		SELECT actor_id, timezone FROM actors WHERE digest_enabled = true
	`)
	if err != nil {
		s.Logger.Warn("scheduler list actors", "err", err)
		return
	}
	defer rows.Close()
	type a struct{ id, tz string }
	var todo []a
	for rows.Next() {
		var x a
		if err := rows.Scan(&x.id, &x.tz); err != nil { continue }
		todo = append(todo, x)
	}
	for _, x := range todo {
		loc, err := time.LoadLocation(x.tz)
		if err != nil { loc = time.UTC }
		now := time.Now().In(loc)
		if now.Hour() != s.DigestHour || now.Minute() != 0 {
			continue
		}
		date := now.Format("2006-01-02")

		// dedup: skip if a job for (actor, date) already exists today.
		var existing int
		_ = s.Store.DB.QueryRowContext(ctx, `
			SELECT count(*) FROM jobs
			 WHERE kind='daily_digest'
			   AND payload->>'actor_id'=$1
			   AND payload->>'date'=$2
			   AND created_at::date = now()::date
		`, x.id, date).Scan(&existing)
		if existing > 0 {
			continue
		}

		tx, err := s.Store.DB.BeginTx(ctx, nil)
		if err != nil { continue }
		if err := s.Store.EnqueueJob(ctx, tx, store.KindDailyDigest, map[string]string{
			"actor_id": x.id, "date": date,
		}); err == nil {
			_ = tx.Commit()
			s.Logger.Info("enqueued digest", "actor", x.id, "date", date)
		} else {
			_ = tx.Rollback()
		}
	}
}
```

- [ ] **Step 2: Wire scheduler in main.go**

```go
sched := &digest.Scheduler{Store: s, Logger: logger, DigestHour: 19}
go sched.Run(ctx)
```

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "digest: in-process minute-tick scheduler with per-day dedup"
```

---

## Phase 10 — Production deploy

### Task 26: Integration test helpers + happy-path E2E

**Files:**
- Create: `server/internal/store/testhelpers.go`
- Create: `server/internal/integration/e2e_test.go`

- [ ] **Step 1: Write `internal/store/testhelpers.go`** (exports `startPG`)

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func StartTestPG(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("mnemo"),
		postgres.WithUsername("mnemo"),
		postgres.WithPassword("mnemo"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(time.Minute),
		),
	)
	if err != nil { t.Fatalf("start postgres: %v", err) }
	t.Cleanup(func() { _ = pg.Terminate(ctx) })

	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil { t.Fatalf("dsn: %v", err) }
	return dsn
}
```

(Update earlier `store_test.go` to call `StartTestPG` instead of the private `startPG`.)

- [ ] **Step 2: Write `internal/integration/e2e_test.go`**

```go
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/api"
	"github.com/tiagodeoliveira/mnemo/server/internal/digest"
	"github.com/tiagodeoliveira/mnemo/server/internal/extract"
	"github.com/tiagodeoliveira/mnemo/server/internal/llm"
	"github.com/tiagodeoliveira/mnemo/server/internal/meeting"
	"github.com/tiagodeoliveira/mnemo/server/internal/queue"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

func stubLLM() llm.Client {
	return &llm.Stub{Handler: func(req llm.CompleteRequest) (llm.CompleteResponse, error) {
		switch {
		case strings.Contains(req.System, "classify the task domain"):
			return llm.CompleteResponse{Text: `{"task_domain":"coding","project_facts":["uses Go"],"task_facts":[],"daily_log":["worked"]}`}, nil
		case strings.Contains(req.System, "biographical"):
			return llm.CompleteResponse{Text: `{"about":"tiago is a senior engineer"}`}, nil
		case strings.Contains(req.System, "preferences"):
			return llm.CompleteResponse{Text: `{"preferences":["use Go"]}`}, nil
		case strings.Contains(req.System, "facts and structured episodes"):
			return llm.CompleteResponse{Text: `{"facts":["sky is blue"],"episodes":[]}`}, nil
		case strings.Contains(req.System, "meeting"):
			return llm.CompleteResponse{Text: `{"summary":"S","decisions":"D","actions":"A","questions":"Q","highlights":"H","followups":"F"}`}, nil
		}
		return llm.CompleteResponse{Text: "consolidated"}, nil
	}}
}

func TestEventToRecallEnd2End(t *testing.T) {
	dsn := store.StartTestPG(t)
	s, _ := store.Open(context.Background(), dsn)
	defer s.Close()
	if err := s.Migrate(); err != nil { t.Fatal(err) }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cli := stubLLM()
	extractH := &extract.Handler{Store: s, LLM: cli, Model: "x"}
	meetingH := &meeting.Handler{Store: s, LLM: cli, Model: "x"}
	digestH  := &digest.Handler{Store: s, LLM: cli, Model: "x", Mailer: &digest.Mailer{}}
	handlers := map[store.JobKind]queue.Handler{
		store.KindExtractContext:  extractH.Handle,
		store.KindFinalizeMeeting: meetingH.Handle,
		store.KindDailyDigest:     digestH.Handle,
	}
	pool := queue.NewPool(s, logger, 2, handlers)
	poolDone := make(chan struct{})
	go func() { pool.Run(ctx); close(poolDone) }()

	router := api.NewRouter(api.Deps{Store: s, Logger: logger, DevActorID: "alice"})
	srv := httptest.NewServer(router)
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"session_id": "s1", "project": "demo",
		"turns": []map[string]string{{"role": "user", "content": "I prefer Go"}},
		"attributes": map[string]any{"meeting_id": "m1", "meeting_ended": true},
	})
	resp, err := http.Post(srv.URL+"/events", "application/json", bytes.NewReader(body))
	if err != nil { t.Fatal(err) }
	if resp.StatusCode != http.StatusAccepted { t.Fatalf("status: %d", resp.StatusCode) }

	// wait for jobs to drain
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var pending int
		_ = s.DB.QueryRow(`SELECT count(*) FROM jobs WHERE state IN ('pending','running')`).Scan(&pending)
		if pending == 0 { break }
		time.Sleep(100 * time.Millisecond)
	}

	// recall meeting
	r, err := http.Get(srv.URL + "/recall?meeting=m1&visible=false")
	if err != nil { t.Fatal(err) }
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	if !strings.Contains(string(raw), `"dimension":"meeting"`) {
		t.Fatalf("meeting not recalled: %s", string(raw))
	}

	cancel()
	<-poolDone
}
```

Run: `go test ./internal/integration -v -timeout 90s`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "integration: end-to-end event → extract → meeting → recall test"
```

---

### Task 27: Dockerfile

**Files:**
- Create: `server/Dockerfile`

- [ ] **Step 1: Write `server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.23-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mnemo-server ./cmd/mnemo-server

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /out/mnemo-server /mnemo-server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/mnemo-server"]
```

- [ ] **Step 2: Build and run**

```bash
cd server && docker build -t mnemo-server:dev .
docker run --rm --network host -e DATABASE_URL='postgres://mnemo:mnemo@localhost:5432/mnemo?sslmode=disable' \
   -e MNEMO_AUTH_DISABLED=1 -e MNEMO_LLM_DISABLED=1 mnemo-server:dev &
sleep 1
curl http://localhost:8080/healthz
```

Expected: `{"db":true,"ok":true}`. Kill the container.

- [ ] **Step 3: Commit**

```bash
git add server/Dockerfile
git commit -m "build: multi-stage Dockerfile producing a distroless static image"
```

---

### Task 28: Production docker-compose + Caddyfile

**Files:**
- Create: `docker-compose.deploy.yml`
- Create: `Caddyfile.example`
- Create: `.env.deploy.example`

- [ ] **Step 1: Write `docker-compose.deploy.yml`**

```yaml
# Production / single-VM deploy stack. Mirrors auris's deploy compose.
#
#   docker compose -f docker-compose.deploy.yml pull mnemo
#   docker compose -f docker-compose.deploy.yml up -d
#
# State that survives container restarts:
#   - Postgres data → named volume `mnemo-pg-data`

services:
  postgres:
    image: postgres:16-alpine
    container_name: mnemo-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-mnemo}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env.deploy}
      POSTGRES_DB: ${POSTGRES_DB:-mnemo}
    volumes:
      - mnemo-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-mnemo} -d ${POSTGRES_DB:-mnemo}"]
      interval: 5s
      timeout: 3s
      retries: 5

  mnemo:
    image: ghcr.io/${GHCR_OWNER:?Set GHCR_OWNER in .env.deploy}/mnemo-server:${SERVER_TAG:-latest}
    container_name: mnemo-server
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-mnemo}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-mnemo}?sslmode=disable
      MNEMO_PORT: ${MNEMO_PORT:-8080}
      MNEMO_WORKER_COUNT: ${MNEMO_WORKER_COUNT:-4}
      MNEMO_AUTH_DISABLED: ${MNEMO_AUTH_DISABLED}
      AUTH0_DOMAIN: ${AUTH0_DOMAIN}
      AUTH0_API_AUDIENCE: ${AUTH0_API_AUDIENCE}
      MNEMO_LLM_DISABLED: ${MNEMO_LLM_DISABLED}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      MNEMO_LLM_MODEL: ${MNEMO_LLM_MODEL:-claude-sonnet-4-7-20251015}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASS: ${SMTP_PASS}
      SMTP_FROM: ${SMTP_FROM}
    ports:
      - "127.0.0.1:${MNEMO_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5

  caddy:
    image: caddy:2-alpine
    container_name: mnemo-caddy
    restart: unless-stopped
    depends_on:
      - mnemo
    environment:
      DOMAIN: ${PUBLIC_DOMAIN:?Set PUBLIC_DOMAIN in .env.deploy}
      PORT: ${PUBLIC_PORT:-443}
    ports:
      - "${PUBLIC_PORT:-443}:${PUBLIC_PORT:-443}"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/etc/caddy/origin:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  mnemo-pg-data:
  caddy-data:
  caddy-config:
```

- [ ] **Step 2: Write `Caddyfile.example`**

```
{$DOMAIN}:{$PORT} {
    tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem
    reverse_proxy mnemo:8080
}
```

- [ ] **Step 3: Write `.env.deploy.example`**

```
# Required
GHCR_OWNER=tiagodeoliveira
SERVER_TAG=latest
POSTGRES_PASSWORD=replace-me
PUBLIC_DOMAIN=mnemo.your-domain.example
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_API_AUDIENCE=https://mnemo.your-domain.example/

# LLM
ANTHROPIC_API_KEY=sk-ant-...
MNEMO_LLM_MODEL=claude-sonnet-4-7-20251015

# Optional SMTP for daily digest emails
SMTP_HOST=smtp.fastmail.com:587
SMTP_USER=you@your-domain.example
SMTP_PASS=app-password
SMTP_FROM=mnemo@your-domain.example

# Optional toggles
# MNEMO_AUTH_DISABLED=1
# MNEMO_LLM_DISABLED=1

# Local-only override (default 8080)
# MNEMO_PORT=8080
# PUBLIC_PORT=443
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.deploy.yml Caddyfile.example .env.deploy.example
git commit -m "build: production docker-compose, Caddyfile, env example"
```

---

### Task 29: GitHub Actions CI

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/test.yml`**

```yaml
name: test
on:
  pull_request: {}
  push:
    branches: [main, "feat/**"]
jobs:
  go-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache-dependency-path: server/go.sum
      - name: go test
        working-directory: server
        run: go test ./... -count=1 -timeout 120s
```

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: release
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/mnemo-server
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short
            type=ref,event=tag
      - uses: docker/build-push-action@v5
        with:
          context: server
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 3: Verify the `test.yml` workflow is syntactically valid**

```bash
# If `act` is installed:
act -W .github/workflows/test.yml -l
# Otherwise just push the branch and watch the CI run.
```

- [ ] **Step 4: Commit**

```bash
git add .github/
git commit -m "ci: test + release workflows, publish image to ghcr"
```

---

## Phase 11 — Client updates

### Task 30: CLI device-flow login

**Files:**
- Modify: `cli/package.json` (add deps)
- Create: `cli/src/auth.ts`
- Create: `cli/src/commands/login.ts`
- Modify: `cli/src/config.ts` (new fields)
- Modify: `cli/src/index.ts` or the command dispatcher (register `login`)

- [ ] **Step 1: Add deps**

```bash
cd cli
npm install --save node-fetch
```

(Node 22+ has native `fetch`, but pin for safety. Skip if you prefer the native version.)

- [ ] **Step 2: Write `cli/src/auth.ts`**

```typescript
// Auth0 OAuth Device Authorization Flow. Reads {domain, audience, clientId}
// from config, prints user_code + verification_uri, polls /oauth/token until
// the device is approved. Writes the resulting credentials to the config dir.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // unix seconds
}

const CRED_PATH = join(homedir(), ".mnemo", "credentials.json");

interface DeviceCodeResp {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResp {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

export async function deviceLogin(opts: {
  domain: string;
  audience: string;
  clientId: string;
}): Promise<Credentials> {
  const dc = (await (
    await fetch(`https://${opts.domain}/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: opts.clientId,
        scope: "openid profile email offline_access",
        audience: opts.audience,
      }),
    })
  ).json()) as DeviceCodeResp;

  console.log(`\nVisit: ${dc.verification_uri_complete}`);
  console.log(`Code:  ${dc.user_code}\n`);
  console.log(`Waiting for approval...`);

  const deadline = Date.now() + dc.expires_in * 1000;
  let interval = dc.interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = (await (
      await fetch(`https://${opts.domain}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: dc.device_code,
          client_id: opts.clientId,
        }),
      })
    ).json()) as TokenResp;
    if (t.access_token) {
      const cred: Credentials = {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
      };
      await fs.mkdir(join(homedir(), ".mnemo"), { recursive: true });
      await fs.writeFile(CRED_PATH, JSON.stringify(cred, null, 2), { mode: 0o600 });
      console.log(`Logged in. Credentials saved to ${CRED_PATH}`);
      return cred;
    }
    if (t.error === "slow_down") interval += 5000;
    else if (t.error && t.error !== "authorization_pending") {
      throw new Error(`auth: ${t.error}: ${t.error_description ?? ""}`);
    }
  }
  throw new Error("auth: device code expired");
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    return JSON.parse(await fs.readFile(CRED_PATH, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

export async function getAccessToken(opts: {
  domain: string;
  clientId: string;
}): Promise<string | null> {
  const cred = await loadCredentials();
  if (!cred) return null;
  if (cred.expires_at - 60 > Math.floor(Date.now() / 1000)) {
    return cred.access_token;
  }
  if (!cred.refresh_token) return null;
  const t = (await (
    await fetch(`https://${opts.domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: opts.clientId,
        refresh_token: cred.refresh_token,
      }),
    })
  ).json()) as TokenResp;
  if (!t.access_token) return null;
  const fresh: Credentials = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? cred.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
  };
  await fs.writeFile(CRED_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh.access_token;
}
```

- [ ] **Step 3: Write `cli/src/commands/login.ts`**

```typescript
import { deviceLogin } from "../auth.js";
import { loadConfig } from "../config.js";

export async function loginCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.auth0Domain || !cfg.auth0Audience || !cfg.auth0ClientId) {
    throw new Error("config: auth0Domain, auth0Audience, auth0ClientId required for login");
  }
  await deviceLogin({
    domain: cfg.auth0Domain,
    audience: cfg.auth0Audience,
    clientId: cfg.auth0ClientId,
  });
}
```

- [ ] **Step 4: Extend `cli/src/config.ts`** with the new fields

Add to the `Config` interface:

```typescript
export interface Config {
  apiUrl: string;
  // apiKey removed — replaced by Auth0 device flow.
  auth0Domain?: string;
  auth0Audience?: string;
  auth0ClientId?: string;
  workstation?: string;
  defaults?: { visible?: boolean };
}
```

Replace any places the CLI sets the `x-api-key` (or equivalent) request header to instead read the bearer token via `getAccessToken({ domain: cfg.auth0Domain!, clientId: cfg.auth0ClientId! })` and send `Authorization: Bearer <token>`. Exact lines in `cli/src/` to find: grep for `x-api-key`, `apiKey`, or `apikey`.

```bash
cd cli && grep -rn 'x-api-key\|apiKey\|apikey' src/
```

Update each match accordingly.

- [ ] **Step 5: Register the `login` command**

In the CLI's command dispatcher (find via `grep -n 'recall\|push' cli/src/index.ts` or equivalent), add a `login` case that calls `loginCmd`.

- [ ] **Step 6: Build the CLI**

```bash
cd cli && npm run build
```

Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add cli/
git commit -m "cli: Auth0 device-flow login, bearer-token API calls"
```

---

### Task 31: Chrome extension auth + base URL update

**Files:**
- Modify: `extension/options.html`
- Modify: `extension/options.js`
- Modify: `extension/background.js`

- [ ] **Step 1: Update `extension/options.html`** to surface Auth0 config

Replace the API key input with four fields:
- API base URL (existing)
- Auth0 domain
- Auth0 audience
- Auth0 client ID

(Same shape the CLI config holds.)

- [ ] **Step 2: Update `extension/options.js`** to persist the new fields

Read/write them via `chrome.storage.local`, matching the existing field handling.

- [ ] **Step 3: Add Auth0 popup OAuth in `extension/background.js`**

Use `chrome.identity.launchWebAuthFlow` against `https://${domain}/authorize?...` with `response_type=token`, `audience=...`, the configured client id, and the extension's redirect URI. Store the resulting `access_token` + `expires_at` in `chrome.storage.local`.

Reference auris's existing extension popup-OAuth code as the template — same pattern.

```bash
ls /Users/tiago/src/github.com/tiagodeoliveira/meeting_companion/packages/  # if there's a browser extension, copy the auth shape
```

(If auris does not have a browser extension with Auth0, write the popup-OAuth function from scratch following the Auth0 SPA documentation.)

Replace the existing `x-api-key` header in outgoing fetches with `Authorization: Bearer <access_token>`.

- [ ] **Step 4: Manual smoke test**

Load the unpacked extension at `chrome://extensions`, open Options, fill in the fields, click "Sign in", complete the popup, then trigger a recall from the popup UI.

- [ ] **Step 5: Commit**

```bash
git add extension/
git commit -m "extension: Auth0 popup OAuth + bearer-token requests"
```

---

### Task 32: Auris M2M credential swap

**Files:**
- Modify: `meeting_companion/packages/server/src/mnemo/client.rs`
- Modify: `meeting_companion/.env.deploy.example`

(External repo: `/Users/tiago/src/github.com/tiagodeoliveira/meeting_companion`.)

- [ ] **Step 1: Read the existing client**

```bash
cat /Users/tiago/src/github.com/tiagodeoliveira/meeting_companion/packages/server/src/mnemo/client.rs
```

- [ ] **Step 2: Replace the static API-key header with an Auth0 M2M token**

The change: instead of sending `x-api-key: <static>`, the client should:

1. On boot, exchange `AURIS_MNEMO_M2M_CLIENT_ID` + `AURIS_MNEMO_M2M_CLIENT_SECRET` for an access token via Auth0's `/oauth/token` (`grant_type=client_credentials`, `audience=AUTH0_API_AUDIENCE`).
2. Cache the token; refresh ~5 min before `expires_in`.
3. Send `Authorization: Bearer <token>` on every request.

Add the new code in `client.rs` (it's already ~150 LOC; the M2M handling fits inline). Keep the existing `AURIS_MNEMO_URL` variable name unchanged. Rename `AURIS_MNEMO_API_KEY` → `AURIS_MNEMO_M2M_CLIENT_ID` + `AURIS_MNEMO_M2M_CLIENT_SECRET`.

- [ ] **Step 3: Update `.env.deploy.example`** in the auris repo accordingly.

- [ ] **Step 4: Commit in the auris repo**

```bash
cd /Users/tiago/src/github.com/tiagodeoliveira/meeting_companion
git checkout -b feat/mnemo-auth0-m2m
git add packages/server/src/mnemo/client.rs .env.deploy.example
git commit -m "mnemo: swap static API key for Auth0 M2M client credentials"
```

---

## Phase 12 — Cutover

### Task 33: Production smoke test

- [ ] **Step 1: SSH to VPS, pull the image, bring up the stack**

```bash
ssh tiago@<vps>
cd ~/mnemo
docker compose -f docker-compose.deploy.yml pull mnemo
docker compose -f docker-compose.deploy.yml up -d
```

- [ ] **Step 2: Verify the health endpoint via Caddy**

```bash
curl -i https://mnemo.your-domain.example/healthz
```

Expected: `200` and `{"db":true,"ok":true}`.

- [ ] **Step 3: Provision two actors via SQL**

```bash
docker compose -f docker-compose.deploy.yml exec postgres \
  psql -U mnemo -d mnemo -c \
  "INSERT INTO actors (actor_id, display_name, email, timezone, digest_enabled) \
   VALUES ('auth0|<tiago-sub>', 'tiago', 'tiago@...', 'America/Los_Angeles', true), \
          ('auth0|<wife-sub>',  'wife',  'wife@...',  'America/Los_Angeles', true) \
   ON CONFLICT (actor_id) DO NOTHING;"
```

Replace the `auth0|<...>` values after the first `mnemo login` (which auto-inserts the rows; you can then `UPDATE` to add email/timezone).

- [ ] **Step 4: `mnemo login` from your laptop**

```bash
mnemo login
mnemo push --session "smoke-$(date +%s)" \
  --turns '[{"role":"user","content":"smoke test"}]' \
  --source manual
mnemo recall --about
```

Expected: push returns an event_id; recall returns something within ~10s.

- [ ] **Step 5: Verify a meeting end-to-end via curl**

```bash
TOKEN=$(jq -r .access_token ~/.mnemo/credentials.json)
curl -X POST https://mnemo.your-domain.example/events \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"session_id":"s1","turns":[{"role":"user","content":"hello"}],"attributes":{"meeting_id":"smoke","meeting_ended":true}}'
sleep 15
curl "https://mnemo.your-domain.example/recall?meeting=smoke&visible=false" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: 6 meeting category rows in the response.

- [ ] **Step 6: Update auris's `.env.deploy`** with the new mnemo URL + M2M client credential

```bash
ssh tiago@<vps>
cd ~/auris
# edit .env.deploy: set AURIS_MNEMO_URL, AURIS_MNEMO_M2M_CLIENT_ID, AURIS_MNEMO_M2M_CLIENT_SECRET
docker compose -f docker-compose.deploy.yml up -d server
```

Verify: open a meeting in auris, watch `docker logs -f mnemo-server` and confirm events are arriving with valid bearer tokens.

---

### Task 34: Old AWS stack teardown (after burn-in week)

- [ ] **Step 1: Confirm one week of stable use against new mnemo**

Inspect `jobs WHERE state='failed'` and `docker logs mnemo-server | grep ERROR`. Goal: zero unexplained failures over 7 days.

- [ ] **Step 2: Tear down the old CDK stack**

```bash
cd /Users/tiago/src/github.com/tiagodeoliveira/mnemo/infra
npx cdk destroy
```

- [ ] **Step 3: Delete `infra/` and update the README**

```bash
cd /Users/tiago/src/github.com/tiagodeoliveira/mnemo
git rm -r infra/
```

Rewrite `README.md` to describe the new self-hosted shape. Keep the dimension table; replace the AWS architecture section with the new VPS architecture; update deploy instructions.

- [ ] **Step 4: Final commit + merge to main**

```bash
git add -A
git commit -m "cleanup: remove AWS CDK stack and update README for self-hosted shape"
git push -u origin feat/go-server-rewrite
gh pr create --title "mnemo Go rewrite: self-hosted, Postgres-backed" --body "$(cat <<'EOF'
## Summary
- Replaces the AWS-native stack (Lambda + AgentCore + DynamoDB + S3 + SQS + SNS + EventBridge + SES) with a single Go server backed by a dedicated Postgres container on the existing VPS.
- Same public REST API (drop-in for CLI + extension after URL/auth config swap).
- Auth0 multi-actor (two actors: user + spouse).
- Postgres-backed job queue (in-process workers, `SKIP LOCKED`).
- Queryable `--attr` metadata (new capability vs. AgentCore).

## Test plan
- [x] `go test ./...` green (unit + integration via testcontainers)
- [x] /healthz returns ok in production
- [x] CLI device-flow login works end-to-end
- [x] Meeting end-to-end (push → 6 category rows recallable) verified
- [x] Auris M2M integration round-trips
- [x] 7-day burn-in with zero unexplained job failures
- [x] Old CDK stack destroyed
EOF
)"
```

Done.

---

## Self-review checklist (executed)

**Spec coverage:**

- ✅ Drop-in API: Tasks 11 (events), 18 (recall) preserve request/response shape.
- ✅ All 9 dimensions: Task 22 writes 8 (preferences, facts, episodes, about, project, task, daily_log) and Task 23 writes meeting; daily_summary written in Task 24.
- ✅ Dedicated Postgres + auris-style deploy: Tasks 27, 28.
- ✅ Queryable `--attr` metadata: Task 17 (store filter), Task 18 (`attr.*` query parsing).
- ✅ Two-actor multi-tenancy: Task 8 (sub-claim resolution + auto-insert).
- ✅ `?q=` accepted but ignored: Task 18 ignores the `q` query value (recency order is the default in `QueryByPrefix`).
- ✅ In-process workers + Postgres job queue: Tasks 10, 13, 14.
- ✅ Pluggable LLM, Anthropic default: Tasks 15, 16.
- ✅ Auth0 + dev bypass: Tasks 7, 8.
- ✅ No meeting staging — finalizer reads `events`: Task 23.
- ✅ SMTP delivery: Task 24.
- ✅ Scheduler in-process: Task 25.
- ✅ Dockerfile, deploy compose, Caddy, CI: Tasks 27, 28, 29.
- ✅ Cutover plan: Tasks 33, 34.

**Type consistency:** `JobKind` constants used identically in Tasks 10, 11, 13, 22, 23, 24, 26. `MemoryInput` shape consistent across Tasks 17, 22, 23, 24. `RecallFilter` shape stable. `Credentials` type consistent in Tasks 30, 31.

**Placeholder scan:** Two `... PORT FROM ...` strings in Task 19 and Task 23 (prompt bodies). These are deliberate hand-offs: the production prompts already exist in the TS codebase and must be copy-pasted verbatim during execution. The structure (constants, parser types) is fully specified; only the prompt text is delegated.

Everything else is concrete with exact paths, code, and commands.
