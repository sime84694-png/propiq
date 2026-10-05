// Testovi pristupa plaćenom planu (opcija A: aktivna Stripe pretplata po emailu) i streama analize.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'
// Stripe, Anthropic i Netlify Blobs su lažirani — test ne troši ništa i ne treba ključeve.
// Za provjeru na pravom Stripe test modu vidi tests/stripe-testmod.mjs.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── lažni Netlify Blobs (u memoriji) ──
const blobs = new Map();
mock.module('@netlify/blobs', {
  namedExports: {
    getStore(name) {
      return {
        async get(k) { return blobs.get(`${name}/${k}`) ?? null; },
        async set(k, v) { blobs.set(`${name}/${k}`, v); },
        async list({ prefix = '' } = {}) {
          const p = `${name}/${prefix}`;
          return { blobs: [...blobs.keys()].filter((k) => k.startsWith(p)).map((k) => ({ key: k.slice(name.length + 1) })) };
        },
        async delete(k) { blobs.delete(`${name}/${k}`); },
      };
    },
  },
});

process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.STRIPE_SECRET_KEY = 'sk_test_lazni';
const PRICE_STANDARD = 'price_1UBFCYLx6rQfmJyZJR0AiqCR';
const PRICE_PRO = 'price_1UBFDaLx6rQfmJyZEJFQLicR';

const { default: handler } = await import('../netlify/functions/analiza.mjs');

// Lažni Anthropic SSE stream: tekst u komadima, pa message_delta (stop_reason) i message_stop.
// prekini: stream pukne nakon prvog komada (bez message_stop).
function claudeStream(tekst, { stopReason = 'end_turn', prekini = false } = {}) {
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const komadi = tekst.match(/[\s\S]{1,8}/g) || [];
  const dijelovi = [
    ev({ type: 'message_start', message: { id: 'msg_test', content: [] } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...komadi.map((t) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  ];
  if (prekini) {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode(dijelovi.slice(0, 3).join('')));
        await new Promise((r) => setTimeout(r, 5));
        c.error(new TypeError('terminated'));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  dijelovi.push(
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } }),
    ev({ type: 'message_stop' }),
  );
  return new Response(dijelovi.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
let claudeOdgovor = () => claudeStream('## Procjena vrijednosti\nTest.');

// ── lažni Stripe + Anthropic ──
// kupci: { 'email': [{ id, subs: [{ status, price }] }] }
function mockFetch(kupci, { stripeDown = false } = {}) {
  const pozivi = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    pozivi.push(u.pathname + u.search);
    if (u.hostname === 'api.anthropic.com') return claudeOdgovor();
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

// Poziva funkciju kao preglednik. Stream se računa kao uspjeh (200) tek kad stigne "kraj".
async function pozovi(body) {
  const res = await handler(new Request('http://localhost/.netlify/functions/analiza', {
    method: 'POST', body: JSON.stringify(body),
  }));
  if (!(res.headers.get('Content-Type') || '').startsWith('text/event-stream')) {
    return { status: res.status, body: await res.json() };
  }
  const dogadjaji = (await res.text()).split('\n\n').filter(Boolean).map((d) => JSON.parse(d.replace(/^data: /, '')));
  const tekst = dogadjaji.filter((d) => d.tekst).map((d) => d.tekst).join('');
  const kraj = dogadjaji.find((d) => d.kraj);
  const greska = dogadjaji.find((d) => d.greska);
  return { status: kraj ? 200 : 500, body: { tekst, kraj, greska: greska && greska.greska }, dogadjaji };
}

let n = 0;
async function analiza(email, extra = {}) {
  n += 1;
  return pozovi({ email, oglas_tekst: `Stan ${n}`, ime: 'Test', ...extra });
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

test.beforeEach(() => {
  blobs.clear();
  claudeOdgovor = () => claudeStream('## Procjena vrijednosti\nTest.');
});

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
  return (await pozovi({ email, oglas_tekst: tekst, ime: 'Test', request_id: requestId })).status;
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

const zapisiZahtjeva = () => [...blobs.entries()].filter(([k]) => k.startsWith('propiq-zahtjevi/'));

test('propiq-zahtjevi ne sprema email, nego njegov hash', async () => {
  mockFetch({});
  await zahtjev('Tajni.Email@primjer.hr', 'req-ffff-7777');
  const z = zapisiZahtjeva();
  assert.equal(z.length, 1);
  assert.doesNotMatch(JSON.stringify(z), /tajni\.email|primjer\.hr/i);
  assert.match(z[0][0], /^propiq-zahtjevi\/[0-9a-f]{64}:req-ffff-7777:\d+$/);
});

test('upis u propiq-zahtjevi briše zapise starije od 24 h', async () => {
  mockFetch({});
  const sad = Date.now();
  blobs.set(`propiq-zahtjevi/${'a'.repeat(64)}:req-star-0001:${sad - 25 * 3600 * 1000}`, '{"h":"x","d":0}');
  blobs.set(`propiq-zahtjevi/${'b'.repeat(64)}:req-svjez-0002:${sad - 23 * 3600 * 1000}`, '{"h":"x","d":0}');
  await zahtjev('cisti@primjer.hr', 'req-gggg-8888');
  const kljucevi = zapisiZahtjeva().map(([k]) => k);
  assert.ok(!kljucevi.some((k) => k.includes('req-star-0001')));
  assert.ok(kljucevi.some((k) => k.includes('req-svjez-0002')));
  assert.equal(kljucevi.length, 2);
});

test('sol iz ZAHTJEVI_SALT mijenja hash emaila', async () => {
  mockFetch({});
  await zahtjev('sol@primjer.hr', 'req-hhhh-9999');
  process.env.ZAHTJEVI_SALT = 'posebna-sol';
  try {
    await zahtjev('sol@primjer.hr', 'req-iiii-0000');
  } finally {
    delete process.env.ZAHTJEVI_SALT;
  }
  const hashevi = new Set(zapisiZahtjeva().map(([k]) => k.split('/')[1].split(':')[0]));
  assert.equal(hashevi.size, 2);
});

// ── stream analize ──
const statistika = () => [...blobs.entries()].filter(([k]) => k.startsWith('propiq-stats/'));

test('stream: tekst stiže u dijelovima, limit i statistika tek nakon kraja', async () => {
  mockFetch({});
  const tekst = '## Procjena vrijednosti\nRaspon 180.000–200.000 €.\n\n## Preporuke\n- Provjeriti vlasnički list.';
  claudeOdgovor = () => claudeStream(tekst);
  const r = await pozovi({ email: 'stream@primjer.hr', oglas_tekst: 'X', request_id: 'req-strm-0001' });
  assert.equal(r.status, 200);
  assert.equal(r.body.tekst, tekst);
  assert.ok(r.dogadjaji.filter((d) => d.tekst).length > 1);
  assert.deepEqual(r.dogadjaji.at(-1), { kraj: true, skraceno: false });
  assert.equal(iskoristeno('stream@primjer.hr'), 1);
  assert.equal(statistika().length, 1);
});

test('stream: prvi tekst stiže prije kraja, a limit se ne broji dok stream traje', async () => {
  mockFetch({});
  let pusti;
  const cekaj = new Promise((r) => { pusti = r; });
  const enc = new TextEncoder();
  claudeOdgovor = () => new Response(new ReadableStream({
    async start(c) {
      const ev = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Prvi dio' } }));
      await cekaj;
      c.enqueue(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      c.enqueue(ev({ type: 'message_stop' }));
      c.close();
    },
  }), { status: 200 });
  const res = await handler(new Request('http://localhost/x', {
    method: 'POST', body: JSON.stringify({ email: 'spor@primjer.hr', oglas_tekst: 'Y' }),
  }));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const prvi = await reader.read();
  assert.match(prvi.value, /"tekst":"## Prvi dio"/);
  assert.equal(iskoristeno('spor@primjer.hr'), 0);
  pusti();
  let ostatak = '';
  for (let d = await reader.read(); !d.done; d = await reader.read()) ostatak += d.value;
  assert.match(ostatak, /"kraj":true/);
  assert.equal(iskoristeno('spor@primjer.hr'), 1);
});

test('stream: stop_reason max_tokens javlja da je izvještaj skraćen (i broji se)', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream('## Procjena vrijednosti\nDugačko…', { stopReason: 'max_tokens' });
  const r = await pozovi({ email: 'dugo@primjer.hr', oglas_tekst: 'Z' });
  assert.deepEqual(r.dogadjaji.at(-1), { kraj: true, skraceno: true });
  assert.equal(iskoristeno('dugo@primjer.hr'), 1);
});

test('stream pukne usred: poruka o grešci, limit, statistika i zapis zahtjeva se ne troše', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream('## Procjena vrijednosti\nOvo će puknuti negdje usred.', { prekini: true });
  const r = await pozovi({ email: 'puklo@primjer.hr', oglas_tekst: 'W', request_id: 'req-pukl-0001' });
  assert.equal(r.status, 500);
  assert.ok(r.body.tekst.length > 0);
  assert.match(r.body.greska, /ne broji u limit/);
  assert.equal(iskoristeno('puklo@primjer.hr'), 0);
  assert.equal(statistika().length, 0);
  assert.equal(zapisiZahtjeva().length, 0);
  // ponovni pokušaj s istim request_id se broji normalno, jednom
  claudeOdgovor = () => claudeStream('## Procjena vrijednosti\nSad radi.');
  assert.equal(await zahtjev('puklo@primjer.hr', 'req-pukl-0001', 'W'), 200);
  assert.equal(iskoristeno('puklo@primjer.hr'), 1);
});

test('Anthropic error događaj usred streama: greška, limit se ne troši', async () => {
  mockFetch({});
  claudeOdgovor = () => new Response(
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Poč' } })}\n\n` +
    `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
    { status: 200 });
  const r = await pozovi({ email: 'preopterecen@primjer.hr', oglas_tekst: 'V' });
  assert.match(r.body.greska, /prekinuta/);
  assert.equal(iskoristeno('preopterecen@primjer.hr'), 0);
});

test('preglednik prekine vezu usred streama: limit se ne troši', async () => {
  mockFetch({});
  const lazniFetch = global.fetch;
  let signal;
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com') signal = opts.signal;
    return lazniFetch(url, opts);
  };
  claudeOdgovor = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } })}\n\n`));
    },
  }), { status: 200 });
  const res = await handler(new Request('http://localhost/x', {
    method: 'POST', body: JSON.stringify({ email: 'otisao@primjer.hr', oglas_tekst: 'U' }),
  }));
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(signal.aborted, 'poziv prema Anthropicu je prekinut');
  assert.equal(iskoristeno('otisao@primjer.hr'), 0);
});

test('Anthropic odbije zahtjev prije streama: JSON 502, limit se ne troši', async () => {
  mockFetch({});
  claudeOdgovor = () => new Response('{"type":"error"}', { status: 529 });
  const r = await pozovi({ email: 'odbijen@primjer.hr', oglas_tekst: 'T' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /nije dostupna/);
  assert.equal(iskoristeno('odbijen@primjer.hr'), 0);
});
