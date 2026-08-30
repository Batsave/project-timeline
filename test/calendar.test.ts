import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyCells,
  buildCalendarGrid,
  buildScheduleHeatmap,
  dailySeries,
} from '../src/core/calendar.js';
import type { TrackEvent } from '../src/core/types.js';

function ev(ts: string, type: TrackEvent['type'], payload: unknown): TrackEvent {
  return { eventId: `${type}:${ts}`, ts, project: 'quests', sessionId: 's', type, payload };
}

const session = (ts: string, durationMin: number, interMin = 0, agentOnlyMin = 0) =>
  ev(ts, 'session', {
    durationMs: durationMin * 60_000,
    focusMs: durationMin * 60_000,
    interactionMs: interMin * 60_000,
    agentPresentMs: agentOnlyMin * 60_000,
    agentOnlyMs: agentOnlyMin * 60_000,
    focusOnlyMs: 0,
    idleMs: 0,
  });

test('dailyCells regroupe par jour local et agrège durée/tokens/commits', () => {
  const events = [
    session('2026-08-28T10:00:00', 60, 40, 20),
    session('2026-08-28T20:00:00', 30, 30, 0),
    ev('2026-08-28T21:00:00', 'agent_turn', {
      agent: 'claude',
      input: 100,
      output: 50,
      costEstimateUSD: 0.02,
    }),
    ev('2026-08-28T22:00:00', 'commit', { hash: 'a', insertions: 10, deletions: 2 }),
    session('2026-08-29T09:00:00', 15, 15, 0),
  ];
  const cells = dailyCells(events, 'quests');
  const d28 = cells.get('2026-08-28')!;
  assert.equal(d28.durationMs, 90 * 60_000);
  assert.equal(d28.sessions, 2);
  assert.equal(d28.claudeTokens, 150);
  assert.equal(d28.costUSD, 0.02);
  assert.equal(d28.commits, 1);
  assert.equal(d28.linesAdded, 10);
  assert.equal(cells.get('2026-08-29')!.durationMs, 15 * 60_000);
});

test('buildCalendarGrid : semaines de 7, aligné dimanche, cases pré-données = null', () => {
  const events = [session('2026-08-28T10:00:00', 60)]; // vendredi
  const cells = dailyCells(events, 'quests');
  const end = Date.parse('2026-08-30T12:00:00'); // dimanche
  const grid = buildCalendarGrid(cells, end);
  assert.ok(grid.weeks.length >= 1);
  for (const w of grid.weeks) assert.equal(w.length, 7);
  // la première semaine commence un dimanche : les jours avant le 28 sont null
  const firstWeek = grid.weeks[0];
  assert.equal(firstWeek[5]?.date, '2026-08-28'); // index 5 = vendredi
  assert.equal(firstWeek[0], null); // dimanche 23, avant les données
  assert.equal(grid.maxDurationMs, 60 * 60_000);
});

test('buildScheduleHeatmap : impute la durée au (jour, heure) de début', () => {
  const events = [
    session('2026-08-28T14:00:00', 60), // vendredi (getDay=5) 14h
    session('2026-08-28T14:30:00', 30), // même bucket
    session('2026-08-30T02:00:00', 120), // dimanche (getDay=0) 2h
  ];
  const s = buildScheduleHeatmap(events, 'quests');
  assert.equal(s.cells[5][14], 90); // 60 + 30 minutes
  assert.equal(s.cells[0][2], 120);
  assert.equal(s.maxMinutes, 120);
  assert.equal(s.byWeekday[5], 90);
  assert.equal(s.byHour[14], 90);
});

test('dailySeries : exactement N jours, remplit les jours vides', () => {
  const events = [session('2026-08-29T10:00:00', 45)];
  const cells = dailyCells(events, 'quests');
  const series = dailySeries(cells, Date.parse('2026-08-30T00:00:00'), 7);
  assert.equal(series.length, 7);
  assert.equal(series[6].date, '2026-08-30');
  const d29 = series.find((d) => d.date === '2026-08-29')!;
  assert.equal(d29.durationMs, 45 * 60_000);
});

test('filtre par projet', () => {
  const events = [
    session('2026-08-28T10:00:00', 60),
    { ...session('2026-08-28T11:00:00', 999), project: 'autre' } as TrackEvent,
  ];
  const cells = dailyCells(events, 'quests');
  assert.equal(cells.get('2026-08-28')!.durationMs, 60 * 60_000);
});
