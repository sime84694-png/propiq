// Testovi pristupa plaćenom planu (opcija A: aktivna Stripe pretplata po emailu).
// Pokretanje: node --test 'tests/**/*.test.js'
// Stripe, Anthropic i Netlify Blobs su lažirani — test ne troši ništa i ne treba ključeve.
// Za provjeru na pravom Stripe test modu vidi tests/stripe-testmod.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── lažni Netlify Blobs (u memoriji) ──
const blobs = new Map();
const blobsPath = require.resolve('@netlify/blobs', { paths: [path.join(__dirname, '..')] });
require.cache[blobsPath] = {
  id: blobsPath, filename: blobsPath, loaded: true,
  exports: {
    connectLambda() {},
    getStore(name) {
      return {
        async get(k) { return blobs.get(`${name}/${k}`) ?? null; },
        async set(k, v) { blobs.set(`${name}/${k}`, v); },
        async list() { return { blobs: [] }; },
      };
    },
  },
};

process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.STRIPE_SECRET_KEY = 'sk_test_lazni';
const PRICE_STANDARD = 'price_1UBFCYLx6rQfmJyZJR0AiqCR';
const PRICE_PRO = 'price_1UBFDaLx6rQfmJyZEJFQLicR';

const { handler } = require('../netlify/functions/analiza.js');

// ── lažni Stripe + Anthropic ──
// kupci: { 'email': [{ id, subs: [{ status, price }] }] }
function mockFetch(kupci, { stripeDown = false } = {}) {
  const pozivi = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    pozivi.push(u.pathname + u.search);
    if (u.hostname === 'api.anthropic.com') {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '## Procjena vrijednosti\nTest.' }] }) };
    }
    if (stripeDown) return { ok: false, status: 500, json: async () => ({}) };
    const svi = Object.entries(kupci).flatMap(([email, list]) => list.map((c) => ({ ...c, email })));
    let data = [];
    if (u.pathname === '/v1/customers') {
      data = svi.filter((c) => c.email === u.searchParams.get('email')); // Stripe: točno, razlikuje velika/mala slova
    } else if (u.pathname === '/v1/customers/search') {
      const m = u.searchParams.get('query').match(/email:'(.*)'/);
      data = svi.filter((c) => c.email.toLowerCase() === m[1].toLowerCase());
    } else if (u.pathname === '/v1/subscriptions') {
      const c = svi.find((x) => x.id === u.searchParams.get('customer'));
      data = (c ? c.subs : []).map((s, i) => ({ id: `sub_${i}`, status: s.status, items: { data: [{ price: { id: s.price } }] } }));
    }
    return { ok: true, json: async () => ({ data: data.map((c) => ({ id: c.id, ...c })) }) };
  };
  return pozivi;
}

let n = 0;
async function analiza(email, extra = {}) {
  n += 1;
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ email, oglas_tekst: `Stan ${n}`, ime: 'Test', ...extra }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// Standard ima 10 analiza/mj — 11. odbijena; free ima 3 — 4. odbijena.
async function koliko(email, max = 12, extra) {
  let ok = 0;
  for (let i = 0; i < max; i++) {
    const r = await analiza(email, extra);
    if (r.status !== 200) return { ok, zadnji: r };
    ok++;
  }
  return { ok, zadnji: null };
}

test.beforeEach(() => blobs.clear());

test('bez pretplate: besplatni plan, 3 analize', async () => {
  mockFetch({});
  const r = await koliko('nova@primjer.hr');
  assert.equal(r.ok, 3);
  assert.equal(r.zadnji.status, 403);
});

test('?plan=pro i session_id u zahtjevu NE daju pristup', async () => {
  mockFetch({});
  const r = await koliko('lukav@primjer.hr', 12, { plan: 'pro', session_id: 'cs_test_bilokoji' });
  assert.equal(r.ok, 3);
});

test('aktivna Standard pretplata: 10 analiza mjesečno', async () => {
  mockFetch({ 'ana@primjer.hr': [{ id: 'cus_A', subs: [{ status: 'active', price: PRICE_STANDARD }] }] });
  const r = await koliko('ana@primjer.hr');
  assert.equal(r.ok, 10);
  assert.equal(r.zadnji.status, 403);
  assert.match(r.zadnji.body.error, /10 analiza/);
});

test('aktivna Pro pretplata: neograničeno', async () => {
  mockFetch({ 'pro@primjer.hr': [{ id: 'cus_P', subs: [{ status: 'active', price: PRICE_PRO }] }] });
  const r = await koliko('pro@primjer.hr', 15);
  assert.equal(r.ok, 15);
});

test('trialing daje pristup', async () => {
  mockFetch({ 'trial@primjer.hr': [{ id: 'cus_T', subs: [{ status: 'trialing', price: PRICE_PRO }] }] });
  assert.equal((await koliko('trial@primjer.hr', 5)).ok, 5);
});

for (const status of ['canceled', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'incomplete']) {
  test(`pretplata u statusu ${status}: nema plaćenog pristupa`, async () => {
    mockFetch({ 'bivsi@primjer.hr': [{ id: 'cus_X', subs: [{ status, price: PRICE_PRO }] }] });
    assert.equal((await koliko('bivsi@primjer.hr')).ok, 3);
  });
}

test('stara otkazana Pro + nova aktivna Standard → Standard', async () => {
  mockFetch({ 'mix@primjer.hr': [
    { id: 'cus_1', subs: [{ status: 'canceled', price: PRICE_PRO }] },
    { id: 'cus_2', subs: [{ status: 'active', price: PRICE_STANDARD }] },
  ] });
  assert.equal((await koliko('mix@primjer.hr')).ok, 10);
});

test('email upisan drugačijim velikim/malim slovima i s razmacima', async () => {
  mockFetch({ 'Ana.Kovac@Primjer.hr': [{ id: 'cus_K', subs: [{ status: 'active', price: PRICE_PRO }] }] });
  assert.equal((await koliko('  ana.kovac@primjer.HR ', 12)).ok, 12);
});

test('nepoznata cijena (drugi proizvod) ne daje pristup', async () => {
  mockFetch({ 'drugo@primjer.hr': [{ id: 'cus_D', subs: [{ status: 'active', price: 'price_nesto_drugo' }] }] });
  assert.equal((await koliko('drugo@primjer.hr')).ok, 3);
});

test('Stripe nedostupan: besplatne analize rade, nakon njih jasna poruka (503)', async () => {
  mockFetch({}, { stripeDown: true });
  const r = await koliko('netko@primjer.hr');
  assert.equal(r.ok, 3);
  assert.equal(r.zadnji.status, 503);
});

// ── F5 na rezultat.html: isti request_id ne smije trošiti limit dvaput ──
async function zahtjev(email, requestId, tekst = 'Stan Trešnjevka 58 m2') {
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ email, oglas_tekst: tekst, ime: 'Test', request_id: requestId }),
  });
  return res.statusCode;
}
const iskoristeno = (email) => parseInt(blobs.get(`propiq-free-quota/${email}`) || '0', 10);

test('F5 nakon gotove analize (isti request_id) ne troši limit', async () => {
  mockFetch({});
  assert.equal(await zahtjev('f5@primjer.hr', 'req-aaaa-1111'), 200);
  assert.equal(await zahtjev('f5@primjer.hr', 'req-aaaa-1111'), 200);
  assert.equal(iskoristeno('f5@primjer.hr'), 1);
  assert.equal((await koliko('f5@primjer.hr')).ok, 2);
});

test('F5 dok analiza traje (dva paralelna poziva) broji se jednom', async () => {
  mockFetch({});
  // drugi poziv (nakon F5) završava kasnije od prvoga
  const brziFetch = global.fetch;
  let anthropicPoziva = 0;
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com' && ++anthropicPoziva === 2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return brziFetch(url, opts);
  };
  const s = await Promise.all([zahtjev('par@primjer.hr', 'req-bbbb-2222'), zahtjev('par@primjer.hr', 'req-bbbb-2222')]);
  assert.deepEqual(s, [200, 200]);
  assert.equal(iskoristeno('par@primjer.hr'), 1);
  const stats = [...blobs.entries()].filter(([k]) => k.startsWith('propiq-stats/'));
  assert.equal(stats.length, 1);
  assert.equal(stats[0][1], '1');
});

test('ponavljanje zadnje (3.) analize radi i kad je limit iskorišten', async () => {
  mockFetch({});
  await koliko('treca@primjer.hr', 2);
  assert.equal(await zahtjev('treca@primjer.hr', 'req-cccc-3333'), 200);
  assert.equal(iskoristeno('treca@primjer.hr'), 3);
  assert.equal(await zahtjev('treca@primjer.hr', 'req-cccc-3333'), 200);
  assert.equal(await zahtjev('treca@primjer.hr', 'req-novi-4444'), 403);
});

test('isti request_id nije besplatna analiza: drugi tekst ili više od 2 ponavljanja se broje', async () => {
  mockFetch({});
  await zahtjev('lukav2@primjer.hr', 'req-dddd-5555');
  assert.equal(await zahtjev('lukav2@primjer.hr', 'req-dddd-5555', 'Sasvim drugi oglas'), 200);
  assert.equal(iskoristeno('lukav2@primjer.hr'), 2);
  await zahtjev('lukav2@primjer.hr', 'req-eeee-6666');
  await zahtjev('lukav2@primjer.hr', 'req-eeee-6666');
  await zahtjev('lukav2@primjer.hr', 'req-eeee-6666');
  assert.equal(iskoristeno('lukav2@primjer.hr'), 3);
  assert.equal(await zahtjev('lukav2@primjer.hr', 'req-eeee-6666'), 403);
});
