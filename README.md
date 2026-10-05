# career-ops-tj

A personal fork of **[career-ops](https://github.com/santifer/career-ops)** by
[Santifer](https://santifer.io) (santifer), tuned for one
Claude Code user running an English-language, US-based job search.

<p>
  <a href="https://github.com/santifer/career-ops"><img src="https://img.shields.io/badge/fork_of-santifer%2Fcareer--ops-2b3137?style=flat&logo=github" alt="Fork of santifer/career-ops"></a>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

> **Looking for career-ops itself?** Go to **[santifer/career-ops](https://github.com/santifer/career-ops)**.
> The upstream project supports many AI CLIs and output languages, has an `npx` installer,
> release notes, a Discord, and an active maintainer. This fork drops some of that generality on purpose.
> Issues and feature requests about career-ops belong upstream, not here.

## What career-ops does

career-ops turns Claude Code into a job-search command center. It runs locally, reads your CV, and:

- **Evaluates job postings** against your CV: blocks A-F scored on a 1-5 scale, plus a separate
  posting-legitimacy check (block G) that never affects the score
- **Tailors an ATS-friendly CV PDF** per posting
- **Scans job portals** (Greenhouse, Ashby, Lever and more) without spending model tokens
- **Batch-evaluates** many postings with parallel headless workers
- **Tracks every application** in one Markdown table, with merge, dedup and health checks
- **Drafts outreach, cover letters and application emails**. It never sends or submits anything.

It is a filter, not an auto-applier: it recommends against applying to anything scoring below 4.0/5,
and you review everything before it goes out.

## How this fork differs from upstream

Last merged with upstream v1.24.0. The changes, with the plan behind each in [`plans/`](plans/):

**Narrower scope**

- **Claude Code and English only.** The 16 non-English mode directories and README translations are
  removed, and the agent instructions route through Claude Code alone. Wrapper files for other CLIs
  (`CODEX.md`, `OPENCODE.md`, `.cursor/` …) are still present from upstream but untested here.
  ([plan](plans/07-17-26_pipeline-efficiency-and-personalization.md))
- **Interview prep is deferred.** Evaluations no longer write a full STAR-story pack for every posting.
  The Interview Plan block is a one-line stub, and the full `interview-prep` kit runs once a role
  actually reaches the interview stage. ([plan](plans/07-31-26_defer-interview-prep-from-evaluation.md))

**New features**

- **Google Sheets mirror.** An opt-in `sheets` plugin reconciles `data/applications.md` into a Google
  Sheet, including each job's own location. Preview with `npm run sheets:sync:dry`, write with
  `npm run sheets:sync`. ([plan](plans/08-31-26_google-sheets-sync.md),
  [location fix](plans/10-01-26_fix-sheets-job-location.md))
- **Upload-ready CV copy.** `npm run export-cv <report#>` copies a report's tailored PDF to one fixed
  file name. ([plan](plans/10-02-26_feat-pdf-copy.md))
- **Work mode and job location in every report.** The report's Machine Summary records `work_mode`
  and `job_location`, read through one shared module by the dashboard, the sheet sync and
  `verify-pipeline.mjs`.

**Fixes**

- **Upstream updates merge instead of overwrite.** `node update-system.mjs apply` now runs a real
  `git merge` of upstream, so local changes to system files survive an update. Paths this fork deleted
  are listed in [`.update-exclude`](.update-exclude) and stay deleted.
  ([plan](plans/07-31-26_replace-update-mechanism-with-merge.md))
- **Tracker merges no longer overwrite unrelated roles.** `merge-tracker.mjs` used to fuzzy-match
  short titles and silently replace one company's row with another role's data.
  ([plan](plans/07-17-26_merge-tracker-dedup-bug-fix.md))
- **Tailored CVs no longer overwrite each other.** CV file names now include the report number, so
  several roles at one company keep separate PDFs. ([plan](plans/09-08-26_fix-cv-filename-collisions.md))
- **Batch runner fixes.** It pre-renders JavaScript-heavy job pages before handing them to a worker,
  works on macOS's bash 3.2, and records each worker's score in `batch/batch-state.tsv`.

**Personal defaults**

The CV template, `portals.yml` company list and scoring archetypes are set up for this fork's owner.
Your own CV, profile and tracker data are gitignored and never committed.

## Setup

> `npx @santifer/career-ops init` installs **upstream**, not this fork. To use this fork, clone it.

You need [Node.js](https://nodejs.org) 18+ and [Claude Code](https://claude.com/claude-code).
The terminal dashboard also needs [Go](https://go.dev).

```bash
git clone https://github.com/TahJam/career-ops-tj.git career-ops
cd career-ops && npm install
npx playwright install chromium   # needed for PDF generation and page rendering
npm run doctor                    # checks what is still missing
claude
```

On first launch, Claude walks you through setup by chat: your CV (`cv.md`), your profile
(`config/profile.yml`), target roles and the portal list (`portals.yml`). You don't have to edit
anything by hand. Your personal details go in user-layer files that updates never touch; see
[DATA_CONTRACT.md](DATA_CONTRACT.md).

> **The first evaluations won't be great.** The system doesn't know you yet. Give it your career story,
> proof points and deal-breakers, and correct scores you disagree with. It writes what it learns into
> `modes/_profile.md` and `config/profile.yml`.

## Usage

Paste a job URL or description into Claude Code and it runs the full pipeline: evaluation, report,
a tailored PDF if the score clears `auto_pdf_score_threshold` in `config/profile.yml` (default 3.0),
and a tracker row. Or call a mode directly:

```
/career-ops                → Show all commands
/career-ops scan           → Scan portals for new postings
/career-ops pipeline       → Evaluate pending URLs in data/pipeline.md
/career-ops batch          → Evaluate many postings in parallel
/career-ops pdf            → Generate a tailored CV PDF
/career-ops cover          → Cover letter
/career-ops email          → Application email draft (never sends)
/career-ops contacto       → Find a recruiter or hiring manager + draft a LinkedIn message
/career-ops deep           → Company research prompt
/career-ops interview-prep → Company-specific interview prep, once you land an interview
/career-ops tracker        → Application status overview
/career-ops apply          → Fill an application form (stops before Submit)
```

### Batch runs

For a backlog of more than about five postings, use the standalone runner. It retries failures, pauses
cleanly on a Claude usage limit, and merges results into the tracker at the end:

```bash
node pipeline-to-batch-input.mjs                     # data/pipeline.md → batch/batch-input.tsv
batch/batch-runner.sh --dry-run --limit 5            # preview
batch/batch-runner.sh --limit 5 --parallel 3         # run
batch/batch-runner.sh --resume-paused                # continue after a usage-limit pause
```

### Upload-ready CV

Tailored CVs are saved per report as `output/cv-{you}-{company}-{NNN}-{date}.pdf`. To upload one under
a fixed name, set `cv.export_path` in `config/profile.yml`, then:

```bash
npm run export-cv 248                              # copy report 248's CV to cv.export_path
npm run export-cv 248 -- --out ~/Desktop/CV.pdf    # one-off destination (note the `--`)
```

### Google Sheet mirror

Enable the `sheets` plugin (`node plugins.mjs list`), add a Google service-account key, then run
`npm run sheets:sync:dry` to preview and `npm run sheets:sync` to write. It only touches columns A-H,
backs the tab up before writing, and never inserts, deletes or sorts rows. Setup steps:
`node plugins.mjs skill sheets`.

### Dashboard

```bash
npm run serve:dashboard   # terminal UI to browse, filter and sort the tracker (needs Go)
```

## Pulling in upstream changes

```bash
node update-system.mjs check      # is there a newer upstream release?
node update-system.mjs apply      # git-merge upstream into this fork
node update-system.mjs rollback   # undo the last apply
```

`apply` resolves conflicts on its own only for paths in `.update-exclude`. For anything else it stops
and lists the conflicted files, so you can resolve them by hand and then run
`git add <files> && git commit --no-edit`. Expect `README.md` to conflict on most updates: keep this
fork's version (`git checkout --ours README.md`) and port over anything useful.

## Project structure

```
career-ops/
├── AGENTS.md                # Agent instructions (CLAUDE.md imports it)
├── CLAUDE.md                # Claude Code entry point
├── CODEX.md, OPENCODE.md …  # Other-CLI wrappers inherited from upstream (untested here)
├── DATA_CONTRACT.md         # Which files are yours vs. system files
├── cv.md                    # Your CV (created during setup, gitignored)
├── config/profile.yml       # Your profile (created during setup, gitignored)
├── portals.yml              # Scanner companies and queries
├── modes/                   # One file per /career-ops mode
│   ├── _shared.md           # Shared scoring rules (system layer)
│   ├── _profile.md          # Your archetypes and narrative (user layer)
│   └── _custom.md           # Your house rules (user layer)
├── templates/               # CV template, portal example, canonical states
├── batch/                   # Batch runner and worker prompt
├── plugins/                 # Opt-in integrations (sheets, gmail, notion, apify)
├── dashboard/               # Go terminal UI
├── plans/                   # Design plan behind each fork change
├── data/                    # Tracker, pipeline, history (gitignored)
├── reports/                 # Evaluation reports (gitignored)
└── output/                  # Generated PDFs (gitignored)
```

More detail lives in the docs inherited from upstream: [setup](docs/SETUP.md),
[customization](docs/CUSTOMIZATION.md), [scripts](docs/SCRIPTS.md), [plugins](docs/PLUGINS.md),
[automation](docs/AUTOMATION.md), [FAQ](docs/FAQ.md) and [architecture](ARCHITECTURE.md).
Some of them describe multi-CLI or multi-language options that this fork doesn't use.

## Credits

career-ops was created by [Santiago Fernández de Valderrama Aparicio](https://santifer.io/about),
who built it for his own job search, used it to land a Head of Applied AI role, and open-sourced it.
Almost all of this code is his and the
[upstream contributors'](https://github.com/santifer/career-ops/graphs/contributors)
(see [CONTRIBUTORS.md](CONTRIBUTORS.md)). If it helps you, star and support
[the original](https://github.com/santifer/career-ops).

career-ops is the reference implementation of the
[CareerOps Manifesto](https://career-ops.org/manifesto).

## Disclaimer

**career-ops is a local tool, not a hosted service.** Your CV and personal data stay on your machine and
go only to the AI provider you use. AI output can be wrong: review every evaluation, CV and draft before
you rely on it or send it. Use it within the terms of service of the job portals you access, and don't
use it to spam employers. Evaluations are recommendations, and the authors aren't liable for employment
outcomes. See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md).

## License & trademark

MIT, see [LICENSE](LICENSE). The "career-ops" name and brand belong to the upstream project and are
covered by its [Trademark Policy](TRADEMARK.md). This repository is an unofficial fork and isn't
endorsed by the upstream maintainer.
