import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, type ActivityConfig } from '../src/core/activity.js';

const CFG: ActivityConfig = {
  idleTimeoutMs: 10 * 60_000,
  agentGraceMs: 3 * 60_000,
  minSessionMs: 30_000,
};

function mk() {
  let n = 0;
  return new ActivityTracker(CFG, () => `s_${n++}`);
}

const MIN = 60_000;

test('interaction régulière : session s’accumule, se ferme après idleTimeout sans rien', () => {
  const t = mk();
  let now = 1_000_000;
  // 5 minutes de frappe, un tick par minute
  for (let i = 0; i < 5; i++) {
    now += MIN;
    assert.equal(t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 }), null);
  }
  // 11 minutes sans focus ni frappe ni agent -> doit clôturer
  let flushed = null;
  for (let i = 0; i < 11; i++) {
    now += MIN;
    const f = t.tick({ now, interaction: false, focused: false, lastAgentWriteMs: 0 });
    if (f) flushed = f;
  }
  assert.ok(flushed, 'session clôturée');
  // ~4 min créditées (5 ticks d’1 min, le 1er tick ouvre sans delta)
  assert.ok(flushed!.payload.interactionMs >= 3 * MIN && flushed!.payload.interactionMs <= 5 * MIN);
  assert.equal(flushed!.payload.agentPresentMs, 0);
});

test('agent qui mouline 27 min sans aucune frappe : la session NE se coupe pas', () => {
  const t = mk();
  let now = 2_000_000;
  // ouverture par une frappe
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 });
  let agentWrite = now;
  for (let i = 0; i < 27; i++) {
    now += MIN;
    // l’agent a écrit il y a < agentGrace (on met à jour agentWrite chaque minute)
    agentWrite = now - 10_000;
    const f = t.tick({ now, interaction: false, focused: false, lastAgentWriteMs: agentWrite });
    assert.equal(f, null, `pas de clôture à la minute ${i}`);
  }
  const flushed = t.flush(now + 1);
  assert.ok(flushed);
  assert.ok(flushed!.payload.agentPresentMs >= 25 * MIN, 'temps agent crédité');
  assert.ok(flushed!.payload.agentOnlyMs >= 25 * MIN, 'agentOnly = agent sans interaction');
  assert.equal(flushed!.payload.interactionMs, 0);
});

test('VS Code au premier plan mais aucune frappe : clôture à idleTimeout, pas 4h fantômes', () => {
  const t = mk();
  let now = 3_000_000;
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 });
  let flushed = null;
  // 4 heures de focus seul, sans jamais taper
  for (let i = 0; i < 240; i++) {
    now += MIN;
    const f = t.tick({ now, interaction: false, focused: true, lastAgentWriteMs: 0 });
    if (f) flushed = f;
  }
  assert.ok(flushed, 'la session se ferme');
  // durée créditée bornée autour de idleTimeout (tolérance large)
  assert.ok(
    flushed!.payload.durationMs <= CFG.idleTimeoutMs + MIN,
    `durée ${flushed!.payload.durationMs} <= idleTimeout+1min`,
  );
  assert.ok(flushed!.payload.focusOnlyMs > 0);
});

test('agentGrace : agent silencieux > grâce ET pas de focus -> clôture', () => {
  const t = mk();
  let now = 4_000_000;
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: now });
  const lastWrite = now;
  let flushed = null;
  for (let i = 0; i < 15; i++) {
    now += MIN;
    const f = t.tick({ now, interaction: false, focused: false, lastAgentWriteMs: lastWrite });
    if (f) flushed = f;
  }
  assert.ok(flushed, 'clôturée une fois la grâce agent expirée');
});

test('session trop courte (< minSessionMs) -> pas enregistrée', () => {
  const t = mk();
  let now = 5_000_000;
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 });
  now += 10_000; // 10 s
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 });
  const f = t.flush(now + 1);
  assert.equal(f, null);
});

test('recovery : restore() puis flush() enregistre l’état persisté tel quel', () => {
  const t = mk();
  t.restore({
    sessionId: 's_persisted',
    startedAt: 1000,
    lastTickAt: 4000,
    lastInteractionAt: 4000,
    lastAgentSignalAt: 0,
    acc: {
      durationMs: 8 * MIN,
      focusMs: 8 * MIN,
      interactionMs: 6 * MIN,
      agentPresentMs: 0,
      agentOnlyMs: 0,
      focusOnlyMs: 2 * MIN,
      idleMs: 2 * MIN,
    },
  });
  const f = t.flush(999_999);
  assert.ok(f);
  assert.equal(f!.sessionId, 's_persisted');
  assert.equal(f!.payload.durationMs, 8 * MIN); // rien de reconstruit
});

test('gros écart entre deux ticks (veille) borné à idleTimeout', () => {
  const t = mk();
  let now = 6_000_000;
  t.tick({ now, interaction: true, focused: true, lastAgentWriteMs: 0 });
  now += 3 * 3600_000; // +3h d’un coup, avec un agent actif pour rester alive
  const f = t.tick({ now, interaction: false, focused: true, lastAgentWriteMs: now - 5_000 });
  assert.equal(f, null);
  const flushed = t.flush(now + 1);
  assert.ok(flushed!.payload.durationMs <= CFG.idleTimeoutMs + 1000);
});
