# Changelog

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
