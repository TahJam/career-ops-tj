---
name: career-ops-plugin-sheets
description: How to mirror the career-ops tracker into your own Google Sheet.
license: MIT
---

# sheets plugin

Mirrors your application tracker into a Google Sheet you own.
`data/applications.md` stays the source of truth — the sheet is an additive mirror.

## Commands

- `node plugins.mjs run sheets export` — reconcile the sheet with the tracker.
  Add `--dry-run` to preview every write without touching the sheet.

There is one command for both sync modes. Scope comes from the plugin's own
cursor at `data/sheets-sync-state.json`, not from a flag:

| Situation | Behaviour |
|---|---|
| No state file (first run) | full sync |
| State file present | delta — replays `data/status-log.tsv` from the cursor |
| `rm data/sheets-sync-state.json` | full sync again |
| `SHEETS_SYNC_MODE=full` | full sync, keeping the state file |

## After a status change

`node set-status.mjs <selector> <State>` emits `sheetSyncCandidate: true` when a
row's status actually changes. Run the export afterwards to push it:

```
node set-status.mjs 114 Rejected && node plugins.mjs run sheets export
```

Never call the sheet from inside a tracker write — the export runs after the
tracker lock is released.

## Setup

`GOOGLE_SHEET_ID` and `GOOGLE_AUTH_PATH` in `.env`, pointing at a service-account
JSON key. Share the spreadsheet with that service account's `client_email` as an
**Editor**. Enable with `plugins.sheets.enabled: true` in `config/plugins.yml`.

## Data it produces

`export` returns `{ pushed: N }`. It writes only to your Google Sheet and to its
own cursor file; it never writes `data/applications.md`.
