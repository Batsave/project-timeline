import * as vscode from 'vscode';
import type { Store } from '../store/store.js';
import { computeRollup, type Rollup } from '../core/rollup.js';
import { currentProjectName } from '../workspace.js';
import { fmtDur, fmtK } from './report.js';

const REFRESH_MS = 5_000;

export class StatusBar {
  private item: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;

  constructor(private store: Store) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'projectTracker.showPanel';
  }

  start(): void {
    this.item.show();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const events = await this.store.readAllEvents();
      const project = currentProjectName();
      const now = Date.now();
      const day = computeRollup(events, project, 'day', now);
      const week = computeRollup(events, project, 'week', now);
      const all = computeRollup(events, project, 'all', now);

      const claude = day.agents.claude?.turns ?? 0;
      const codex = day.agents.codex?.turns ?? 0;
      const tokens =
        (day.agents.claude?.totalTokens ?? 0) + (day.agents.codex?.totalTokens ?? 0);

      const parts = [`$(clock) ${fmtDur(day.time.durationMs)}`, `$(hubot) ${claude + codex}`];
      if (tokens > 0) parts.push(`${fmtK(tokens)} tok`);
      if (day.counts.testsPassed + day.counts.testsFailed > 0) {
        parts.push(`$(check) ${day.counts.testsPassed}`);
      }
      if (day.editor.linesAdded > 0) parts.push(`$(pencil) ${day.editor.linesAdded}`);
      this.item.text = parts.join(' · ');
      this.item.tooltip = buildTooltip(project, day, week, all);
    } catch {
      this.item.text = '$(clock) Project Timeline';
      this.item.tooltip = vscode.l10n.t('Project Timeline — click for the dashboard');
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}

/**
 * Tooltip en table Markdown — les faux "▓░" en texte brut rendent mal dans un
 * tooltip de status bar (police non monospace, wrapping) ; une table Markdown
 * native est correctement alignée par VS Code.
 */
function buildTooltip(project: string, day: Rollup, week: Rollup, all: Rollup): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.supportThemeIcons = true;

  md.appendMarkdown(`**${escapeMd(project)}**\n\n`);

  md.appendMarkdown(`**${vscode.l10n.t('Today')}**\n\n`);
  md.appendMarkdown(periodSummaryTable(day));

  const agents = Object.entries(day.agents);
  if (!agents.length) {
    md.appendMarkdown(`$(circle-slash) ${vscode.l10n.t('No active agent today')}\n\n`);
  }

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(`**${vscode.l10n.t('7 days')}**\n\n`);
  md.appendMarkdown(periodSummaryTable(week));

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(`**${vscode.l10n.t('All time')}**\n\n`);
  md.appendMarkdown(periodSummaryTable(all));

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(`$(graph) *${vscode.l10n.t('Click for the full dashboard')}*`);
  return md;
}

/** Table Markdown à 2 colonnes : Total / Tokens IA / Prix IA pour une période. */
function periodSummaryTable(r: Rollup): string {
  const tokens = Object.values(r.agents).reduce((s, a) => s + a.totalTokens, 0);
  const cost = Object.values(r.agents).reduce(
    (s, a) => (a.costEstimateUSD == null ? s : s + a.costEstimateUSD),
    0,
  );
  const hasCost = Object.values(r.agents).some((a) => a.costEstimateUSD != null);

  let table = '| | |\n|---|---:|\n';
  table += `| ${vscode.l10n.t('Total')} | ${fmtDur(r.time.durationMs)} |\n`;
  table += `| ${vscode.l10n.t('AI tokens')} | ${tokens > 0 ? fmtK(tokens) : '—'} |\n`;
  table += `| ${vscode.l10n.t('AI cost')} | ${hasCost ? '$' + cost.toFixed(2) : '—'} |\n\n`;
  return table;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
