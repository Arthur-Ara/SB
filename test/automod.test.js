'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, tokenize, levenshtein, similarity, scan } = require('../modules/moderation/lib/automod');

function lists(words, allow = []) {
  return { words: words.map((word, i) => ({ id: i + 1, word })), allowSet: new Set(allow) };
}

test('normalize : accents, majuscules, leet speak, lettres répétées', () => {
  assert.equal(normalize('ÉNÔRME'), 'enorme');
  assert.equal(normalize('c0nn@rd'), 'conard');
  assert.equal(normalize('trèèèès'), 'tres');
  assert.equal(normalize('m!nable'), 'minable');
  assert.equal(normalize('salut!'), 'salut!');
});

test('tokenize : lettres espacées et séparateurs internes', () => {
  assert.ok(tokenize('c o n n a r d').includes('conard'));
  assert.ok(tokenize('co.nn-ard').includes('conard'));
  assert.deepEqual(tokenize('Bonjour à tous'), ['bonjour', 'a', 'tous'].filter((t) => t.length > 1));
});

test('levenshtein et similarité', () => {
  assert.equal(levenshtein('chat', 'chats'), 1);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(similarity('conard', 'conard'), 100);
  assert.ok(similarity('conart', 'conard') >= 80);
  assert.equal(similarity('xconardx', 'conard'), 95);
  assert.equal(similarity('ane', 'ani'), 0, 'mots courts : correspondance exacte uniquement');
});

test('scan : détection, seuil et mots autorisés', () => {
  const banned = lists(['connard']);
  assert.equal(scan('quel c0nnnard celui-là', banned, 80).word, 'connard');
  assert.equal(scan('quel c o n n a r d', banned, 80).score, 100);
  assert.equal(scan('bonne journée à tous', banned, 80), null);
  assert.equal(scan('quel conart', banned, 100), null, 'seuil 100 % : mot exact seulement');
  assert.equal(scan('quel conart', lists(['connard'], ['conart']), 80), null, 'faux positif marqué : ignoré');
  assert.equal(scan('peu importe', lists([]), 80), null);
});
