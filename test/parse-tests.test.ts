import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeTestCommand,
  parseTestOutput,
  stripAnsi,
} from '../src/core/parse-tests.js';

test('reconnaît les commandes de test courantes', () => {
  for (const cmd of [
    'npx vitest run',
    'npm test',
    'pnpm run test:unit',
    'yarn test',
    'jest --coverage',
    'pytest -q',
    'go test ./...',
    'cargo test',
  ]) {
    assert.ok(looksLikeTestCommand(cmd), cmd);
  }
  assert.ok(!looksLikeTestCommand('npm run build'));
  assert.ok(!looksLikeTestCommand('git commit -m test'));
});

test('vitest résumé', () => {
  const out = 'Test Files  3 passed (3)\n Tests  12 passed | 1 failed | 2 skipped (15)\n';
  assert.deepEqual(parseTestOutput(out), { passed: 12, failed: 1, skipped: 2 });
});

test('jest résumé', () => {
  const out = 'Tests:       2 failed, 10 passed, 12 total\n';
  assert.deepEqual(parseTestOutput(out), { passed: 10, failed: 2, skipped: 0 });
});

test('mocha résumé', () => {
  const out = '  40 passing (2s)\n  1 pending\n  3 failing\n';
  assert.deepEqual(parseTestOutput(out), { passed: 40, failed: 3, skipped: 1 });
});

test('pytest résumé', () => {
  const out = '===== 12 passed, 1 failed, 2 skipped in 3.21s =====\n';
  assert.deepEqual(parseTestOutput(out), { passed: 12, failed: 1, skipped: 2 });
});

test('go résumé (compte les lignes)', () => {
  const out = '--- PASS: TestA (0.00s)\n--- PASS: TestB (0.01s)\n--- FAIL: TestC (0.00s)\n';
  assert.deepEqual(parseTestOutput(out), { passed: 2, failed: 1, skipped: 0 });
});

test('sortie non reconnue -> null (on ne fabrique pas de chiffres)', () => {
  assert.equal(parseTestOutput('Build succeeded.\n'), null);
});

test('stripAnsi', () => {
  assert.equal(stripAnsi('[32mok[0m'), 'ok');
});
