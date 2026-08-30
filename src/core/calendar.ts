/**
 * Séries calendaires PURES pour le tableau de bord :
 *  - grille contribution façon GitHub (une case par jour, N semaines)
 *  - heatmap jour-de-semaine × heure (quand tu travailles vraiment)
 *  - série quotidienne détaillée (temps, tokens, coût, commits) pour les barres
 *
 * Toutes les dates sont calculées en HEURE LOCALE (getHours/getDay) : on veut savoir
 * quand TU travailles, pas en UTC.
 */
import type { TrackEvent, SessionPayload, AgentTurnPayload, CommitPayload } from './types.js';

export interface DayCell {
  /** 'YYYY-MM-DD' (local) */
  date: string;
  durationMs: number;
  interactionMs: number;
  agentOnlyMs: number;
  claudeTokens: number;
  codexTokens: number;
  costUSD: number;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  sessions: number;
}

export interface CalendarGrid {
  /** semaines, chaque semaine = 7 cellules (dim..sam), la 1re/dernière peuvent être vides. */
  weeks: (DayCell | null)[][];
  firstDate: string;
  lastDate: string;
  maxDurationMs: number;
}

export interface ScheduleHeatmap {
  /** [jourSemaine 0..6 (dim..sam)][heure 0..23] = minutes actives cumulées */
  cells: number[][];
  maxMinutes: number;
  /** total par jour de semaine et par heure, pour les marges */
  byWeekday: number[];
  byHour: number[];
}

const DAY_MS = 24 * 3600_000;

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyCell(date: string): DayCell {
  return {
    date,
    durationMs: 0,
    interactionMs: 0,
    agentOnlyMs: 0,
    claudeTokens: 0,
    codexTokens: 0,
    costUSD: 0,
    commits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    sessions: 0,
  };
}

/** Agrège tous les événements d'un projet en cellules quotidiennes (map date -> cell). */
export function dailyCells(events: TrackEvent[], project: string): Map<string, DayCell> {
  const map = new Map<string, DayCell>();
  const get = (ts: number): DayCell => {
    const key = localDateKey(ts);
    let c = map.get(key);
    if (!c) {
      c = emptyCell(key);
      map.set(key, c);
    }
    return c;
  };

  for (const e of events) {
    if (e.project !== project) continue;
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const c = get(ts);
    switch (e.type) {
      case 'session': {
        const p = e.payload as SessionPayload;
        c.durationMs += p.durationMs ?? 0;
        c.interactionMs += p.interactionMs ?? 0;
        c.agentOnlyMs += p.agentOnlyMs ?? 0;
        c.sessions += 1;
        break;
      }
      case 'agent_turn': {
        const p = e.payload as AgentTurnPayload;
        const tok = (p.input ?? 0) + (p.output ?? 0);
        if (p.agent === 'claude') c.claudeTokens += tok;
        else c.codexTokens += tok;
        if (typeof p.costEstimateUSD === 'number') c.costUSD += p.costEstimateUSD;
        break;
      }
      case 'commit': {
        const p = e.payload as CommitPayload;
        c.commits += 1;
        c.linesAdded += p.insertions ?? 0;
        c.linesRemoved += p.deletions ?? 0;
        break;
      }
      case 'file_edit': {
        const p = e.payload as { linesAdded?: number; linesRemoved?: number };
        c.linesAdded += p.linesAdded ?? 0;
        c.linesRemoved += p.linesRemoved ?? 0;
        break;
      }
    }
  }
  return map;
}

/**
 * Grille contribution : de `startDate` (aligné sur le dimanche précédent) jusqu'à `endTs`.
 * Si `startDate` non fourni, prend la 1re date présente dans les données.
 */
export function buildCalendarGrid(
  cells: Map<string, DayCell>,
  endTs: number,
  startTs?: number,
): CalendarGrid {
  const keys = [...cells.keys()].sort();
  const firstKey = startTs != null ? localDateKey(startTs) : keys[0];
  if (!firstKey) {
    return { weeks: [], firstDate: '', lastDate: '', maxDurationMs: 0 };
  }

  const start = new Date(firstKey + 'T00:00:00');
  // reculer jusqu'au dimanche
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(localDateKey(endTs) + 'T00:00:00');

  const weeks: (DayCell | null)[][] = [];
  let cur = new Date(start);
  let week: (DayCell | null)[] = [];
  let maxDurationMs = 0;
  const firstRealKey = keys[0] ?? firstKey;

  while (cur <= end) {
    const key = localDateKey(cur.getTime());
    const beforeData = key < firstRealKey && startTs == null;
    const cell = beforeData ? null : cells.get(key) ?? emptyCell(key);
    if (cell) maxDurationMs = Math.max(maxDurationMs, cell.durationMs);
    week.push(cell);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cur = new Date(cur.getTime() + DAY_MS);
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  return {
    weeks,
    firstDate: firstRealKey,
    lastDate: localDateKey(endTs),
    maxDurationMs,
  };
}

/** Heatmap jour-de-semaine × heure à partir des sessions (temps réparti sur l'heure de début). */
export function buildScheduleHeatmap(events: TrackEvent[], project: string): ScheduleHeatmap {
  const cells: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const e of events) {
    if (e.project !== project || e.type !== 'session') continue;
    const p = e.payload as SessionPayload;
    const d = new Date(e.ts);
    const wd = d.getDay();
    const h = d.getHours();
    // approximation : on impute la durée à l'heure de début de session.
    cells[wd][h] += (p.durationMs ?? 0) / 60_000;
  }
  let maxMinutes = 0;
  const byWeekday = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const v = cells[wd][h];
      maxMinutes = Math.max(maxMinutes, v);
      byWeekday[wd] += v;
      byHour[h] += v;
    }
  }
  return { cells, maxMinutes, byWeekday, byHour };
}

/** Série quotidienne bornée à N derniers jours (pour les graphes en barres). */
export function dailySeries(
  cells: Map<string, DayCell>,
  endTs: number,
  days: number,
): DayCell[] {
  const out: DayCell[] = [];
  const startKeyTs = endTs - (days - 1) * DAY_MS;
  for (let i = 0; i < days; i++) {
    const key = localDateKey(startKeyTs + i * DAY_MS);
    out.push(cells.get(key) ?? emptyCell(key));
  }
  return out;
}
