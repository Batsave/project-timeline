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
  buildCalendarGrid,
  buildScheduleHeatmap,
  dailySeries,
  type DayCell,
} from '../core/calendar.js';
import { currentProjectName } from '../workspace.js';
import { fmtDur, fmtK } from './report.js';

export class Panel {
  private panel?: vscode.WebviewPanel;

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
    const grid = buildCalendarGrid(cells, now);
    const schedule = buildScheduleHeatmap(events, project);
    const series30 = dailySeries(cells, now, 30);

    this.panel.webview.html = render(project, rollups, grid, schedule, series30);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/* ------------------------------------------------------------------ rendering */

function render(
  project: string,
  rollups: Record<string, Rollup>,
  grid: ReturnType<typeof buildCalendarGrid>,
  schedule: ReturnType<typeof buildScheduleHeatmap>,
  series30: DayCell[],
): string {
  const nonce = String(Math.random()).slice(2) + String(Date.now());
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  const all = rollups.all;
  const est = all.time.estimatedMs;
  const estPct = all.time.durationMs > 0 ? Math.round((est / all.time.durationMs) * 100) : 0;

  const kpis = kpiRow(rollups);
  const calendarSvg = renderCalendar(grid);
  const scheduleSvg = renderSchedule(schedule);
  const timeBars = renderStackedBars(
    series30.map((d) => ({
      label: d.date.slice(5),
      segs: [
        { v: d.interactionMs / 3600_000, cls: 's-int' },
        { v: Math.max(0, d.agentOnlyMs) / 3600_000, cls: 's-agent' },
        {
          v: Math.max(0, (d.durationMs - d.interactionMs - d.agentOnlyMs)) / 3600_000,
          cls: 's-idle',
        },
      ],
    })),
    (v) => v.toFixed(1) + ' h',
  );
  const tokenBars = renderStackedBars(
    series30.map((d) => ({
      label: d.date.slice(5),
      segs: [
        { v: d.claudeTokens / 1_000_000, cls: 's-int' },
        { v: d.codexTokens / 1_000_000, cls: 's-codex' },
      ],
    })),
    (v) => v.toFixed(2) + ' M',
  );
  const langBars = renderLangBars(all.editor.byLanguage);
  const agentBlocks = Object.entries(all.agents)
    .map(([name, a]) => renderAgentCard(name, a))
    .join('');
  const topFiles = rollups.week.editor.topFiles;
  const htmlLang = vscode.env.language.startsWith('fr') ? 'fr' : 'en';

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
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
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

  .scroll { overflow-x: auto; padding-bottom: 4px; min-width: 0; }
  svg { display: block; max-width: 100%; }
  svg.fluid { width: 100%; height: auto; }
  text { fill: var(--fg); }

  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px; font-size: 11px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .sw-int { background: var(--int); } .sw-agent { background: var(--agent); }
  .sw-idle { background: var(--idle); } .sw-codex { background: var(--codex); }

  table { width: 100%; min-width: max-content; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }

  .langbar { display: flex; height: 22px; border-radius: 7px; overflow: hidden; border: 1px solid var(--border); }
  .langbar > span { display: block; }
  .langlist { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px 16px; font-size: 11.5px; }
  .langlist .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .langlist .pct { color: var(--muted); float: right; font-variant-numeric: tabular-nums; }

  .agent-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; min-width: 0; }
  .agent-card + .agent-card { margin-top: 12px; }
  .agent-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  .agent-name { font-weight: 650; font-size: 14px; text-transform: capitalize; }
  .agent-cost { font-size: 16px; font-weight: 650; }
  .agent-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .agent-stats .s .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .agent-stats .s .v { font-size: 14px; font-weight: 600; }
  .meter { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--fg) 12%, transparent); overflow: hidden; margin: 2px 0 8px; }
  .meter > span { display: block; height: 100%; background: var(--int); }
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
    <h2>${vscode.l10n.t('Daily activity')}</h2>
    <div class="panel scroll" id="calendarScroll">${calendarSvg}</div>
  </section>

  <section>
    <h2>${vscode.l10n.t('Work hours')}</h2>
    <div class="panel scroll">${scheduleSvg}</div>
  </section>

  <section>
    <div class="grid-2">
      <div class="panel">
        <h2 style="margin-top:0">${vscode.l10n.t('Time per day · 30 d')}</h2>
        <div class="scroll">${timeBars}</div>
        <div class="legend">
          <span><i class="sw-int"></i>${vscode.l10n.t('editor interaction')}</span>
          <span><i class="sw-agent"></i>${vscode.l10n.t('agent alone')}</span>
          <span><i class="sw-idle"></i>${vscode.l10n.t('focus / idle')}</span>
        </div>
        ${est > 0 ? `<div style="color:var(--muted);font-size:10.5px;margin-top:4px">${vscode.l10n.t('Estimated days: approximate split (60/40), no measured focus/idle.')}</div>` : ''}
      </div>
      <div class="panel">
        <h2 style="margin-top:0">${vscode.l10n.t('Tokens per day · 30 d')}</h2>
        <div class="scroll">${tokenBars}</div>
        <div class="legend">
          <span><i class="sw-int"></i>Claude</span>
          <span><i class="sw-codex"></i>Codex</span>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>${vscode.l10n.t('Project composition · languages worked on')}</h2>
    <div class="panel">
      ${langBars || emptyNote(vscode.l10n.t('No editor edits measured yet — reconstructed history does not cover this detail. This section fills in with usage.'))}
    </div>
  </section>

  <section>
    <h2>${vscode.l10n.t('AI agents · full history')}</h2>
    ${agentBlocks || `<div class="panel">${emptyNote(vscode.l10n.t('No Claude Code / Codex CLI session detected for this project.'))}</div>`}
  </section>

  <section>
    <h2>${vscode.l10n.t('Most worked-on files · 7 d')}</h2>
    <div class="panel">
      ${
        topFiles.length
          ? `<div class="scroll"><table>
              <tr><th>${vscode.l10n.t('File')}</th><th class="num">${vscode.l10n.t('Lines +/−')}</th></tr>
              ${topFiles
                .map(
                  (f) =>
                    `<tr><td>${escapeHtml(f.file)}</td><td class="num">+${f.linesAdded} / −${f.linesRemoved}</td></tr>`,
                )
                .join('')}
            </table></div>`
          : emptyNote(vscode.l10n.t('No editor edits measured yet this week.'))
      }
    </div>
  </section>

  <script nonce="${nonce}">
    const api = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
    // affiche directement les données récentes (la grille peut être plus large que le panel)
    const calScroll = document.getElementById('calendarScroll');
    if (calScroll) calScroll.scrollLeft = calScroll.scrollWidth;
  </script>
</body>
</html>`;
}

function kpiRow(rollups: Record<string, Rollup>): string {
  const w = rollups.week;
  const a = rollups.all;
  const cost = Object.values(a.agents).reduce((s, x) => s + (x.costEstimateUSD ?? 0), 0);
  const tokens = Object.values(a.agents).reduce((s, x) => s + x.totalTokens, 0);

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
      vscode.l10n.t('Tokens · total'),
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
function renderCalendar(grid: ReturnType<typeof buildCalendarGrid>): string {
  if (!grid.weeks.length) {
    return `<span style="color:var(--muted)">${vscode.l10n.t('no data yet')}</span>`;
  }
  const cell = 15;
  const gap = 4;
  const left = 38;
  const top = 24;
  const cols = grid.weeks.length;
  // largeur minimale : on ne rétrécit jamais en dessous de ~6 mois affichés,
  // pour qu'un historique court ne rende pas une grille ridiculement petite.
  const minCols = 26;
  const effCols = Math.max(cols, minCols);
  const w = left + effCols * (cell + gap) + 10;
  const h = top + 7 * (cell + gap) + 10;
  const max = Math.max(grid.maxDurationMs, 1);
  // les vraies semaines sont ancrées à DROITE (les plus récentes), comme GitHub.
  const offset = effCols - cols;

  // gris neutre pour un jour SANS ACTIVITÉ (dans la plage de données) —
  // distinct et plus discret que le gris "hors plage / pas encore de données".
  const noActivityFill = 'color-mix(in srgb, var(--fg) 9%, transparent)';
  const outOfRangeFill = 'color-mix(in srgb, var(--fg) 4%, transparent)';
  const color = (ms: number): string => {
    if (ms <= 0) return noActivityFill;
    const t = Math.min(1, Math.sqrt(ms / max));
    const alpha = 0.22 + t * 0.78;
    return `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)`;
  };

  let rects = '';
  let monthLabels = '';
  let lastMonth = -1;

  // padding de gauche : colonnes "hors plage" avant le début réel des données,
  // sinon un historique court laisse un grand vide sans case visible.
  for (let wi = 0; wi < offset; wi++) {
    const x = left + wi * (cell + gap);
    for (let di = 0; di < 7; di++) {
      const y = top + di * (cell + gap);
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${outOfRangeFill}"><title>${escapeHtml(vscode.l10n.t('out of data range'))}</title></rect>`;
    }
  }

  grid.weeks.forEach((week, wi) => {
    const x = left + (wi + offset) * (cell + gap);
    const firstReal = week.find((c) => c);
    if (firstReal) {
      const mo = new Date(firstReal.date + 'T00:00:00').getMonth();
      if (mo !== lastMonth) {
        lastMonth = mo;
        monthLabels += `<text class="cal-month" x="${x}" y="14">${MONTHS()[mo]}</text>`;
      }
    }
    week.forEach((c, di) => {
      const y = top + di * (cell + gap);
      if (!c) {
        rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${outOfRangeFill}"><title>${escapeHtml(vscode.l10n.t('out of data range'))}</title></rect>`;
        return;
      }
      const title =
        `${c.date} · ${c.durationMs > 0 ? fmtDur(c.durationMs) : vscode.l10n.t('no activity')}` +
        (c.commits ? ` · ${vscode.l10n.t('{0} commit(s)', c.commits)}` : '') +
        (c.claudeTokens + c.codexTokens ? ` · ${fmtK(c.claudeTokens + c.codexTokens)} tok` : '');
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${color(
        c.durationMs,
      )}"><title>${escapeHtml(title)}</title></rect>`;
    });
  });
  const wd = ['', WEEKDAYS_SHORT()[1], '', WEEKDAYS_SHORT()[3], '', WEEKDAYS_SHORT()[5], ''];
  const wdLabels = wd
    .map((l, i) => (l ? `<text class="cal-wd" x="0" y="${top + i * (cell + gap) + cell - 3}">${l}</text>` : ''))
    .join('');

  const legend = `<g transform="translate(${left}, ${h - 2})">
    <text class="cal-wd" x="0" y="0">${vscode.l10n.t('less')}</text>
    ${[0, 0.25, 0.5, 0.75, 1].map((t, i) => `<rect x="${34 + i * 16}" y="-9" width="${cell - 3}" height="${cell - 3}" rx="2" fill="${color(t * max)}" />`).join('')}
    <text class="cal-wd" x="${34 + 5 * 16 + 4}" y="0">${vscode.l10n.t('more')}</text>
  </g>`;

  return `<svg width="${w}" height="${h + 16}" role="img" aria-label="${escapeHtml(vscode.l10n.t('activity grid'))}">
    ${monthLabels}${wdLabels}${rects}${legend}
  </svg>`;
}

/* --- weekday × hour schedule heatmap --- */
function renderSchedule(s: ReturnType<typeof buildScheduleHeatmap>): string {
  const cw = 24;
  const chh = 22;
  const left = 40;
  const top = 16;
  const w = left + 24 * cw + 10;
  const h = top + 7 * chh + 24;
  const max = Math.max(s.maxMinutes, 1);
  const days = WEEKDAYS_SHORT();

  // même règle de couleur que la grille d'activité : gris neutre visible pour
  // "aucune activité", puis dégradé de l'accent pour le reste.
  const noActivityFill = 'color-mix(in srgb, var(--fg) 9%, transparent)';
  const daysFull = WEEKDAYS_FULL();
  let cells = '';
  for (let d = 0; d < 7; d++) {
    for (let hr = 0; hr < 24; hr++) {
      const v = s.cells[d][hr];
      const x = left + hr * cw;
      const y = top + d * chh;
      const fill =
        v <= 0
          ? noActivityFill
          : `color-mix(in srgb, var(--int) ${Math.round((0.22 + Math.sqrt(v / max) * 0.78) * 100)}%, transparent)`;
      const slot = `${String(hr).padStart(2, '0')}h–${String((hr + 1) % 24).padStart(2, '0')}h`;
      const title =
        v <= 0
          ? vscode.l10n.t('{0} {1} · no activity recorded', daysFull[d], slot)
          : vscode.l10n.t('{0} {1} · {2} accumulated', daysFull[d], slot, fmtDur(Math.round(v * 60_000)));
      cells += `<rect x="${x}" y="${y}" width="${cw - 2}" height="${chh - 2}" rx="3"
        fill="${fill}"><title>${escapeHtml(title)}</title></rect>`;
    }
  }
  const dayLabels = days
    .map((l, i) => `<text class="cal-wd" x="0" y="${top + i * chh + chh - 6}">${l}</text>`)
    .join('');
  let hourLabels = '';
  for (let hr = 0; hr < 24; hr += 3) {
    hourLabels += `<text class="cal-wd" x="${left + hr * cw}" y="${top + 7 * chh + 14}">${hr}h</text>`;
  }
  return `<svg width="${w}" height="${h}" role="img" aria-label="${escapeHtml(vscode.l10n.t('hourly heatmap'))}">
    ${dayLabels}${hourLabels}${cells}
  </svg>`;
}

/* --- generic stacked bars --- */
function renderStackedBars(
  data: Array<{ label: string; segs: Array<{ v: number; cls: string }> }>,
  fmtMax: (v: number) => string,
): string {
  const bw = 16;
  const gap = 6;
  const left = 34;
  const top = 12;
  const chartH = 130;
  const w = left + data.length * (bw + gap) + 8;
  const h = top + chartH + 20;
  const max = Math.max(0.0001, ...data.map((d) => d.segs.reduce((s, x) => s + x.v, 0)));

  let bars = '';
  data.forEach((d, i) => {
    const x = left + i * (bw + gap);
    let y = top + chartH;
    d.segs.forEach((seg) => {
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
        bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${bw}" height="${sh.toFixed(1)}" rx="2" fill="${fill}" />`;
      }
    });
    if (i % 5 === 0) {
      bars += `<text class="cal-wd" x="${x}" y="${top + chartH + 14}">${d.label}</text>`;
    }
  });
  return `<svg class="fluid" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMin meet" role="img">
    <text class="cal-wd" x="0" y="${top + 4}">${fmtMax(max)}</text>
    <line x1="${left - 4}" y1="${top + chartH}" x2="${w}" y2="${top + chartH}" stroke="var(--border)" />
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
  css: '#563d7c',
  html: '#e34c26',
  json: '#8bc34a',
  markdown: '#6a737d',
  prisma: '#0c344b',
};
function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? '#8a8a8a';
}
function renderLangBars(langs: Rollup['editor']['byLanguage']): string {
  if (!langs.length) return '';
  const shown = langs.slice(0, 12);
  const bar = shown
    .map(
      (l) =>
        `<span style="width:${l.pct.toFixed(2)}%;background:${langColor(l.language)}" title="${escapeHtml(
          l.language,
        )} ${l.pct.toFixed(1)}%"></span>`,
    )
    .join('');
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
      <div class="s"><div class="k">${vscode.l10n.t('Tokens')}</div><div class="v">${fmtK(a.totalTokens)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Input')}</div><div class="v">${fmtK(a.input)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Output')}</div><div class="v">${fmtK(a.output)}</div></div>
      <div class="s"><div class="k">${vscode.l10n.t('Cache hit')}</div><div class="v">${cachePct}%</div></div>
    </div>
    <div class="k" style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em">${vscode.l10n.t('Share served by cache')}</div>
    <div class="meter"><span style="width:${cachePct}%"></span></div>
    ${
      a.byModel.length
        ? `<div class="scroll"><table>
            <tr><th>${vscode.l10n.t('Model')}</th><th class="num">${vscode.l10n.t('Turns')}</th><th class="num">In</th><th class="num">Out</th>
              <th class="num">Cache W</th><th class="num">Cache R</th><th class="num">${vscode.l10n.t('Total')}</th><th class="num">${vscode.l10n.t('Cost')}</th></tr>
            ${models}
          </table></div>`
        : ''
    }
    ${a.unparsedLines ? `<div class="warn">⚠️ ${vscode.l10n.t('{0} unparsed session line(s) — parser needs adjusting', a.unparsedLines)}</div>` : ''}
    <div style="color:var(--muted);font-size:10.5px;margin-top:6px">pricing ${a.pricingVersions.join(', ') || 'n/a'}</div>
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
