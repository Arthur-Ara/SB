'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyedMutex } = require('../src/core/keyedMutex');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('les tâches d’une même clé s’exécutent une par une, dans l’ordre', async () => {
  const mutex = new KeyedMutex();
  const order = [];
  await Promise.all([
    mutex.run('a', async () => {
      await sleep(20);
      order.push(1);
    }),
    mutex.run('a', async () => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);
});

test('une erreur ne bloque pas la tâche suivante et la chaîne est libérée', async () => {
  const mutex = new KeyedMutex();
  await assert.rejects(mutex.run('k', async () => {
    throw new Error('boom');
  }));
  assert.equal(await mutex.run('k', async () => 42), 42);
  await sleep(0);
  assert.equal(mutex.chains.size, 0);
});

test('des clés différentes ne s’attendent pas', async () => {
  const mutex = new KeyedMutex();
  const order = [];
  await Promise.all([
    mutex.run('x', async () => {
      await sleep(20);
      order.push('x');
    }),
    mutex.run('y', async () => {
      order.push('y');
    }),
  ]);
  assert.deepEqual(order, ['y', 'x']);
});
