# CLI Digest Configuration

**Date:** 2026-05-21
**Status:** Approved

## Goal

Allow a logged-in user to view and update their daily digest settings via `mnemo config digest`.

## Decisions

- **CLI shape:** `mnemo config digest [--enable|--disable] [--timezone TZ] [--email ADDR]`
- **API approach:** General `GET/PATCH /me` actor profile endpoint (reusable for future config commands)
- **No migration needed:** `digest_enabled`, `email`, and `timezone` columns already exist on `actors`

## Server: `GET/PATCH /me`

### GET /me

Returns the authenticated actor's profile:

```json
{
  "actor_id": "auth0|abc123",
  "display_name": "auth0|abc123",
  "email": "tiago@tiago.sh",
  "timezone": "America/Sao_Paulo",
  "digest_enabled": true,
  "episode_strategy": "monthly_bucket"
}
```

### PATCH /me

Accepts a partial update. Only provided fields are changed:

```json
{
  "email": "tiago@tiago.sh",
  "timezone": "America/Sao_Paulo",
  "digest_enabled": true
}
```

Returns the full updated profile (same shape as GET).

### Validation

| Field | Rule |
|-------|------|
| `timezone` | Must pass `time.LoadLocation()` (valid IANA timezone) |
| `email` | Must contain `@` |
| `digest_enabled` | Boolean, no extra validation |
| Unknown fields | Ignored |

### Error responses

| Condition | Status | Body |
|-----------|--------|------|
| Invalid timezone | 400 | `{"error": "invalid timezone: \"Foo/Bar\""}` |
| Invalid email | 400 | `{"error": "invalid email"}` |
| Empty PATCH body | 400 | `{"error": "no fields to update"}` |
| Bad JSON | 400 | `{"error": "invalid JSON"}` |

## Store: `UpdateActorProfile`

New method on `*Store`:

```go
type ActorProfileUpdate struct {
    Email         *string // nil = don't change
    Timezone      *string
    DigestEnabled *bool
}

func (s *Store) UpdateActorProfile(ctx context.Context, actorID string, u ActorProfileUpdate) (Actor, error)
```

Builds a dynamic UPDATE query from non-nil fields. Returns the updated Actor row.

Also need `GetActor(ctx, actorID) (Actor, error)` if one doesn't exist yet, for the GET path.

## CLI: `mnemo config digest`

### Usage

```
mnemo config digest                                    # show current settings
mnemo config digest --enable                           # enable daily digest
mnemo config digest --disable                          # disable daily digest
mnemo config digest --timezone America/Sao_Paulo       # set timezone
mnemo config digest --email tiago@tiago.sh             # set email
mnemo config digest --enable --tz US/Eastern --email a@b.com  # combine flags
```

### Behavior

- **No flags:** `GET /me`, print digest-related fields as a formatted table
- **With flags:** `PATCH /me` with provided fields, print updated settings
- `--enable` and `--disable` are mutually exclusive (CLI error before request)

### Output format (no flags)

```
Digest Settings
  Enabled:   true
  Email:     tiago@tiago.sh
  Timezone:  America/Sao_Paulo
```

### Output format (after update)

```
Digest settings updated:
  Enabled:   true
  Email:     tiago@tiago.sh
  Timezone:  America/Sao_Paulo
```

## Files

| File | Action |
|------|--------|
| `server/internal/api/me.go` | New: meHandler (GET + PATCH) |
| `server/internal/api/me_test.go` | New: tests for both methods |
| `server/internal/api/router.go` | Modify: register `/me` |
| `server/internal/store/actors.go` | Modify: add GetActor + UpdateActorProfile |
| `server/internal/store/actors_test.go` | Modify: test new methods |
| `cli/src/commands/config-digest.ts` | New: digest config command |
| `cli/src/index.ts` | Modify: register config digest subcommand |
