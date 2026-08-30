import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeIncremental } from '../src/core/parse-claude.js';

const FALLBACK = '2026-08-30T00:00:00.000Z';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

const assistant1 = line({
  type: 'assistant',
  timestamp: '2026-08-30T10:00:00.000Z',
  message: {
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 12898,
      cache_read_input_tokens: 24898,
      output_tokens: 1040,
      output_tokens_details: { thinking_tokens: 0 },
    },
  },
});
const nonAssistant = line({ type: 'user', message: { content: 'hi' } });
const assistant2 = line({
  type: 'assistant',
  timestamp: '2026-08-30T10:05:00.000Z',
  message: {
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 1087,
      cache_read_input_tokens: 37796,
      output_tokens: 171,
      output_tokens_details: { thinking_tokens: 0 },
    },
  },
});

test('extrait les tours assistant avec usage, ignore le reste', () => {
  const content = assistant1 + nonAssistant + assistant2;
  const r = parseClaudeIncremental(content, 0, FALLBACK);
  assert.equal(r.turns.length, 2);
  assert.equal(r.unparsedLines, 0);
  assert.deepEqual(r.turns[0].tokens, {
    input: 2,
    output: 1040,
    cacheCreate: 12898,
    cacheRead: 24898,
    reasoning: 0,
  });
  assert.equal(r.turns[0].ts, '2026-08-30T10:00:00.000Z');
  assert.equal(r.turns[0].model, 'claude-sonnet-5');
  assert.equal(r.turns[0].byteOffset, 0);
  assert.equal(r.turns[1].byteOffset, Buffer.byteLength(assistant1 + nonAssistant, 'utf8'));
});

test('incrémental : deuxième passage ne re-lit pas les lignes déjà traitées', () => {
  const content1 = assistant1 + nonAssistant;
  const first = parseClaudeIncremental(content1, 0, FALLBACK);
  assert.equal(first.turns.length, 1);

  const content2 = content1 + assistant2;
  const second = parseClaudeIncremental(content2, first.nextOffset, FALLBACK);
  assert.equal(second.turns.length, 1);
  assert.equal(second.turns[0].ts, '2026-08-30T10:05:00.000Z');
});

test('byteOffset stable entre deux passages -> eventId déterministe', () => {
  const content = assistant1 + nonAssistant + assistant2;
  const full = parseClaudeIncremental(content, 0, FALLBACK);
  const partial = parseClaudeIncremental(content, full.turns[1].byteOffset, FALLBACK);
  assert.equal(partial.turns[0].byteOffset, full.turns[1].byteOffset);
});

test('ligne JSON invalide -> unparsedLines++, pas d’exception', () => {
  const r = parseClaudeIncremental('{ bad json\n' + assistant1, 0, FALLBACK);
  assert.equal(r.unparsedLines, 1);
  assert.equal(r.turns.length, 1);
});

test('ligne assistant sans tokens -> ignorée (pas de tour vide)', () => {
  const empty = line({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } },
  });
  const r = parseClaudeIncremental(empty, 0, FALLBACK);
  assert.equal(r.turns.length, 0);
  assert.equal(r.unparsedLines, 0);
});

test('ligne incomplète (pas de \\n final) reste à re-lire au prochain passage', () => {
  const partialContent = assistant1 + '{"type":"assistant","message":{"usage":{"in';
  const r = parseClaudeIncremental(partialContent, 0, FALLBACK);
  assert.equal(r.turns.length, 1);
  assert.equal(r.nextOffset, Buffer.byteLength(assistant1, 'utf8'));
});
