import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateCost,
  addTokens,
  diffTokens,
  nonZero,
  ZERO_TOKENS,
  type PricingTable,
} from '../src/core/pricing.js';

const table: PricingTable = {
  version: '2026-08-01',
  models: {
    'claude-sonnet-5': { in: 3, out: 15, cacheWriteMult: 1.25, cacheReadMult: 0.1 },
    'gpt-5-codex': { in: 1.25, out: 10, cacheReadMult: 0.1 },
  },
};

test('coût Sonnet : input + output + cache write*1.25 + cache read*0.1', () => {
  const r = estimateCost(
    'claude-sonnet-5',
    { input: 1_000_000, output: 1_000_000, cacheCreate: 1_000_000, cacheRead: 1_000_000 },
    table,
  );
  // 3 + 15 + 3*1.25 + 3*0.1 = 3 + 15 + 3.75 + 0.3 = 22.05
  assert.equal(r.costEstimateUSD, 22.05);
  assert.equal(r.pricingVersion, '2026-08-01');
  assert.equal(r.warning, undefined);
});

test('modèle inconnu -> coût null + warning, version quand même connue', () => {
  const r = estimateCost('mystery-model', { input: 10, output: 10, cacheCreate: 0, cacheRead: 0 }, table);
  assert.equal(r.costEstimateUSD, null);
  assert.equal(r.pricingVersion, '2026-08-01');
  assert.match(r.warning ?? '', /unknown model/);
});

test('normalisation de nom : us.anthropic.claude-sonnet-5-20260101 -> claude-sonnet-5', () => {
  const r = estimateCost(
    'us.anthropic.claude-sonnet-5-20260101',
    { input: 1_000_000, output: 0, cacheCreate: 0, cacheRead: 0 },
    table,
  );
  assert.equal(r.costEstimateUSD, 3);
});

test('pas de table -> null + warning', () => {
  const r = estimateCost('x', ZERO_TOKENS, undefined);
  assert.equal(r.costEstimateUSD, null);
  assert.match(r.warning ?? '', /no pricing table/);
});

test('addTokens somme champ par champ, reasoning inclus', () => {
  const s = addTokens(
    { input: 1, output: 2, cacheCreate: 3, cacheRead: 4, reasoning: 5 },
    { input: 10, output: 20, cacheCreate: 30, cacheRead: 40, reasoning: 50 },
  );
  assert.deepEqual(s, {
    input: 11,
    output: 22,
    cacheCreate: 33,
    cacheCreate1h: 0,
    cacheRead: 44,
    reasoning: 55,
  });
});

test('diffTokens : delta entre deux cumuls, jamais négatif', () => {
  const d = diffTokens(
    { input: 100, output: 50, cacheCreate: 0, cacheRead: 200, reasoning: 10 },
    { input: 80, output: 50, cacheCreate: 0, cacheRead: 150, reasoning: 3 },
  );
  assert.deepEqual(d, {
    input: 20,
    output: 0,
    cacheCreate: 0,
    cacheCreate1h: 0,
    cacheRead: 50,
    reasoning: 7,
  });
});

test('diffTokens : compteur qui recule (reset) -> 0, jamais de tokens inventés', () => {
  const d = diffTokens(
    { input: 5, output: 1, cacheCreate: 0, cacheRead: 0, reasoning: 0 },
    { input: 999, output: 999, cacheCreate: 0, cacheRead: 0, reasoning: 0 },
  );
  assert.deepEqual(d, {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    reasoning: 0,
  });
});

test('nonZero', () => {
  assert.equal(nonZero(ZERO_TOKENS), false);
  assert.equal(nonZero({ ...ZERO_TOKENS, cacheRead: 1 }), true);
});

test('cache 1 h facturé ×2, le reste de cacheCreate ×1.25', () => {
  const r = estimateCost(
    'claude-sonnet-5',
    { input: 0, output: 0, cacheCreate: 2_000_000, cacheCreate1h: 1_000_000, cacheRead: 0 },
    table,
  );
  // 1M × 3 × 1.25 (5 min) + 1M × 3 × 2 (1 h) = 3.75 + 6 = 9.75
  assert.equal(r.costEstimateUSD, 9.75);
});

test('reasoning n’est pas refacturé (déjà inclus dans output)', () => {
  const tokens = { input: 0, output: 1_000_000, cacheCreate: 0, cacheRead: 0 };
  const a = estimateCost('claude-sonnet-5', tokens, table);
  const b = estimateCost('claude-sonnet-5', { ...tokens, reasoning: 800_000 }, table);
  assert.equal(a.costEstimateUSD, b.costEstimateUSD);
});

test('normalisation : suffixe [1m] et variante Bedrock -v1:0 après la date', () => {
  const t = { input: 1_000_000, output: 0, cacheCreate: 0, cacheRead: 0 };
  assert.equal(estimateCost('claude-sonnet-5[1m]', t, table).costEstimateUSD, 3);
  assert.equal(
    estimateCost('anthropic.claude-sonnet-5-20260101-v1:0', t, table).costEstimateUSD,
    3,
  );
});

test('table livrée : chaque modèle Claude courant a un prix', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const shipped = JSON.parse(
    await readFile(path.join(process.cwd(), 'pricing', 'claude.json'), 'utf8'),
  ) as PricingTable;
  const t = { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 };
  for (const m of [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-fable-5-1',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.notEqual(estimateCost(m, t, shipped).costEstimateUSD, null, m);
  }
});
