import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateAgentHistory,
  hasStaleAgentEvents,
  agentSessionsIn,
  sessionKey,
  type ReparsedSession,
} from '../src/core/migrate.js';
import type { PricingTable } from '../src/core/pricing.js';
import { AGENT_CALC_VERSION, type TrackEvent } from '../src/core/types.js';

const pricing: Record<'claude' | 'codex', PricingTable> = {
  claude: { version: 'p2', models: { 'claude-sonnet-5': { in: 2, out: 10 } } },
  codex: { version: 'p2', models: { 'gpt-5-codex': { in: 1, out: 10, cacheReadMult: 0.1 } } },
};

function turn(
  agent: 'claude' | 'codex',
  uuid: string,
  offset: number,
  t: { input: number; output: number; cacheCreate?: number; cacheRead?: number },
  extra: Record<string, unknown> = {},
): TrackEvent {
  return {
    eventId: `${agent}:${uuid}:${offset}`,
    ts: `2026-08-01T10:00:${String(offset % 60).padStart(2, '0')}.000Z`,
    project: 'quests',
    sessionId: 'live1',
    type: 'agent_turn',
    payload: {
      agent,
      sessionUuid: uuid,
      model: agent === 'claude' ? 'claude-sonnet-5' : 'gpt-5-codex',
      input: t.input,
      output: t.output,
      cacheCreate: t.cacheCreate ?? 0,
      cacheRead: t.cacheRead ?? 0,
      costEstimateUSD: 999,
      pricingVersion: 'old',
      ...extra,
    },
  };
}

function session(agent: 'claude' | 'codex', uuid: string, offset: number): TrackEvent {
  return {
    eventId: `${agent}:${uuid}:${offset}`,
    ts: '2026-08-01T11:00:00.000Z',
    project: 'quests',
    sessionId: 'live1',
    type: 'agent_session',
    payload: {
      agent,
      sessionUuid: uuid,
      model: 'x',
      cwd: 'B:\\quests',
      startedAt: '2026-08-01T09:00:00.000Z',
      endedAt: '2026-08-01T11:00:00.000Z',
      turns: 99,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      costEstimateUSD: 999,
      pricingVersion: 'old',
      unparsedLines: 2,
    },
  };
}

const commit: TrackEvent = {
  eventId: 'commit:abc',
  ts: '2026-08-01T12:00:00.000Z',
  project: 'quests',
  sessionId: 'live1',
  type: 'commit',
  payload: { hash: 'abc' },
};

const turnsOf = (evs: TrackEvent[]) => evs.filter((e) => e.type === 'agent_turn');
const sessionsOf = (evs: TrackEvent[]) => evs.filter((e) => e.type === 'agent_session');
const p = (e: TrackEvent) => e.payload as any;

test('hasStaleAgentEvents : vrai si un événement agent n’a pas la version courante', () => {
  assert.equal(hasStaleAgentEvents([commit]), false);
  assert.equal(hasStaleAgentEvents([turn('claude', 'a', 0, { input: 1, output: 1 })]), true);
  const fresh = turn('claude', 'a', 0, { input: 1, output: 1 }, { calcVersion: AGENT_CALC_VERSION });
  assert.equal(hasStaleAgentEvents([fresh, commit]), false);
});

test('Claude orphelin : doublons consécutifs retirés, cache supposé 1 h, coût recalculé', () => {
  const dup = { input: 3, output: 400, cacheCreate: 1_000_000, cacheRead: 0 };
  const events = [
    commit,
    // ordre du fichier = offset ; l'ordre dans la log peut différer
    turn('claude', 'a', 300, { input: 5, output: 10 }),
    turn('claude', 'a', 0, dup),
    turn('claude', 'a', 100, dup),
    turn('claude', 'a', 200, dup),
    session('claude', 'a', 100),
    session('claude', 'a', 300),
  ];
  const r = migrateAgentHistory({ events, pricing, reparsed: new Map() });
  const turns = turnsOf(r.events);
  assert.equal(turns.length, 2);
  assert.equal(r.upgradedSessions, 1);
  const big = turns.find((e) => p(e).cacheCreate === 1_000_000)!;
  assert.equal(p(big).cacheCreate1h, 1_000_000);
  assert.equal(p(big).calcVersion, AGENT_CALC_VERSION);
  // 3×2 + 400×10 + 1M×2×2 (1 h) = 6 + 4000 + 4_000_000 -> /1M
  assert.equal(p(big).costEstimateUSD, 4.004);
  assert.equal(p(big).pricingVersion, 'p2');

  const sessions = sessionsOf(r.events);
  assert.equal(sessions.length, 1, 'une seule version d’agent_session');
  assert.equal(sessions[0].eventId, 'claude:a:300', 'id de la version la plus récente');
  assert.equal(p(sessions[0]).turns, 2);
  assert.equal(p(sessions[0]).output, 410);
  assert.equal(p(sessions[0]).cwd, 'B:\\quests');
  assert.equal(p(sessions[0]).unparsedLines, 2);
  assert.ok(r.events.includes(commit), 'événements non-agents intacts');
});

test('Codex orphelin : le cache est retiré de input', () => {
  const events = [turn('codex', 'c', 0, { input: 15106, output: 88, cacheRead: 3072 })];
  const r = migrateAgentHistory({ events, pricing, reparsed: new Map() });
  assert.equal(p(turnsOf(r.events)[0]).input, 15106 - 3072);
  assert.equal(p(turnsOf(r.events)[0]).cacheRead, 3072);
});

test('idempotent : migrer deux fois ne corrige pas deux fois', () => {
  const events = [
    turn('codex', 'c', 0, { input: 100, output: 1, cacheRead: 40 }),
    turn('claude', 'a', 0, { input: 1, output: 1 }),
    turn('claude', 'a', 50, { input: 1, output: 1 }),
  ];
  const once = migrateAgentHistory({ events, pricing, reparsed: new Map() });
  const twice = migrateAgentHistory({ events: once.events, pricing, reparsed: new Map() });
  assert.deepEqual(twice.events, once.events);
  assert.equal(hasStaleAgentEvents(once.events), false);
});

test('source présente : les tours stockés sont remplacés par le re-parse exact', () => {
  const events = [
    turn('claude', 'a', 0, { input: 1, output: 1 }),
    turn('claude', 'a', 100, { input: 1, output: 1 }),
    turn('claude', 'a', 200, { input: 1, output: 1 }),
    session('claude', 'a', 200),
  ];
  const reparsed = new Map<string, ReparsedSession>([
    [
      sessionKey('claude', 'a'),
      {
        nextOffset: 250,
        unparsedLines: 0,
        turns: [
          {
            byteOffset: 0,
            messageId: 'msg_1:req_1',
            ts: '2026-08-01T10:00:00.000Z',
            model: 'claude-sonnet-5',
            tokens: { input: 1, output: 1, cacheCreate: 10, cacheCreate1h: 4, cacheRead: 0 },
          },
        ],
      },
    ],
  ]);
  const r = migrateAgentHistory({ events, pricing, reparsed });
  const turns = turnsOf(r.events);
  assert.equal(r.reparsedSessions, 1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].eventId, 'claude:a:m:msg_1:req_1');
  assert.equal(turns[0].project, 'quests');
  assert.equal(turns[0].sessionId, 'live1');
  assert.equal(p(turns[0]).cacheCreate1h, 4, 'vrai détail 5 min / 1 h, pas l’hypothèse');
  assert.equal(sessionsOf(r.events)[0].eventId, 'claude:a:250');
  assert.equal(r.droppedEvents, 2);
});

test('agentSessionsIn liste chaque session une fois', () => {
  const s = agentSessionsIn([
    turn('claude', 'a', 0, { input: 1, output: 1 }),
    session('claude', 'a', 0),
    turn('codex', 'c', 0, { input: 1, output: 1 }),
    commit,
  ]);
  assert.deepEqual(s, [
    { agent: 'claude', uuid: 'a' },
    { agent: 'codex', uuid: 'c' },
  ]);
});
