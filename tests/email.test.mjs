// Normalizacija e-maila za besplatnu kvotu, blokada jednokratnih adresa i iznimka za lokalni razvoj.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizirajEmail, jeJednokratnaAdresa } from '../netlify/lib/email.mjs';

const PROD = { CONTEXT: 'production' };
const DEV = { CONTEXT: 'dev' };

test('Gmail: točke i +alias se uklanjaju, domena velikim slovima i googlemail se svode', () => {
  assert.equal(normalizirajEmail('A.B+x@GMail.com', PROD), 'ab@gmail.com');
  assert.equal(normalizirajEmail('  a.b.c@googlemail.com ', PROD), 'abc@gmail.com');
  assert.equal(normalizirajEmail('ab+1+2@gmail.com', PROD), 'ab@gmail.com');
});

test('ostale domene: uklanja se samo +alias, točke ostaju', () => {
  assert.equal(normalizirajEmail('Ime.Prezime+test@Primjer.hr', PROD), 'ime.prezime@primjer.hr');
});

test('deploy preview i bez CONTEXT-a nemaju iznimku', () => {
  assert.equal(normalizirajEmail('a.b+x@gmail.com', { CONTEXT: 'deploy-preview' }), 'ab@gmail.com');
  assert.equal(normalizirajEmail('a.b+x@gmail.com', {}), 'ab@gmail.com');
});

test('CONTEXT=dev: aliasi se ne svode (samo lowercase + trim)', () => {
  assert.equal(normalizirajEmail('A.B+propiq1@GMail.com ', DEV), 'a.b+propiq1@gmail.com');
});

test('rubni slučajevi: bez @ i prazan lokalni dio ostaju netaknuti', () => {
  assert.equal(normalizirajEmail('nije-email', PROD), 'nije-email');
  assert.equal(normalizirajEmail('+x@gmail.com', PROD), '+x@gmail.com');
});

test('jednokratne domene se prepoznaju, obične ne', () => {
  assert.equal(jeJednokratnaAdresa('x@Mailinator.com'), true);
  assert.equal(jeJednokratnaAdresa('x@yopmail.com'), true);
  assert.equal(jeJednokratnaAdresa('x@gmail.com'), false);
});
