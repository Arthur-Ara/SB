'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, formatDuration } = require('../src/core/duration');

test('parseDuration : unités françaises et anglaises', () => {
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('30min'), 1800);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d'), 86_400);
  assert.equal(parseDuration('1j'), 86_400);
  assert.equal(parseDuration('2sem'), 1_209_600);
  assert.equal(parseDuration('1w'), 604_800);
  assert.equal(parseDuration('1d12h'), 129_600);
  assert.equal(parseDuration(' 1 j 2 h '), 93_600);
});

test('parseDuration : un nombre seul est en minutes', () => {
  assert.equal(parseDuration('90'), 5400);
});

test('parseDuration : entrées invalides', () => {
  for (const value of ['', 'abc', '10x', '0m', 'h', '5m10', null, undefined]) assert.equal(parseDuration(value), null, String(value));
});

test('formatDuration', () => {
  assert.equal(formatDuration(45), '1 min');
  assert.equal(formatDuration(1800), '30 min');
  assert.equal(formatDuration(3600), '1 h');
  assert.equal(formatDuration(5400), '1 h 30');
  assert.equal(formatDuration(3 * 86_400), '3 j');
  assert.equal(formatDuration(3 * 86_400 + 4 * 3600), '3 j 4 h');
});
