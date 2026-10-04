'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTime, isTimezone, isWithinSchedule } = require('../src/core/schedule');

const at = (iso) => new Date(iso);

test('isTime / isTimezone', () => {
  assert.ok(isTime('00:00'));
  assert.ok(isTime('23:59'));
  assert.ok(!isTime('24:00'));
  assert.ok(!isTime('9:00'));
  assert.ok(isTimezone('Europe/Paris'));
  assert.ok(!isTimezone('Mars/Olympus'));
});

test('plage désactivée ou incomplète : toujours active', () => {
  assert.ok(isWithinSchedule({ scheduleEnabled: false, scheduleStart: '10:00', scheduleEnd: '11:00' }, at('2026-01-01T03:00:00Z')));
  assert.ok(isWithinSchedule({ scheduleEnabled: true, scheduleStart: null, scheduleEnd: '11:00' }, at('2026-01-01T03:00:00Z')));
});

test('plage dans la journée (UTC)', () => {
  const settings = { scheduleEnabled: true, scheduleStart: '09:00', scheduleEnd: '18:00', scheduleTimezone: 'UTC' };
  assert.ok(isWithinSchedule(settings, at('2026-01-01T09:00:00Z')));
  assert.ok(isWithinSchedule(settings, at('2026-01-01T17:59:00Z')));
  assert.ok(!isWithinSchedule(settings, at('2026-01-01T18:00:00Z')));
  assert.ok(!isWithinSchedule(settings, at('2026-01-01T08:59:00Z')));
});

test('plage qui traverse minuit', () => {
  const settings = { scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '06:00', scheduleTimezone: 'UTC' };
  assert.ok(isWithinSchedule(settings, at('2026-01-01T23:30:00Z')));
  assert.ok(isWithinSchedule(settings, at('2026-01-01T05:59:00Z')));
  assert.ok(!isWithinSchedule(settings, at('2026-01-01T12:00:00Z')));
});

test('fuseau horaire pris en compte (Paris = UTC+1 en janvier)', () => {
  const settings = { scheduleEnabled: true, scheduleStart: '09:00', scheduleEnd: '10:00', scheduleTimezone: 'Europe/Paris' };
  assert.ok(isWithinSchedule(settings, at('2026-01-15T08:30:00Z')));
  assert.ok(!isWithinSchedule(settings, at('2026-01-15T09:30:00Z')));
});
