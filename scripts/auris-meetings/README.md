# Auris meetings → mnemo comparison

Replays 4 auris meetings through local v2 mnemo and compares the
resulting category summaries against the AWS v1 mnemo stack.

## Prerequisites

- Local v2 mnemo running (`scripts/smoke.sh` works, OR `docker compose up -d postgres`
  and start the server manually).
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` set (needed for v2 inline extraction +
  finalize_meeting job).
- AWS v1 mnemo URL + API key for the comparison step.
- SSH access to the VPS where production auris runs.
- Tools: `docker`, `curl`, `jq` — on both VPS and local machine.

---

## Step 1 — extract on the VPS

Copy the extraction script to the VPS, run it, then pull the bundle down.

```bash
scp scripts/auris-meetings/extract.sh tiago@<vps>:/tmp/
ssh tiago@<vps> 'chmod +x /tmp/extract.sh'
```

On the VPS:
```bash
# Auto-pick the 4 most recent completed meetings:
/tmp/extract.sh

# Or specify meeting IDs explicitly:
/tmp/extract.sh <id1> <id2> <id3> <id4>
```

Back on your local machine:
```bash
scp tiago@<vps>:/tmp/auris-meetings-bundle.tar.gz ./
```

The bundle contains one directory per meeting:
```
meetings/
  <meeting_id>/
    meeting.json        — row from the meetings table
    items.json          — highlights / actions / questions (non-transcript items)
    moments.json        — manual marks and summaries
    transcription.jsonl — raw transcript, one Item JSON per line
```

---

## Step 2 — replay locally

Make sure local v2 mnemo is running and healthy before replaying.

```bash
# Quickest local start (auth disabled, real LLM):
docker compose up -d postgres
set -a && source .env && set +a
go run ./server/cmd/mnemo-server &
SERVER_PID=$!

# Verify it's up:
curl -fsS http://localhost:8080/healthz
```

Then replay:
```bash
./scripts/auris-meetings/replay.sh ./auris-meetings-bundle.tar.gz
```

The script:
1. Untars the bundle.
2. For each meeting, reads the transcript JSONL line by line.
3. Formats each item as `"[Speaker N] <text>"` or `"<text>"` (matching the
   live auris pusher's format_transcript_content logic).
4. Posts chunks of 10 items to `POST /events` with `meeting_id` in attributes.
5. Marks the last chunk `meeting_ended=true` so mnemo enqueues `finalize_meeting`.
6. Polls the local Postgres `jobs` table until all jobs drain (up to 10 min).

**Dry-run mode** — prints what would be sent without calling the server:
```bash
DRY_RUN=1 ./scripts/auris-meetings/replay.sh ./auris-meetings-bundle.tar.gz
```

**Env overrides:**
| Var | Default | Purpose |
|-----|---------|---------|
| `MNEMO_URL` | `http://localhost:8080` | local v2 server |
| `ACTOR_ID` | `dev-actor` | actor used when auth is disabled |
| `CHUNK_SIZE` | `10` | transcript items per POST /events |
| `DRY_RUN` | `0` | set to `1` to preview without pushing |

---

## Step 3 — compare

```bash
export AWS_MNEMO_URL=https://abc.execute-api.us-east-1.amazonaws.com/v1
export AWS_MNEMO_KEY=<your-v1-api-key>

./scripts/auris-meetings/compare.sh ./auris-meetings-bundle.tar.gz
```

Produces `meeting-comparison.md` in the current directory with a side-by-side
markdown table for each meeting and each of the 6 categories:
`summary`, `decisions`, `actions`, `questions`, `highlights`, `followups`.

The compare script handles two known v1 AWS response shapes:
- **Shape A** (late v1): `{dimensions:[{dimension:"meeting",items:[{namespace:".../<cat>/",content:"..."}]}]}`
- **Shape B** (early v1): `{meetings:{"<id>":{"summary":"...","decisions":"...",...}}}`
- **Shape C** (fallback): top-level category keys directly

If neither shape matches, the category shows as "_empty / not produced_".

**Env overrides:**
| Var | Default | Purpose |
|-----|---------|---------|
| `MNEMO_URL` | `http://localhost:8080` | local v2 server |
| `ACTOR_ID` | `dev-actor` | actor for v2 recall |
| `OUTPUT_FILE` | `./meeting-comparison.md` | output path |

---

## Cleanup

```bash
kill $SERVER_PID
docker compose down
```

---

## Notes on transcript JSONL shape

Each line in `transcription.jsonl` is a JSON-encoded `Item` (from auris
`contract.rs`):

```json
{"id":"uuid","text":"what was said","t":12345,"meta":{"speaker":"1"}}
```

Fields:
- `id` — item UUID
- `text` — transcript text (the only field the replay script needs)
- `t` — timestamp in milliseconds from meeting start
- `detail` — optional, usually absent for transcript items
- `meta` — optional; `meta.speaker` holds the Soniox speaker label (e.g. `"1"`, `"2"`)

The replay script formats each item identically to the live auris pusher:
`"[Speaker 1] hello"` when `meta.speaker` is present, `"hello"` otherwise.

If you encounter a different shape, inspect a sample line first:
```bash
tar -xzf auris-meetings-bundle.tar.gz --to-stdout meetings/*/transcription.jsonl | head -1 | jq .
```
