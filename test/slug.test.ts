import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectPathToClaudeSlug,
  isCwdUnder,
  normalizePathForCompare,
} from '../src/core/slug.js';

test('B:\\quests -> b--quests (règle Claude Code réelle)', () => {
  assert.equal(projectPathToClaudeSlug('B:\\quests'), 'b--quests');
});

test('chemin POSIX', () => {
  assert.equal(projectPathToClaudeSlug('/home/dj/work/quests'), 'home-dj-work-quests');
});

test('B:\\Auralis-Transmission -> b--auralis-transmission (les - du nom sont gardés)', () => {
  assert.equal(
    projectPathToClaudeSlug('B:\\Auralis-Transmission'),
    'b--auralis-transmission',
  );
});

test('pas de tiret en tête / queue', () => {
  assert.equal(projectPathToClaudeSlug('C:\\Users\\x\\'), 'c--users-x');
});

test('isCwdUnder : workspace lui-même et sous-dossier, casse Windows ignorée', () => {
  assert.ok(isCwdUnder('B:\\quests', 'B:\\quests'));
  assert.ok(isCwdUnder('B:\\quests', 'b:\\Quests\\backend\\src'));
  assert.ok(!isCwdUnder('B:\\quests', 'B:\\quests-other'));
  assert.ok(!isCwdUnder('B:\\quests', 'B:\\autre'));
});

test('normalizePathForCompare', () => {
  assert.equal(normalizePathForCompare('B:\\a\\b\\'), 'b:/a/b');
});
