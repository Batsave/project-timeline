import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeEvent,
  decodeEvents,
  agentEventId,
  claudeTurnEventId,
  commitEventId,
  liveEventId,
} from '../src/core/jsonl.js';
import { computeRollup } from '../src/core/rollup.js';
import type { TrackEvent } from '../src/core/types.js';

const NOW = Date.parse('2026-08-30T20:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function ev(partial: Partial<TrackEvent> & Pick<TrackEvent, 'eventId' | 'type' | 'payload'>): TrackEvent {
  return {
    ts: iso(3600_000),
    project: 'quests',
    sessionId: 's1',
    ...partial,
  } as TrackEvent;
}

test('decodeEvents déduplique par eventId : même event ×2 -> 1', () => {
  const a = ev({ eventId: 'agent_turn:s1:0', type: 'agent_turn', payload: {} });
  const content = encodeEvent(a) + encodeEvent(a) + encodeEvent(a);
  assert.equal(decodeEvents(content).length, 1);
});

test('agent_session : la version au plus grand byteOffset gagne', () => {
  const early = ev({
    eventId: agentEventId('claude', 'uuid-1', 100),
    type: 'agent_session',
    payload: { agent: 'claude', sessionUuid: 'uuid-1', turns: 3, unparsedLines: 0, costEstimateUSD: 0.1, pricingVersion: 'v1', input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  });
  const late = ev({
    eventId: agentEventId('claude', 'uuid-1', 900),
    type: 'agent_session',
    payload: { agent: 'claude', sessionUuid: 'uuid-1', turns: 7, unparsedLines: 0, costEstimateUSD: 0.5, pricingVersion: 'v1', input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  });
  const decoded = decodeEvents(encodeEvent(early) + encodeEvent(late));
  assert.equal(decoded.length, 2, 'ids différents -> 2 entrées'); // offsets différents = ids différents
  // c’est le rollup qui dédoublonne par sessionUuid ; ici on vérifie surtout qu’aucune n’est perdue
});

test('id helpers', () => {
  assert.equal(agentEventId('codex', 'abc', 42), 'codex:abc:42');
  assert.equal(commitEventId('deadbeef'), 'commit:deadbeef');
  assert.equal(liveEventId('file_edit', 's9', 3), 'file_edit:s9:3');
  assert.equal(claudeTurnEventId('u1', 'msg_A:req_A', 42), 'claude:u1:m:msg_A:req_A');
  assert.equal(claudeTurnEventId('u1', undefined, 42), 'claude:u1:42');
});

test('tour Claude relu après redémarrage (offset différent, même réponse API) -> 1 seul', () => {
  const payload = { agent: 'claude', input: 1, output: 1, cacheCreate: 0, cacheRead: 0 };
  const a = ev({ eventId: claudeTurnEventId('u1', 'msg_A:req_A', 0), type: 'agent_turn', payload });
  const b = ev({ eventId: claudeTurnEventId('u1', 'msg_A:req_A', 812), type: 'agent_turn', payload });
  assert.equal(decodeEvents(encodeEvent(a) + encodeEvent(b)).length, 1);
});

test('computeRollup agrège temps, agents, git, tests, filtre par période', () => {
  const events: TrackEvent[] = [
    ev({
      eventId: 'session:s1:0',
      type: 'session',
      ts: iso(3600_000),
      payload: {
        durationMs: 3600_000,
        focusMs: 3600_000,
        interactionMs: 1800_000,
        agentPresentMs: 2400_000,
        agentOnlyMs: 1800_000,
        focusOnlyMs: 600_000,
        idleMs: 300_000,
      },
    }),
    ev({
      eventId: 'session:old:0',
      type: 'session',
      ts: new Date(NOW - 40 * 24 * 3600_000).toISOString(), // hors période "week"
      payload: {
        durationMs: 9999,
        focusMs: 0,
        interactionMs: 0,
        agentPresentMs: 0,
        agentOnlyMs: 0,
        focusOnlyMs: 0,
        idleMs: 0,
      },
    }),
    ev({
      eventId: agentEventId('claude', 'u1', 0),
      type: 'agent_turn',
      payload: { agent: 'claude', sessionUuid: 'u1', model: 'claude-sonnet-5', input: 10, output: 20, cacheCreate: 5, cacheRead: 100, reasoning: 2, costEstimateUSD: 0.01, pricingVersion: 'v1' },
    }),
    ev({
      eventId: agentEventId('claude', 'u1', 500),
      type: 'agent_session',
      payload: { agent: 'claude', sessionUuid: 'u1', model: 'claude-sonnet-5', cwd: 'B:\\quests', startedAt: iso(3600_000), endedAt: iso(0), turns: 1, input: 10, output: 20, cacheCreate: 5, cacheRead: 100, reasoning: 2, costEstimateUSD: 0.01, pricingVersion: 'v1', unparsedLines: 0 },
    }),
    ev({ eventId: commitEventId('c1'), type: 'commit', payload: { hash: 'c1', message: 'x', author: 'me', branch: 'main', insertions: 40, deletions: 10, filesChanged: 3 } }),
    ev({ eventId: 'test_run:s1:0', type: 'test_run', payload: { passed: 47, failed: 1, skipped: 2, durationMs: 8000, source: 'terminal' } }),
    ev({ eventId: 'file_edit:s1:0', type: 'file_edit', payload: { file: 'src/a.ts', language: 'typescript', linesAdded: 30, linesRemoved: 5 } }),
    ev({ eventId: 'file_fs:s1:0', type: 'file_fs', payload: { file: 'src/new.ts', language: 'typescript', kind: 'create' } }),
  ];

  const r = computeRollup(events, 'quests', 'week', NOW);
  assert.equal(r.time.sessions, 1, 'session hors période exclue');
  assert.equal(r.time.durationMs, 3600_000);
  assert.equal(r.time.agentOnlyMs, 1800_000);
  assert.equal(r.agents.claude.turns, 1);
  assert.equal(r.agents.claude.sessions, 1);
  assert.equal(r.agents.claude.cacheRead, 100);
  assert.equal(r.agents.claude.costEstimateUSD, 0.01);
  assert.equal(r.git.commits, 1);
  assert.equal(r.git.insertions, 40);
  assert.equal(r.counts.testsPassed, 47);
  assert.equal(r.counts.testsFailed, 1);
  assert.equal(r.editor.linesAdded, 30);
  assert.equal(r.editor.fsCreate, 1);
  assert.equal(r.editor.topFiles[0].file, 'src/a.ts');
});
