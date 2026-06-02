---
name: mnemo
description: "Capture OpenClaw message exchanges and push them to mnemo"
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["message:received", "message:sent"] } }
---

# mnemo

Pairs `message:received` and `message:sent` events into a normalized exchange, then pushes the user and assistant turns to `mnemo`.

## Routing

The installed hook reads `~/.openclaw/hooks/mnemo/.env`.
Set `MNEMO_OPENCLAW_CHANNELS` there to a comma-separated allowlist of OpenClaw channels to ingest, for example `telegram,whatsapp`.
If unset, the hook accepts all channels.

## Logs

- `~/.openclaw/logs/mnemo-hook.log` -- raw events
- `~/.openclaw/logs/mnemo-normalized.log` -- paired exchanges
- `~/.openclaw/logs/mnemo-push.log` -- mnemo CLI push results

These logs are append-only JSONL and are not rotated automatically. To prevent unbounded growth, set up periodic rotation with logrotate or a cron job, for example:

```
# /etc/logrotate.d/mnemo-openclaw (or run manually)
~/.openclaw/logs/mnemo-*.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}
```
