import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillEvents, needsBackfill, type BackfillCommit } from '../src/core/backfill.js';
import type { TrackEvent } from '../src/core/types.js';

const commit = (hash: string, isoDate: string): BackfillCommit => ({
  hash,
  message: 'msg ' + hash,
  author: 'me',
  branch: 'main',
  isoDate,
  insertions: 10,
  deletions: 3,
  filesChanged: 2,
});

const agentTurn = (ts: string, offset: number): TrackEvent => ({
  eventId: `claude:u1:${offset}`,
  ts,
  project: 'quests',
  sessionId: 'bf_agents',
  type: 'agent_turn',
  payload: { agent: 'claude', sessionUuid: 'u1', model: 'claude-sonnet-5', input: 100, output: 20, costEstimateUSD: 0.01 },
});

test('needsBackfill : vrai si aucune session/agent_turn mesuré (hors bf_)', () => {
  assert.equal(needsBackfill([], 'quests'), true);
  assert.equal(
    needsBackfill([{ eventId: 'commit:a', ts: '2026-01-01', project: 'quests', sessionId: 'bf_git', type: 'commit', payload: {} }], 'quests'),
    true,
    'un commit de backfill ne compte pas comme mesure',
  );
  assert.equal(
    needsBackfill([{ eventId: 'session:s_x:0', ts: '2026-01-01', project: 'quests', sessionId: 's_x', type: 'session', payload: {} }], 'quests'),
    false,
  );
  assert.equal(
    needsBackfill([{ eventId: 'session:bf_2026-01-01:0', ts: '2026-01-01', project: 'quests', sessionId: 'bf_2026-01-01', type: 'session', payload: {} }], 'quests'),
    true,
    'une session estimée de backfill ne compte pas',
  );
});

test('buildBackfillEvents : commits + agents passent, sessions estimées par jour', () => {
  const now = Date.parse('2026-08-30T23:59:00');
  const events = buildBackfillEvents({
    project: 'quests',
    agentEvents: [agentTurn('2026-08-28T10:00:00', 0), agentTurn('2026-08-28T15:00:00', 500)],
    commits: [commit('c1', '2026-08-28T09:00:00'), commit('c2', '2026-08-29T20:00:00')],
    nowTs: now,
  });

  const commits = events.filter((e) => e.type === 'commit');
  assert.equal(commits.length, 2);
  assert.equal(commits[0].eventId, 'commit:c1');

  const turns = events.filter((e) => e.type === 'agent_turn');
  assert.equal(turns.length, 2);

  const sessions = events.filter((e) => e.type === 'session');
  assert.equal(sessions.length, 2, 'un jour avec signal = une session estimée');
  for (const s of sessions) {
    assert.equal((s.payload as any).estimated, true);
    assert.ok(s.sessionId.startsWith('bf_'));
  }
  // le 28 : amplitude 09:00 -> 15:00 = 6h + 45min marge, avec agent -> agentOnly ~ 40%
  const d28 = sessions.find((s) => s.sessionId === 'bf_2026-08-28')!;
  const p28 = d28.payload as any;
  assert.ok(p28.durationMs > 6 * 3600_000 && p28.durationMs <= 12 * 3600_000);
  assert.ok(p28.agentOnlyMs > 0);
  // le 29 : commit seul, pas d'agent -> agentOnly 0
  const d29 = sessions.find((s) => s.sessionId === 'bf_2026-08-29')!;
  assert.equal((d29.payload as any).agentOnlyMs, 0);
});

test('buildBackfillEvents : durée bornée à 12h, plancher 20min pour signal unique', () => {
  const now = Date.parse('2026-09-01T00:00:00');
  const events = buildBackfillEvents({
    project: 'quests',
    agentEvents: [],
    commits: [
      commit('a', '2026-08-20T08:00:00'),
      commit('b', '2026-08-20T23:00:00'), // amplitude 15h -> bornée 12h
      commit('solo', '2026-08-21T12:00:00'),
    ],
    nowTs: now,
  });
  const s20 = events.find((e) => e.sessionId === 'bf_2026-08-20')!;
  assert.equal((s20.payload as any).durationMs, 12 * 3600_000);
  const s21 = events.find((e) => e.sessionId === 'bf_2026-08-21')!;
  assert.equal((s21.payload as any).durationMs, 20 * 60_000);
});

test('buildBackfillEvents : ignore les signaux après nowTs', () => {
  const now = Date.parse('2026-08-28T12:00:00');
  const events = buildBackfillEvents({
    project: 'quests',
    agentEvents: [],
    commits: [commit('future', '2026-08-29T10:00:00')],
    nowTs: now,
  });
  assert.equal(events.filter((e) => e.type === 'session').length, 0);
  assert.equal(events.filter((e) => e.type === 'commit').length, 1); // le commit est gardé
});
