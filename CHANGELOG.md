# Changelog

## 1.2.5

Retroactive git-based statistics, monthly calendar navigation, and dashboard polish.

### New

- **Retroactive git history stats** (`src/core/gitStats.ts`): language composition and most-worked files are now computed from the *entire* git history (up to 2000 commits), not just live-tracked events — covers edits made before the extension was installed.
  - Language breakdown (`byLanguage`) and top files (`topFiles`) are derived from `repo.log` + `diffBetweenWithStats` via the `vscode.git` API only — no `git` process spawned.
  - Used as the primary source for "Project composition" and "Most worked-on files" when available, falling back to the live 7-day rollup otherwise; each section is labeled accordingly ("full git history" vs "· 7 d").
  - Computed once per panel session and cached (one diff per commit — expensive to recompute).

- **Monthly calendar navigation**: the activity heatmap now shows one calendar month at a time (`buildCalendarGridForMonth`) with Previous/Next controls (`availableMonths`), instead of a fixed rolling window.

- **Non-linear daily series** (`dailySeriesNonLinear`): consecutive days with zero activity are collapsed into a single compact gap point on the time/token charts, instead of each empty day taking up its own axis slot.

- **"Tokens (excl. cache)" metric**: new per-agent stat surfaced alongside total tokens.

- Custom themed scrollbars across the dashboard; panels in 2-column grids now stretch to equal height.

### Fixed

- **CSP broke dynamic inline styles**: `style-src` previously combined `'nonce-…'` with the implicit allowance, which browsers ignore once a nonce is present — silently blocking every dynamically generated `style=""` attribute (language colors, bar widths). `style-src` is now `'unsafe-inline'` alone; the nonce stays on `script-src`, the only directive where it actually guards against JS injection.

### Changed

- Relabeled dashboard legends for clarity: "editor interaction" / "agent alone" / "focus / idle" → "User" / "AI agents" / "Waiting".
- Added "Show all / Show less" toggle and French localization for new strings.

## 1.1.0

Local per-project development time tracking, with automatic history reconstruction and a built-in dashboard.

### New

- **History reconstruction**: the first time a project is opened, the extension automatically rebuilds a history from:
  - **AI agents**: reads all past Claude Code / Codex CLI sessions (turns, tokens, estimated cost, per-model breakdown);
  - **git**: full commit history via the `vscode.git` API (enriched commits);
  - **work time**: estimated per day from the spread of signals (commits + agent turns), capped at 12h/day and flagged `estimated` so it's never confused with measured time.
  - Deterministic `eventId`s guarantee no double counting once live tracking resumes on top of the reconstructed history.

- **Dashboard (webview)**:
  - GitHub-style activity grid (intensity = time tracked per day);
  - working-hours heatmap (day × hour, local time);
  - time per day (interaction / agent-only / idle) and tokens per day (Claude / Codex) over 30 days;
  - project composition (languages worked on, by lines);
  - per-agent breakdown: sessions, turns, cache hit ratio, cost, per-model breakdown;
  - most-worked files over 7 days.

- **Live activity tracking**: sessions based on editor interaction, active agent presence, and window focus, with explicit rules to avoid counting idle time (a window left open, an agent grinding alone, etc.).

- **Estimated cost**: token-based cost calculation (in/out/cache) from versioned pricing tables (`pricing/claude.json`, `pricing/openai.json`); every recorded cost keeps its `pricingVersion`.

- **Commands**:
  - `Project Timeline: Open dashboard`
  - `Project Timeline: Show summary (Markdown)`
  - `Project Timeline: Export as JSON` / `as CSV`
  - `Project Timeline: Open data folder`
  - `Project Timeline: Recompute rollups`

- **Configuration**: idle timeout, agent grace period, suspend on screen lock, minimum session duration, debounce windows for file edits and diagnostics, custom paths for Claude/Codex session directories.

- **Localization**: UI available in English and French (`l10n`).

### Privacy & security

- No data ever leaves the machine: no account, no backend, no telemetry, no network requests.
- No external commands or processes are spawned; commits go exclusively through the built-in Git extension's API.
- Writes are strictly confined to the extension's storage folder (`events.jsonl`, `heartbeat.json`, `offsets.json`, `git-cursor.json`) — nothing in `.git`, `~/.claude`, `~/.codex`, or the tracked repo.
- Append-only JSONL data model, with conservative crash recovery (work minutes are never invented).

### Known limitations

- Test counting only covers runs in the integrated terminal (shell integration); Vitest/Jest reporter adapters are planned for a later release.
- The Codex CLI session format is still evolving: an `unparsedLines` warning may appear if the parser needs adjusting.
- Codex launched with `--cd` from a subfolder: reattachment by `cwd` covers most cases, but not all.
