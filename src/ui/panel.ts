/**
 * Tableau de bord (Webview). CSP stricte, aucun script/asset externe.
 * Tout est dessiné en SVG / CSS inline (aucune dépendance type Chart.js).
 * Le webview ne fait que RECEVOIR un JSON de rollup ; il n'écrit rien.
 */
import * as vscode from 'vscode';
import type { Store } from '../store/store.js';
import { computeRollup, type Rollup } from '../core/rollup.js';
import {
  dailyCells,
  buildCalendarGridForMonth,
  availableMonths,
  buildScheduleHeatmap,
  dailySeriesNonLinear,
  type DayCell,
  type SeriesPoint,
  type YearMonth,
} from '../core/calendar.js';
import { currentProjectName, currentWorkspaceRoot } from '../workspace.js';
import { computeGitHistoryStats, languageFromPath, type GitHistoryStats } from '../core/gitStats.js';
import { fmtDur, fmtK } from './report.js';

export class Panel {
  private panel?: vscode.WebviewPanel;
  private selectedMonth: YearMonth | undefined;
  private gitHistory: GitHistoryStats | null | undefined;

  constructor(
    private ctx: vscode.ExtensionContext,
    private store: Store,
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.update();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'projectTracker',
      vscode.l10n.t('Project Timeline'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => (this.panel = undefined), null, this.ctx.subscriptions);
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'refresh') void this.update();
      if (msg?.type === 'setMonth') {
        this.selectedMonth = { year: msg.year, month: msg.month };
        void this.update();
      }
    });
    await this.update();
  }

  private async update(): Promise<void> {
    if (!this.panel) return;
    const events = await this.store.readAllEvents();
    const project = currentProjectName();
    const now = Date.now();

    const rollups: Record<string, Rollup> = {
      day: computeRollup(events, project, 'day', now),
      week: computeRollup(events, project, 'week', now),
      month: computeRollup(events, project, 'month', now),
      all: computeRollup(events, project, 'all', now),
    };
    const cells = dailyCells(events, project);
    const months = availableMonths(cells, now);
    const hasSelected =
      this.selectedMonth != null &&
      months.some((m) => m.year === this.selectedMonth!.year && m.month === this.selectedMonth!.month);
    if (!hasSelected) {
      this.selectedMonth = months[0];
    }
    const selectedMonth = this.selectedMonth!;
    const grid = buildCalendarGridForMonth(cells, selectedMonth.year, selectedMonth.month);
    const schedule = buildScheduleHeatmap(events, project);
    const series30 = dailySeriesNonLinear(cells, now, 30);

    // stats git rétroactives (composition langage + fichiers), calculées une
    // fois puis mises en cache pour la session du panel (coûteux : un diff/commit).
    if (this.gitHistory === undefined) {
      const root = currentWorkspaceRoot();
      this.gitHistory = root ? await computeGitHistoryStats(root) : null;
    }

    this.panel.webview.html = render(
      project,
      rollups,
      grid,
      months,
      selectedMonth,
      schedule,
      series30,
      this.gitHistory,
    );
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/* ------------------------------------------------------------------ rendering */

function render(
  project: string,
  rollups: Record<string, Rollup>,
  grid: ReturnType<typeof buildCalendarGridForMonth>,
  months: YearMonth[],
  selectedMonth: YearMonth,
  schedule: ReturnType<typeof buildScheduleHeatmap>,
  series30: SeriesPoint[],
  gitHistory: GitHistoryStats | null,
): string {
  const nonce = String(Math.random()).slice(2) + String(Date.now());
  // style-src reste sur 'unsafe-inline' SEUL (pas de nonce à côté) : un navigateur
  // ignore 'unsafe-inline' dès qu'un nonce est présent sur la même directive, ce qui
  // bloquait silencieusement tous les attributs style="" générés dynamiquement
  // (couleurs de langage, largeurs de barres). Le nonce reste sur script-src, seule
  // directive où il protège vraiment contre l'injection de JS.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const all = rollups.all;
  const est = all.time.estimatedMs;
  const estPct = all.time.durationMs > 0 ? Math.round((est / all.time.durationMs) * 100) : 0;

  const kpis = kpiRow(rollups);
  const calendarSvg = renderCalendar(grid);
  const scheduleSvg = renderSchedule(schedule);
  const timeBars = renderStackedBarsNonLinear(
    series30,
    (d) => [
      { v: d.interactionMs / 3600_000, cls: 's-int' },
      { v: Math.max(0, d.agentOnlyMs) / 3600_000, cls: 's-agent' },
      { v: Math.max(0, d.durationMs - d.interactionMs - d.agentOnlyMs) / 3600_000, cls: 's-idle' },
    ],
    (v) => v.toFixed(1) + ' h',
  );
  const tokenBars = renderStackedBarsNonLinear(
    series30,
    (d) => [
      { v: d.claudeTokens / 1_000_000, cls: 's-int' },
      { v: d.codexTokens / 1_000_000, cls: 's-codex' },
    ],
    (v) => v.toFixed(2) + ' M',
  );
  // composition langage : événements live (précis, court terme) fusionnés avec
  // l'historique git complet (rétroactif) quand disponible, pour couvrir tout
  // le projet même les edits jamais vus par l'éditeur.
  const langSource = gitHistory?.byLanguage.length ? gitHistory.byLanguage : all.editor.byLanguage;
  const langBars = renderLangBars(langSource);
  const agentBlocks = Object.entries(all.agents)
    .map(([name, a]) => renderAgentCard(name, a))
    .join('');
  // fichiers les plus travaillés : rétroactif via git (tout l'historique) si
  // disponible, sinon repli sur les événements live de la semaine.
  const topFiles = gitHistory?.topFiles.length
    ? gitHistory.topFiles.map((f) => ({
        file: f.file,
        linesAdded: f.insertions,
        linesRemoved: f.deletions,
        language: f.language,
      }))
    : rollups.week.editor.topFiles.map((f) => ({
        ...f,
        language: languageFromPath(f.file),
      }));
  const topFilesSourceLabel = gitHistory?.topFiles.length
    ? vscode.l10n.t('Most worked-on files · full git history')
    : vscode.l10n.t('Most worked-on files · 7 d');
  const topFilesLangBar = renderTopFilesLangBar(topFiles);
  const langSourceLabel = gitHistory?.byLanguage.length
    ? vscode.l10n.t('Project composition · languages worked on (full git history)')
    : vscode.l10n.t('Project composition · languages worked on');
  const htmlLang = vscode.env.language.startsWith('fr') ? 'fr' : 'en';

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --muted: color-mix(in srgb, var(--fg) 55%, transparent);
    --border: var(--vscode-panel-border, color-mix(in srgb, var(--fg) 15%, transparent));
    --card: color-mix(in srgb, var(--fg) 4%, var(--bg));
    --accent: var(--vscode-textLink-foreground, #4e94ff);
    --int: #6aa9ff;   /* interaction / claude */
    --agent: #f4a259; /* agent seul */
    --idle: color-mix(in srgb, var(--fg) 20%, transparent);
    --codex: #57c785;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  * {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fg) 28%, transparent) transparent;
  }
  *::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  *::-webkit-scrollbar-track {
    background: transparent;
  }
  *::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--fg) 22%, transparent);
    border: 3px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
  }
  *::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--fg) 34%, transparent);
  }
  *::-webkit-scrollbar-corner {
    background: transparent;
  }
  *::-webkit-scrollbar-button {
    display: none;
    width: 0;
    height: 0;
  }
  body {
    font-family: var(--vscode-font-family);
    margin: 0; padding: 24px 28px 48px;
    color: var(--fg); background: var(--bg);
    font-size: 13px; line-height: 1.5;
  }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
  .project-tag {
    font-size: 12px; padding: 2px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent); font-weight: 600;
  }
  .disclaimer { color: var(--muted); font-size: 11.5px; margin: 6px 0 22px; max-width: 720px; }
  .disclaimer b { color: color-mix(in srgb, var(--fg) 80%, transparent); font-weight: 600; }

  .btn {
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    color: var(--fg); border: 1px solid var(--border);
    padding: 5px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
  }
  .btn:hover { background: color-mix(in srgb, var(--fg) 14%, transparent); }
  .btn:disabled { opacity: 0.35; cursor: default; }
  .btn:disabled:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .btn-icon { padding: 4px 10px; line-height: 1; }

  .year-nav { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .year-controls { display: flex; align-items: center; gap: 8px; }
  .year-label { font-size: 13px; font-weight: 650; min-width: 9em; text-align: center; }

  section { margin-top: 30px; }
  section > h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); font-weight: 650; margin: 0 0 12px;
  }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .kpi {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px;
  }
  .kpi .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .kpi .value { font-size: 22px; font-weight: 650; margin-top: 4px; letter-spacing: -0.02em; }
  .kpi .delta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .badge-est {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 999px;
    background: color-mix(in srgb, var(--agent) 22%, transparent); color: var(--agent);
    font-weight: 600; margin-left: 6px; vertical-align: middle;
  }

  .panel {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px;
    min-width: 0;
  }
  .panel + .panel { margin-top: 14px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: stretch; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
  .grid-2 > .panel { display: flex; flex-direction: column; }
  .grid-2 > .panel .scroll { flex: 0 0 auto; }
  .grid-2 > .panel .legend { margin-top: auto; padding-top: 10px; }

  .scroll {
    overflow-x: auto;
    padding-bottom: 6px;
    min-width: 0;
    scrollbar-gutter: stable;
  }
  .scroll::-webkit-scrollbar {
    height: 8px;
  }
  .scroll::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--accent) 32%, transparent);
    border-width: 2px;
  }
  .scroll::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--accent) 48%, transparent);
  }
  svg { display: block; }
  svg:not(.fluid):not(.fluid-floor) { max-width: none; flex-shrink: 0; }
  svg.fluid { width: 100%; max-width: 100%; height: auto; }
  /* remplit la largeur du panel tant qu'il y a la place ; en dessous de sa
     min-width (posée inline = taille intrinsèque des cases) elle ne rétrécit
     plus et le conteneur .scroll prend le relais avec un scroll horizontal. */
  svg.fluid-floor { width: 100%; flex-shrink: 0; }
  .heatmap-grid {
    display: grid;
    width: 100%;
    flex-shrink: 0;
    column-gap: 3px;
    row-gap: 3px;
    align-items: center;
  }
  .heatmap-label {
    color: var(--muted);
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: clip;
  }
  .heatmap-month { align-self: end; overflow: visible; }
  .heatmap-day { align-self: center; }
  .heatmap-hour { align-self: start; }
  .heatmap-cell {
    min-width: 0;
    border-radius: 3px;
  }
  .calendar-grid { grid-template-rows: 14px repeat(7, 11px) 12px; }
  .calendar-cell { height: 11px; border-radius: 2px; }
  .calendar-legend {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: max-content;
  }
  .calendar-swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .schedule-grid { grid-template-rows: repeat(7, 20px) 11px; }
  .schedule-cell { height: 20px; }
  text { fill: var(--fg); }

  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px; font-size: 11px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .sw-int { background: var(--int); } .sw-agent { background: var(--agent); }
  .sw-idle { background: var(--idle); } .sw-codex { background: var(--codex); }

  table { width: 100%; min-width: max-content; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
  th, td { text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); }
  th:last-child, td:last-child { border-right: none; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }

  .langbar { display: flex; height: 26px; border-radius: 7px; overflow: hidden; border: 1px solid var(--border); }
  .langbar > span { display: block; border-right: 1px solid color-mix(in srgb, var(--bg) 35%, transparent); }
  .langbar > span:last-child { border-right: none; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; vertical-align: -1px; }
  .langlist { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px 16px; font-size: 11.5px; }
  .langlist .dot { margin-right: 6px; }
  .langlist .pct { color: var(--muted); float: right; font-variant-numeric: tabular-nums; }
  .file-color-col { width: 38px; min-width: 38px; padding-right: 0; }
  .file-color {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg) 28%, transparent);
  }
  .file-name { border-left: 3px solid transparent; }

  .agent-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; min-width: 0; }
  .agent-card + .agent-card { margin-top: 12px; }
  .agent-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  .agent-name { font-weight: 650; font-size: 14px; text-transform: capitalize; }
  .agent-cost { font-size: 16px; font-weight: 650; }
  .agent-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .agent-stats .s .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-stats .s .v { font-size: 14px; font-weight: 600; }
  .meter-head { display: flex; align-items: baseline; justify-content: space-between; margin-top: 4px; }
  .meter-head .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .meter-head .v { font-size: 12px; font-weight: 650; color: var(--int); }
  .meter { height: 8px; border-radius: 999px; background: color-mix(in srgb, var(--fg) 12%, transparent); overflow: hidden; margin: 5px 0 12px; }
  .meter > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--int), color-mix(in srgb, var(--int) 60%, var(--codex))); }
  .warn { color: var(--agent); font-size: 11px; }
  .cal-month { font-size: 10px; fill: var(--muted); }
  .cal-wd { font-size: 10px; fill: var(--muted); }
</style>
</head>
<body>
  <header>
    <h1>Project Timeline</h1>
    <span class="project-tag">${escapeHtml(project)}</span>
    <button class="btn" id="refresh">${vscode.l10n.t('Refresh')}</button>
  </header>
  <p class="disclaimer">
    ${vscode.l10n.t('Time dimensions {0} (duration ≠ sum). Costs = {1} (see pricing version). Test counting = {2}.', htmlB(vscode.l10n.t('overlap')), htmlB(vscode.l10n.t('estimate')), htmlB(vscode.l10n.t('experimental')))}
    ${est > 0 ? vscode.l10n.t('{0} of the displayed time comes from {1} (estimated, not measured).', htmlB(estPct + '%'), htmlB(vscode.l10n.t('reconstructed history'))) : ''}
    ${vscode.l10n.t('No data leaves the machine.')}
  </p>

  <section>
    <h2>${vscode.l10n.t('Overview')}</h2>
    <div class="kpis">${kpis}</div>
  </section>

  <section>
    <div class="year-nav">
      <h2 style="margin:0">${vscode.l10n.t('Daily activity')}</h2>
      <div class="year-controls">
        <button class="btn btn-icon" id="monthPrev" ${monthIndex(months, selectedMonth) >= months.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(vscode.l10n.t('Previous month'))}">◀</button>
        <span class="year-label">${escapeHtml(MONTHS_FULL()[selectedMonth.month])} ${selectedMonth.year}</span>
        <button class="btn btn-icon" id="monthNext" ${monthIndex(months, selectedMonth) <= 0 ? 'disabled' : ''} aria-label="${escapeHtml(vscode.l10n.t('Next month'))}">▶</button>
      </div>
    </div>
    <div class="panel scroll auto-scroll-end" id="calendarScroll">${calendarSvg}</div>
  </section>

  <section>
    <h2>${vscode.l10n.t('Work hours')}</h2>
    <div class="panel scroll auto-scroll-end">${scheduleSvg}</div>
  </section>

  <section>
    <div class="grid-2">
      <div class="panel">
        <h2 style="margin-top:0">${vscode.l10n.t('Time per day · 30 d')}</h2>
        <div class="scroll auto-scroll-end">${timeBars}</div>
        <div class="legend">
          <span><i class="sw-int"></i>${vscode.l10n.t('User')}</span>
          <span><i class="sw-agent"></i>${vscode.l10n.t('AI agents')}</span>
          <span><i class="sw-idle"></i>${vscode.l10n.t('Waiting')}</span>
        </div>
        ${est > 0 ? `<div style="color:var(--muted);font-size:10.5px;margin-top:4px">${vscode.l10n.t('Estimated days: approximate split (60/40), no measured focus/idle.')}</div>` : ''}
      </div>
      <div class="panel">
        <h2 style="margin-top:0">${vscode.l10n.t('Tokens per day · 30 d')}</h2>
        <div class="scroll auto-scroll-end">${tokenBars}</div>
        <div class="legend">
          <span><i class="sw-int"></i>Claude</span>
          <span><i class="sw-codex"></i>Codex</span>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>${langSourceLabel}</h2>
    <div class="panel">
      ${langBars || emptyNote(vscode.l10n.t('No editor edits measured yet — reconstructed history does not cover this detail. This section fills in with usage.'))}
    </div>
  </section>

  <section>
    <h2>${vscode.l10n.t('AI agents · full history')}</h2>
    ${agentBlocks || `<div class="panel">${emptyNote(vscode.l10n.t('No Claude Code / Codex CLI session detected for this project.'))}</div>`}
  </section>

  <section>
    <h2>${topFilesSourceLabel}</h2>
    <div class="panel">
      ${
        topFiles.length
          ? `${topFilesLangBar}
            <div class="scroll auto-scroll-end"><table>
              <tr><th></th><th>${vscode.l10n.t('File')}</th><th class="num">${vscode.l10n.t('Lines +/−')}</th></tr>
              ${topFiles
                .map(
                  (f, i) =>
                    `<tr${i >= 10 ? ' class="tf-extra" hidden' : ''}><td class="file-color-col"><span class="dot file-color" style="background:${langColor(f.language)}" title="${escapeHtml(f.language)}"></span></td><td class="file-name" style="border-left-color:${langColor(f.language)}">${escapeHtml(f.file)}</td><td class="num">+${f.linesAdded} / −${f.linesRemoved}</td></tr>`,
                )
                .join('')}
            </table></div>
            ${
              topFiles.length > 10
                ? `<button class="btn" id="tfToggle" style="margin-top:10px">${vscode.l10n.t('Show all ({0})', topFiles.length)}</button>`
                : ''
            }`
          : emptyNote(vscode.l10n.t('No editor edits measured yet this week.'))
      }
    </div>
  </section>

  <script nonce="${nonce}">
    const api = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
    const months = ${JSON.stringify(months)};
    const selectedMonth = ${JSON.stringify(selectedMonth)};
    const mi = months.findIndex((m) => m.year === selectedMonth.year && m.month === selectedMonth.month);
    document.getElementById('monthPrev')?.addEventListener('click', () => {
      if (mi < months.length - 1) api.postMessage({ type: 'setMonth', ...months[mi + 1] });
    });
    document.getElementById('monthNext')?.addEventListener('click', () => {
      if (mi > 0) api.postMessage({ type: 'setMonth', ...months[mi - 1] });
    });
    // affiche directement les données/colonnes les plus récentes quand ça déborde
    document.querySelectorAll('.auto-scroll-end').forEach((el) => {
      el.scrollLeft = el.scrollWidth;
    });

    const tfToggle = document.getElementById('tfToggle');
    const tfShowAllLabel = ${JSON.stringify(vscode.l10n.t('Show all ({0})', topFiles.length))};
    const tfShowLessLabel = ${JSON.stringify(vscode.l10n.t('Show less'))};
    tfToggle?.addEventListener('click', () => {
      const hidden = document.querySelectorAll('.tf-extra');
      const willShow = hidden[0]?.hidden ?? false;
      hidden.forEach((row) => { row.hidden = !willShow; });
      tfToggle.textContent = willShow ? tfShowLessLabel : tfShowAllLabel;
    });
  </script>
</body>
</html>`;
}

function kpiRow(rollups: Record<string, Rollup>): string {
  const w = rollups.week;
  const a = rollups.all;
  const cost = Object.values(a.agents).reduce((s, x) => s + (x.costEstimateUSD ?? 0), 0);
  // hors cache : cacheRead/cacheCreate gonflent artificiellement le total (le
  // même contexte est recompté à chaque tour) — input+output reflète le vrai
  // volume échangé, cohérent avec l'ordre de grandeur du coût affiché.
  const tokens = Object.values(a.agents).reduce((s, x) => s + x.input + x.output, 0);

  const items: Array<[string, string, string]> = [
    [vscode.l10n.t('Time · 7 d'), fmtDur(w.time.durationMs), vscode.l10n.t('{0} sessions', w.time.sessions)],
    [
      vscode.l10n.t('Time · total'),
      fmtDur(a.time.durationMs),
      vscode.l10n.t('longest {0}', fmtDur(a.time.longestSessionMs)),
    ],
    [vscode.l10n.t('Agent alone · 7 d'), fmtDur(w.time.agentOnlyMs), pctOf(w.time.agentOnlyMs, w.time.durationMs)],
    [vscode.l10n.t('Commits · 7 d'), String(w.git.commits), `+${w.git.insertions} / −${w.git.deletions}`],
  ];
  if (tokens > 0) {
    items.push([
      vscode.l10n.t('Tokens (excl. cache) · total'),
      fmtK(tokens),
      vscode.l10n.t('{0} agent(s)', Object.keys(a.agents).length),
    ]);
    items.push([vscode.l10n.t('Estimated cost · total'), '$' + cost.toFixed(2), vscode.l10n.t('estimate')]);
  }
  if (w.counts.testRuns > 0) {
    items.push([
      vscode.l10n.t('Tests · 7 d'),
      `${w.counts.testsPassed}✓ ${w.counts.testsFailed}✗`,
      vscode.l10n.t('{0} runs', w.counts.testRuns),
    ]);
  }
  if (w.editor.linesAdded + w.editor.linesRemoved > 0) {
    items.push([
      vscode.l10n.t('Lines edited · 7 d'),
      `+${w.editor.linesAdded}`,
      vscode.l10n.t('−{0} · {1} files', w.editor.linesRemoved, w.editor.filesEditedInEditor),
    ]);
  }

  return items
    .map(
      ([label, value, delta]) =>
        `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="delta">${delta}</div></div>`,
    )
    .join('');
}

function emptyNote(text: string): string {
  return `<span style="color:var(--muted);font-size:12px">${escapeHtml(text)}</span>`;
}

function pctOf(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return vscode.l10n.t('{0}% of time', Math.round((part / whole) * 100));
}

/* --- GitHub-style contribution grid --- */
function renderCalendar(grid: ReturnType<typeof buildCalendarGridForMonth>): string {
  if (!grid.weeks.length) {
    return `<span style="color:var(--muted)">${vscode.l10n.t('no data yet')}</span>`;
  }
  const cell = 11;
  const gap = 3;
  const left = 30;
  const cols = grid.weeks.length;
  const w = left + cols * (cell + gap) + 10;
  const max = Math.max(grid.maxDurationMs, 1);

  // gris neutre pour un jour SANS ACTIVITÉ (dans la plage de données) —
  // distinct et plus discret que le gris "hors plage / pas encore de données".
  const noActivityFill = 'color-mix(in srgb, var(--fg) 9%, transparent)';
  const outOfRangeFill = 'color-mix(in srgb, var(--fg) 4%, transparent)';
  // 5 paliers discrets (0 = pas d'activité, puis 4 niveaux d'intensité) — même
  // principe que la légende « Less → More » de GitHub, pas un dégradé continu.
  const LEVEL_ALPHA = [0.3, 0.5, 0.7, 1];
  const color = (ms: number): string => {
    if (ms <= 0) return noActivityFill;
    const t = Math.min(1, Math.sqrt(ms / max));
    const level = Math.min(LEVEL_ALPHA.length - 1, Math.floor(t * LEVEL_ALPHA.length));
    return `color-mix(in srgb, var(--accent) ${Math.round(LEVEL_ALPHA[level] * 100)}%, transparent)`;
  };

  let monthLabels = '<div></div>';
  let lastMonth = -1;

  grid.weeks.forEach((week) => {
    const firstReal = week.find((c) => c);
    let monthLabel = '';
    if (firstReal) {
      const mo = new Date(firstReal.date + 'T00:00:00').getMonth();
      if (mo !== lastMonth) {
        lastMonth = mo;
        monthLabel = MONTHS()[mo];
      }
    }
    monthLabels += `<div class="heatmap-label heatmap-month">${escapeHtml(monthLabel)}</div>`;
  });

  let cells = '';
  const wd = ['', WEEKDAYS_SHORT()[1], '', WEEKDAYS_SHORT()[3], '', WEEKDAYS_SHORT()[5], ''];
  for (let di = 0; di < 7; di++) {
    cells += `<div class="heatmap-label heatmap-day">${escapeHtml(wd[di])}</div>`;
    grid.weeks.forEach((week) => {
      const c = week[di];
      if (!c) {
        cells += `<div class="heatmap-cell calendar-cell" style="background:${outOfRangeFill}" title="${escapeHtml(vscode.l10n.t('out of data range'))}"></div>`;
        return;
      }
      const title =
        `${c.date} · ${c.durationMs > 0 ? fmtDur(c.durationMs) : vscode.l10n.t('no activity')}` +
        (c.commits ? ` · ${vscode.l10n.t('{0} commit(s)', c.commits)}` : '') +
        (c.claudeTokens + c.codexTokens ? ` · ${fmtK(c.claudeTokens + c.codexTokens)} tok` : '');
      cells += `<div class="heatmap-cell calendar-cell" style="background:${color(c.durationMs)}" title="${escapeHtml(title)}"></div>`;
    });
  }

  const legend = `<div></div><div class="calendar-legend" style="grid-column:2 / span ${cols}">
    <span class="heatmap-label">${escapeHtml(vscode.l10n.t('less'))}</span>
    ${[0, 0.25, 0.5, 0.75, 1].map((t) => `<span class="calendar-swatch" style="background:${color(t * max)}"></span>`).join('')}
    <span class="heatmap-label">${escapeHtml(vscode.l10n.t('more'))}</span>
  </div>`;

  return `<div class="heatmap-grid calendar-grid" style="min-width:${w}px;grid-template-columns:${left}px repeat(${cols}, minmax(${cell}px, 1fr));" role="img" aria-label="${escapeHtml(vscode.l10n.t('activity grid'))}">
    ${monthLabels}${cells}<div></div>${legend}
  </div>`;
}

/* --- weekday × hour schedule heatmap --- */
function renderSchedule(s: ReturnType<typeof buildScheduleHeatmap>): string {
  const cw = 24;
  const left = 40;
  const w = left + 24 * cw + 10;
  const max = Math.max(s.maxMinutes, 1);
  const days = WEEKDAYS_SHORT();

  // même règle de couleur que la grille d'activité : gris neutre visible pour
  // "aucune activité", puis dégradé de l'accent pour le reste.
  const noActivityFill = 'color-mix(in srgb, var(--fg) 9%, transparent)';
  const daysFull = WEEKDAYS_FULL();
  let rows = '';
  for (let d = 0; d < 7; d++) {
    rows += `<div class="heatmap-label heatmap-day">${escapeHtml(days[d])}</div>`;
    for (let hr = 0; hr < 24; hr++) {
      const v = s.cells[d][hr];
      const fill =
        v <= 0
          ? noActivityFill
          : `color-mix(in srgb, var(--int) ${Math.round((0.22 + Math.sqrt(v / max) * 0.78) * 100)}%, transparent)`;
      const slot = `${String(hr).padStart(2, '0')}h–${String((hr + 1) % 24).padStart(2, '0')}h`;
      const title =
        v <= 0
          ? vscode.l10n.t('{0} {1} · no activity recorded', daysFull[d], slot)
          : vscode.l10n.t('{0} {1} · {2} accumulated', daysFull[d], slot, fmtDur(Math.round(v * 60_000)));
      rows += `<div class="heatmap-cell schedule-cell" style="background:${fill}" title="${escapeHtml(title)}"></div>`;
    }
  }
  let hourLabels = '<div></div>';
  for (let hr = 0; hr < 24; hr += 3) {
    hourLabels += `<div class="heatmap-label heatmap-hour" style="grid-column:${hr + 2}">${hr}h</div>`;
  }
  return `<div class="heatmap-grid schedule-grid" style="min-width:${w}px;grid-template-columns:${left}px repeat(24, minmax(${cw - 2}px, 1fr));" role="img" aria-label="${escapeHtml(vscode.l10n.t('hourly heatmap'))}">
    ${rows}${hourLabels}
  </div>`;
}

/* --- stacked bars with a non-linear axis: consecutive empty days collapse into
   one compact marker instead of eating one full-width slot each. --- */
function renderStackedBarsNonLinear(
  points: SeriesPoint[],
  segsFor: (d: DayCell) => Array<{ v: number; cls: string }>,
  fmtMax: (v: number) => string,
): string {
  const bw = 16;
  const gapBw = 7; // largeur réduite pour un marqueur de jours vides fusionnés
  const gap = 6;
  const left = 34;
  const top = 12;
  const chartH = 130;
  const widths = points.map((p) => (p.isGap ? gapBw : bw));
  const w = left + widths.reduce((s, x) => s + x + gap, 0) + 8;
  const h = top + chartH + 20;
  const max = Math.max(0.0001, ...points.map((p) => segsFor(p.cell).reduce((s, x) => s + x.v, 0)));

  let bars = '';
  let x = left;
  points.forEach((p, i) => {
    const bwEff = widths[i];
    if (p.isGap) {
      const y = top + chartH;
      bars += `<rect x="${x}" y="${y - 3}" width="${bwEff}" height="3" rx="1.5" fill="var(--border)"><title>${escapeHtml(
        vscode.l10n.t('{0} day(s) without activity', p.spanDays),
      )}</title></rect>`;
      if (i % 3 === 0 || points.length < 10) {
        bars += `<text class="cal-wd" x="${x}" y="${top + chartH + 14}">${p.spanDays}j</text>`;
      }
    } else {
      let y = top + chartH;
      segsFor(p.cell).forEach((seg) => {
        const sh = (seg.v / max) * chartH;
        if (sh > 0.3) {
          y -= sh;
          const fill =
            seg.cls === 's-int'
              ? 'var(--int)'
              : seg.cls === 's-agent'
                ? 'var(--agent)'
                : seg.cls === 's-codex'
                  ? 'var(--codex)'
                  : 'var(--idle)';
          bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${bwEff}" height="${sh.toFixed(1)}" rx="2" fill="${fill}"><title>${escapeHtml(
            p.cell.date,
          )}</title></rect>`;
        }
      });
      if (i % 5 === 0) {
        bars += `<text class="cal-wd" x="${x}" y="${top + chartH + 14}">${p.cell.date.slice(5)}</text>`;
      }
    }
    x += bwEff + gap;
  });
  const minW = Math.max(w, 600);
  return `<svg class="fluid-floor" viewBox="0 0 ${minW} ${h}" preserveAspectRatio="none" style="min-width:${minW}px;height:${h}px" role="img">
    <text class="cal-wd" x="0" y="${top + 4}">${fmtMax(max)}</text>
    <line x1="${left - 4}" y1="${top + chartH}" x2="${minW}" y2="${top + chartH}" stroke="var(--border)" />
    ${bars}
  </svg>`;
}

/* --- language composition --- */
const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  typescriptreact: '#3178c6',
  javascript: '#f1e05a',
  javascriptreact: '#f1e05a',
  python: '#3572A5',
  rust: '#dea584',
  go: '#00ADD8',
  scss: '#c6538c',
  sass: '#c6538c',
  css: '#563d7c',
  html: '#e34c26',
  htm: '#e34c26',
  json: '#40c463',
  jsonc: '#40c463',
  markdown: '#5aa7e6',
  mdx: '#5aa7e6',
  prisma: '#5a67d8',
  astro: '#ff5a03',
  svg: '#ffb13b',
  yaml: '#cb171e',
  yml: '#cb171e',
  sql: '#e38c00',
  vue: '#41b883',
  svelte: '#ff3e00',
  java: '#b07219',
  c: '#555555',
  cpp: '#f34b7d',
  csharp: '#178600',
  php: '#4f5d95',
  ruby: '#701516',
  shellscript: '#89e051',
  powershell: '#012456',
  srt: '#9e9e9e',
  txt: '#9e9e9e',
};
// palette de repli déterministe (basée sur le nom) pour tout langage non mappé,
// pour qu'aucune tranche ne tombe dans un gris invisible sur fond sombre.
const FALLBACK_PALETTE = [
  '#e07a5f', '#81b29a', '#f2cc8f', '#3d5a80', '#ee6c4d',
  '#98c1d9', '#c9184a', '#6a994e', '#bc6c25', '#7209b7',
];
function langColor(lang: string): string {
  const known = LANG_COLORS[lang];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < lang.length; i++) hash = (hash * 31 + lang.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}
function renderLangBars(langs: Rollup['editor']['byLanguage']): string {
  if (!langs.length) return '';
  const shown = langs.slice(0, 14);
  const bar = renderProportionBar(shown.map((l) => ({ language: l.language, pct: l.pct })));
  const list = shown
    .map(
      (l) =>
        `<div><span class="dot" style="background:${langColor(l.language)}"></span>${escapeHtml(
          l.language,
        )}<span class="pct">${l.pct.toFixed(1)}%</span></div>`,
    )
    .join('');
  return `<div class="langbar">${bar}</div><div class="langlist">${list}</div>`;
}

/** Barre horizontale proportionnelle générique — une tranche colorée par langage,
 * avec une largeur minimale visible pour ne jamais faire disparaître une petite part. */
function renderProportionBar(parts: Array<{ language: string; pct: number }>): string {
  const minPct = 2.5;
  const totalMin = parts.length * minPct;
  const scale = totalMin < 100 ? (100 - totalMin) / 100 : 0;
  return parts
    .map((l) => {
      const w = minPct + l.pct * scale;
      return `<span style="width:${w.toFixed(2)}%;background:${langColor(l.language)}" title="${escapeHtml(
        l.language,
      )} ${l.pct.toFixed(1)}%"></span>`;
    })
    .join('');
}

/** Mini-barre de répartition globale par type de fichier, au-dessus du tableau
 * « fichiers les plus travaillés » — agrégée sur les lignes touchées (+/−). */
function renderTopFilesLangBar(
  files: Array<{ language: string; linesAdded: number; linesRemoved: number }>,
): string {
  if (!files.length) return '';
  const byLang = new Map<string, number>();
  for (const f of files) {
    byLang.set(f.language, (byLang.get(f.language) ?? 0) + f.linesAdded + f.linesRemoved);
  }
  const total = [...byLang.values()].reduce((s, n) => s + n, 0);
  if (total <= 0) return '';
  const parts = [...byLang.entries()]
    .map(([language, lines]) => ({ language, pct: (lines / total) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 14);
  return `<div class="langbar" style="margin-bottom:14px">${renderProportionBar(parts)}</div>`;
}

/* --- agent cards with per-model token breakdown --- */
function renderAgentCard(name: string, a: Rollup['agents'][string]): string {
  const cachePct = Math.round(a.cacheHitRatio * 100);
  const models = a.byModel
    .map((m) => {
      const tot = m.input + m.output + m.cacheCreate + m.cacheRead;
      return `<tr>
        <td>${escapeHtml(shortModel(m.model))}</td>
        <td class="num">${m.turns}</td>
        <td class="num">${fmtK(m.input)}</td>
        <td class="num">${fmtK(m.output)}</td>
        <td class="num">${fmtK(m.cacheCreate)}</td>
        <td class="num">${fmtK(m.cacheRead)}</td>
        <td class="num">${fmtK(tot)}</td>
        <td class="num">${m.costEstimateUSD == null ? '—' : '$' + m.costEstimateUSD.toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  return `<div class="agent-card">
    <div class="agent-head">
      <span class="agent-name">${escapeHtml(name)}</span>
      <span class="agent-cost">${a.costEstimateUSD == null ? vscode.l10n.t('cost n/a') : '$' + a.costEstimateUSD.toFixed(2)}</span>
    </div>
    <div class="agent-stats">
      <div class="s"><div class="k">${vscode.l10n.t('Sessions')}</div><div class="v">${a.sessions}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Turns')}</div><div class="v">${a.turns}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('No-cache tok.')}</div><div class="v">${fmtK(a.input + a.output)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Input')}</div><div class="v">${fmtK(a.input)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Output')}</div><div class="v">${fmtK(a.output)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Cache hit')}</div><div class="v">${cachePct}%</div></div>
    </div>
    <div class="meter-head">
      <span class="k">${vscode.l10n.t('Share served by cache')}</span>
      <span class="v">${cachePct}%</span>
    </div>
    <div class="meter"><span style="width:${cachePct}%"></span></div>
    ${
      a.byModel.length
        ? `<div class="scroll auto-scroll-end"><table>
            <tr><th>${vscode.l10n.t('Model')}</th><th class="num">${vscode.l10n.t('Turns')}</th><th class="num">In</th><th class="num">Out</th>
              <th class="num">Cache W</th><th class="num">Cache R</th><th class="num">${vscode.l10n.t('Total')}</th><th class="num">${vscode.l10n.t('Cost')}</th></tr>
            ${models}
          </table></div>`
        : ''
    }
    ${a.unparsedLines ? `<div class="warn">⚠️ ${vscode.l10n.t('{0} unparsed session line(s) — parser needs adjusting', a.unparsedLines)}</div>` : ''}
    <div style="color:var(--muted);font-size:10.5px;margin-top:14px">pricing ${a.pricingVersions.join(', ') || 'n/a'}</div>
  </div>`;
}

function shortModel(m: string): string {
  // modèles locaux type "claude-3-freecc-no-thinking/ollama/qwen3-coder:latest"
  const slash = m.lastIndexOf('/');
  if (slash >= 0) return 'local · ' + m.slice(slash + 1);
  return m
    .replace(/^(us|eu|apac)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}$/, '');
}

const MONTHS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
const MONTHS_FULL_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS_SHORT_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const WEEKDAYS_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const WEEKDAYS_FULL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isFrench(): boolean {
  return vscode.env.language.startsWith('fr');
}
function MONTHS(): string[] {
  return isFrench() ? MONTHS_FR : MONTHS_EN;
}
function MONTHS_FULL(): string[] {
  return isFrench() ? MONTHS_FULL_FR : MONTHS_FULL_EN;
}
function monthIndex(months: YearMonth[], m: YearMonth): number {
  return months.findIndex((x) => x.year === m.year && x.month === m.month);
}
function WEEKDAYS_SHORT(): string[] {
  return isFrench() ? WEEKDAYS_SHORT_FR : WEEKDAYS_SHORT_EN;
}
function WEEKDAYS_FULL(): string[] {
  return isFrench() ? WEEKDAYS_FULL_FR : WEEKDAYS_FULL_EN;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function htmlB(s: string): string {
  return `<b>${escapeHtml(s)}</b>`;
}
