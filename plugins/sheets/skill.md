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

There is one command for both sync modes, and it always reconciles the whole
tab. It decides what to write by **comparing the sheet's values against the
tracker** — never by consulting a journal — so a status changed anywhere is
picked up: `set-status.mjs`, the Go dashboard, `merge-tracker.mjs`, or a hand
edit to `data/applications.md`.

| Situation | Behaviour |
|---|---|
| Sheet already matches the tracker | reads, compares, writes nothing |
| Anything differs | rewrites `A2:H<n>` in date order |
| `SHEETS_SYNC_MODE=full` | rewrites even when values already match |

`data/sheets-sync-state.json` holds a cursor into `data/status-log.tsv`. It is
bookkeeping for that ledger's other readers — it does **not** gate the sync, and
deleting it changes nothing about what gets written.

## After a status change

Run the export after any status change, from whatever source:

```
node set-status.mjs 114 Rejected && node plugins.mjs run sheets export
```

`set-status.mjs` emits `sheetSyncCandidate: true` when a row's status actually
changes, as a prompt to run it. That signal is a convenience, not the trigger —
the sync detects drift on its own, so a change made in the dashboard or by hand
is picked up by the next run just the same.

Never call the sheet from inside a tracker write — the export runs after the
tracker lock is released.

## Setup

`GOOGLE_SHEET_ID` and `GOOGLE_AUTH_PATH` in `.env`, pointing at a service-account
JSON key. Share the spreadsheet with that service account's `client_email` as an
**Editor**. Enable with `plugins.sheets.enabled: true` in `config/plugins.yml`.

## Data it produces

`export` returns `{ pushed: N }`. It writes only to your Google Sheet and to its
own cursor file; it never writes `data/applications.md`.
