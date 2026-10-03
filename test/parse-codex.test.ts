import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexIncremental } from '../src/core/parse-codex.js';

const FALLBACK = '2026-07-20T00:00:00.000Z';
const nl = (o: unknown) => JSON.stringify(o) + '\n';

const meta = nl({
  timestamp: '2026-07-19T22:36:41.026Z',
  type: 'session_meta',
  payload: { cwd: 'B:\\quests', model_provider: 'openai', model: 'gpt-5-codex', cli_version: '0.145.0' },
});

test('lit session_meta : cwd + model', () => {
  const r = parseCodexIncremental(meta, 0, FALLBACK);
  assert.equal(r.meta?.cwd, 'B:\\quests');
  assert.equal(r.meta?.model, 'gpt-5-codex');
  assert.equal(r.turns.length, 0);
});

test('token_usage (delta) — forme observée sur la machine ; input hors cache', () => {
  const usage = nl({
    timestamp: '2026-07-19T22:40:00.000Z',
    token_usage: {
      input_tokens: 15106,
      cached_input_tokens: 3072,
      cache_write_input_tokens: 0,
      output_tokens: 88,
      reasoning_output_tokens: 70,
      total_tokens: 15194,
    },
  });
  const r = parseCodexIncremental(meta + usage, 0, FALLBACK);
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].isCumulative, false);
  // total_tokens (15194) = input_tokens + output_tokens : le cache est DANS input_tokens
  assert.deepEqual(r.turns[0].tokens, {
    input: 15106 - 3072,
    output: 88,
    cacheCreate: 0,
    cacheRead: 3072,
    reasoning: 70,
  });
});

test('total_token_usage sous payload.info -> marqué cumulatif', () => {
  const usage = nl({
    payload: {
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 145,
        },
      },
    },
  });
  const r = parseCodexIncremental(usage, 0, FALLBACK);
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].isCumulative, true);
  assert.equal(r.turns[0].tokens.input, 90); // 100 - 10 en cache
  assert.equal(r.turns[0].tokens.cacheRead, 10);
});

test('last_token_usage prioritaire sur token_usage si les deux présents (delta)', () => {
  const usage = nl({
    last_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    token_usage: { input_tokens: 999, output_tokens: 999 },
  });
  const r = parseCodexIncremental(usage, 0, FALLBACK);
  // total_* absent -> on prend last_* (cumulatif=false), input=5
  assert.equal(r.turns[0].tokens.input, 5);
  assert.equal(r.turns[0].isCumulative, false);
});

test('ligne sans comptage -> ignorée, pas unparsed', () => {
  const r = parseCodexIncremental(nl({ type: 'message', payload: { text: 'hello' } }), 0, FALLBACK);
  assert.equal(r.turns.length, 0);
  assert.equal(r.unparsedLines, 0);
});

test('JSON cassé -> unparsedLines++', () => {
  const r = parseCodexIncremental('nope\n' + meta, 0, FALLBACK);
  assert.equal(r.unparsedLines, 1);
  assert.ok(r.meta);
});

test('incrémental via nextOffset', () => {
  const u1 = nl({ token_usage: { input_tokens: 1, output_tokens: 1 } });
  const u2 = nl({ token_usage: { input_tokens: 2, output_tokens: 2 } });
  const first = parseCodexIncremental(meta + u1, 0, FALLBACK);
  const second = parseCodexIncremental(meta + u1 + u2, first.nextOffset, FALLBACK);
  assert.equal(second.turns.length, 1);
  assert.equal(second.turns[0].tokens.input, 2);
});

test('cache > input (donnée incohérente) -> input borné à 0, jamais négatif', () => {
  const r = parseCodexIncremental(
    nl({ token_usage: { input_tokens: 5, cached_input_tokens: 8, output_tokens: 1 } }),
    0,
    FALLBACK,
  );
  assert.equal(r.turns[0].tokens.input, 0);
  assert.equal(r.turns[0].tokens.cacheRead, 8);
});
