// Testovi pristupa plaćenom planu (opcija A: aktivna Stripe pretplata po emailu) i streama analize.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'
// Stripe, Anthropic i Netlify Blobs su lažirani — test ne troši ništa i ne treba ključeve.
// Za provjeru na pravom Stripe test modu vidi tests/stripe-testmod.mjs.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import zajednickiIzracuni from '../public/assets/js/izracuni.js';
import { odrediReferencu } from '../netlify/lib/trziste.mjs';

// ── lažni Netlify Blobs (u memoriji) ──
const blobs = new Map();
let blobsUpisPada = false; // simulira ispad Netlify Blobs pri upisu
mock.module('@netlify/blobs', {
  namedExports: {
    getStore(name) {
      return {
        async get(k) { return blobs.get(`${name}/${k}`) ?? null; },
        async set(k, v) {
          if (blobsUpisPada) throw new Error('Blobs nedostupan');
          blobs.set(`${name}/${k}`, v);
        },
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

// Ispravan strukturirani izvještaj (oblik iz netlify/lib/izvjestaj.mjs).
const IZVJESTAJ = {
  naslov: 'Trosobni stan, Split – Znanovac, 72 m²',
  lokacija: { grad: 'Split', kvart: 'Znanovac' },
  povrsina_m2: 72,
  cijena_eur: 240000,
  preporuka: 'pregovaraj',
  ocjena: 5,
  sazetak: 'Cijena je na gornjoj granici za kvart. Ima prostora za pregovore.',
  fer_vrijednost: { min_eur: 205000, max_eur: 230000, pouzdanost: 'srednja', obrazlozenje: 'Usporedive prodaje u kvartu.' },
  najam: { dugorocni_mj_eur: 900, turisticki_godisnje_eur: null },
  prednosti: ['Blizina škole'],
  rizici: [{ naslov: 'Stanje instalacija', opis: 'Oglas ne navodi godinu obnove.', razina: 'srednji' }],
  pregovaranje: { ciljana_ponuda_eur: 218000, aduti: ['Cijena iznad kvartovskog prosjeka'], pitanja_prodavatelju: ['Kada su zadnji put mijenjane instalacije?'] },
  nedostajuci_podaci: ['Energetski razred'],
};
// Poziv 1 (slijepa procjena) i poziv 2 (analiza): analiza više ne nosi fer_vrijednost ni najam.
const PROCJENA = {
  fer_vrijednost: { min_eur: 205000, max_eur: 230000, pouzdanost: 'srednja', obrazlozenje: 'Usporedive prodaje u kvartu.' },
  najam: { dugorocni_mj_eur: 900, turisticki_godisnje_eur: null },
};
// Poziv 1 kad grad IMA medijan: model vraća samo korekcije + pouzdanost + površinu + najam; raspon računa kod.
const PROCJENA_KOR = {
  korekcije: [{ razlog: 'zadnji kat bez lifta', postotak: -15 }, { razlog: 'stanje za obnovu', postotak: -15 }],
  pouzdanost: 'srednja',
  povrsina_m2: 72,
  najam: PROCJENA.najam,
};
const medijanGrada = (grad) => odrediReferencu({ grad }, '').realizirana.uskladeno_eur_m2;
// Očekivana fer_vrijednost za PROCJENA_KOR (Split, 72 m²) — računa se istim zajedničkim kodom.
const ocekivanaFer = (grad = 'Split', promjene = {}) => {
  const m = { ...PROCJENA_KOR, ...promjene };
  const r = zajednickiIzracuni.izracunajFer({ medijan_eur_m2: medijanGrada(grad), korekcije: m.korekcije, pouzdanost: m.pouzdanost, povrsina_m2: m.povrsina_m2, naziv: grad });
  return { min_eur: r.min_eur, max_eur: r.max_eur, pouzdanost: m.pouzdanost, obrazlozenje: zajednickiIzracuni.obrazlozenjeFer(r.izracun), izracun: r.izracun };
};
const { fer_vrijednost: _fer, najam: _najam, ...IZVJESTAJ_BEZ_PROCJENE } = IZVJESTAJ;
const izvjestajJson = (promjene = {}) => JSON.stringify({ ...IZVJESTAJ_BEZ_PROCJENE, ...promjene });
const procjenaJson = (promjene = {}) => JSON.stringify({ ...PROCJENA, ...promjene });
const korekcijeJson = (promjene = {}) => JSON.stringify({ ...PROCJENA_KOR, ...promjene });
// Zadani odgovor poziva 1 prati alat koji je poslužitelj zatražio: s medijanom korekcije, bez njega raniji oblik.
const zadanaProcjena = (t) => claudeStream(t && t.tools[0].input_schema.required.includes('korekcije') ? korekcijeJson() : procjenaJson());

// Lažni Anthropic SSE stream: JSON tool poziva u komadima (input_json_delta), pa message_delta (stop_reason) i message_stop.
// prekini: stream pukne nakon prvog komada (bez message_stop).
function claudeStream(tekst, { stopReason = 'end_turn', prekini = false } = {}) {
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const komadi = tekst.match(/[\s\S]{1,8}/g) || [];
  const dijelovi = [
    ev({ type: 'message_start', message: { id: 'msg_test', content: [] } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: 'izvjestaj', input: {} } }),
    ...komadi.map((t) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: t } })),
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
let claudeOdgovor = () => claudeStream(izvjestajJson());     // poziv 2 (analiza)
let procjenaOdgovor = zadanaProcjena;    // poziv 1 (slijepa procjena)

// ── lažni Stripe + Anthropic ──
// kupci: { 'email': [{ id, subs: [{ status, price }] }] }
function mockFetch(kupci, { stripeDown = false } = {}) {
  const pozivi = [];
  global.fetch = async (url, opts) => {
    const u = new URL(url);
    pozivi.push(u.pathname + u.search);
    if (u.hostname === 'api.anthropic.com') {
      const tijelo = JSON.parse(opts.body);
      return tijelo.tool_choice.name === 'procjena' ? procjenaOdgovor(tijelo) : claudeOdgovor(tijelo);
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

// Poziva funkciju kao preglednik. Stream se računa kao uspjeh (200) tek kad stigne "kraj".
async function pozovi(body) {
  const res = await handler(new Request('http://localhost/.netlify/functions/analiza', {
    method: 'POST', body: JSON.stringify(body),
  }));
  if (!(res.headers.get('Content-Type') || '').startsWith('text/event-stream')) {
    return { status: res.status, body: await res.json() };
  }
  const dogadjaji = (await res.text()).split('\n\n').filter(Boolean).map((d) => JSON.parse(d.replace(/^data: /, '')));
  const kraj = dogadjaji.find((d) => d.kraj);
  const greska = dogadjaji.find((d) => d.greska);
  return { status: kraj ? 200 : 500, body: { rezultat: kraj && kraj.rezultat, kraj, greska: greska && greska.greska }, dogadjaji };
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
  blobsUpisPada = false;
  claudeOdgovor = () => claudeStream(izvjestajJson());
  procjenaOdgovor = zadanaProcjena;
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

test('stream: rezultat { analiza, izracuni } stiže na kraju, limit i statistika tek nakon kraja', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson());
  const r = await pozovi({ email: 'stream@primjer.hr', oglas_tekst: 'X', request_id: 'req-strm-0001' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dogadjaji.map((d) => d.faza || (d.kraj && 'kraj')), ['procjena', 'analiza', 'kraj'],
    'faze napretka stižu redom, s rezultatom tek na kraju');
  assert.deepEqual(Object.keys(r.body.rezultat).sort(), ['analiza', 'izracuni', 'referenca', 'uneseno']);
  assert.equal(r.body.rezultat.analiza.naslov, IZVJESTAJ.naslov);
  assert.equal(r.body.rezultat.izracuni.cijena_po_m2, 3333);
  assert.equal(iskoristeno('stream@primjer.hr'), 1);
  assert.equal(statistika().length, 1);
});

test('zahtjev prema Anthropicu forsira tool "izvjestaj" i ostavlja prostora za JSON', async () => {
  mockFetch({});
  const lazniFetch = global.fetch;
  let tijelo;
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com') tijelo = JSON.parse(opts.body);
    return lazniFetch(url, opts);
  };
  await pozovi({ email: 'tool@primjer.hr', oglas_tekst: 'X' });
  assert.deepEqual(tijelo.tool_choice, { type: 'tool', name: 'izvjestaj' });
  assert.equal(tijelo.tools[0].name, 'izvjestaj');
  assert.ok(!('fer_vrijednost' in tijelo.tools[0].input_schema.properties) && !('najam' in tijelo.tools[0].input_schema.properties), 'analiza ne smije mijenjati procjenu');
  assert.ok(tijelo.max_tokens >= 2000);
  assert.equal(tijelo.stream, true);
});

test('nevaljan JSON: jedan ponovni pokušaj, pa uspjeh se broji jednom', async () => {
  mockFetch({});
  let poziva = 0;
  claudeOdgovor = () => (++poziva === 1 ? claudeStream('{"naslov": "odrezan...') : claudeStream(izvjestajJson()));
  const r = await pozovi({ email: 'retry@primjer.hr', oglas_tekst: 'R' });
  assert.equal(poziva, 2);
  assert.equal(r.status, 200);
  assert.equal(iskoristeno('retry@primjer.hr'), 1);
  assert.equal(statistika().length, 1);
});

test('odgovor koji ne prolazi validaciju ni iz drugog pokušaja: greška, limit se ne troši', async () => {
  mockFetch({});
  let poziva = 0;
  claudeOdgovor = () => { poziva++; return claudeStream(izvjestajJson({ sazetak: '' })); };
  const r = await pozovi({ email: 'nevaljan@primjer.hr', oglas_tekst: 'N', request_id: 'req-nevl-0001' });
  assert.equal(poziva, 2, 'točno jedan retry');
  assert.equal(r.status, 500);
  assert.match(r.body.greska, /ne broji u limit/);
  assert.equal(iskoristeno('nevaljan@primjer.hr'), 0);
  assert.equal(statistika().length, 0);
  assert.equal(zapisiZahtjeva().length, 0);
});

test('stop_reason max_tokens (odrezan JSON) je neuspjeh i retry, ne uspjeh', async () => {
  mockFetch({});
  let poziva = 0;
  claudeOdgovor = () => { poziva++; return claudeStream(izvjestajJson(), { stopReason: 'max_tokens' }); };
  const r = await pozovi({ email: 'odrezan@primjer.hr', oglas_tekst: 'Z' });
  assert.equal(poziva, 2);
  assert.equal(r.status, 500);
  assert.equal(iskoristeno('odrezan@primjer.hr'), 0);
});

test('stream pukne usred: poruka o grešci, limit, statistika i zapis zahtjeva se ne troše', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson(), { prekini: true });
  const r = await pozovi({ email: 'puklo@primjer.hr', oglas_tekst: 'W', request_id: 'req-pukl-0001' });
  assert.equal(r.status, 500);
  assert.match(r.body.greska, /ne broji u limit/);
  assert.equal(iskoristeno('puklo@primjer.hr'), 0);
  assert.equal(statistika().length, 0);
  assert.equal(zapisiZahtjeva().length, 0);
  // ponovni pokušaj s istim request_id se broji normalno, jednom
  claudeOdgovor = () => claudeStream(izvjestajJson());
  assert.equal(await zahtjev('puklo@primjer.hr', 'req-pukl-0001', 'W'), 200);
  assert.equal(iskoristeno('puklo@primjer.hr'), 1);
});

test('Anthropic error događaj usred streama: greška, limit se ne troši', async () => {
  mockFetch({});
  claudeOdgovor = () => new Response(
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"nas' } })}\n\n` +
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
  let struja;
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com') {
      signal = opts.signal;
      // kao pravi fetch: prekid (abort) prekida i stream odgovora
      signal.addEventListener('abort', () => { try { struja.error(new DOMException('aborted', 'AbortError')); } catch {} });
    }
    return lazniFetch(url, opts);
  };
  claudeOdgovor = () => new Response(new ReadableStream({
    start(c) {
      struja = c;
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } })}\n\n`));
    },
  }), { status: 200 });
  const res = await handler(new Request('http://localhost/x', {
    method: 'POST', body: JSON.stringify({ email: 'otisao@primjer.hr', oglas_tekst: 'U' }),
  }));
  const reader = res.body.getReader();
  await new Promise((r) => setTimeout(r, 10)); // izvještaj se šalje tek na kraju, pa se ne čeka prvi događaj
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(signal.aborted, 'poziv prema Anthropicu je prekinut');
  assert.equal(iskoristeno('otisao@primjer.hr'), 0);
});

test('Anthropic odbije zahtjev prije streama: JSON 502, limit se ne troši', async () => {
  mockFetch({});
  procjenaOdgovor = () => new Response('{"type":"error"}', { status: 529 });
  const r = await pozovi({ email: 'odbijen@primjer.hr', oglas_tekst: 'T' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /nije dostupna/);
  assert.equal(iskoristeno('odbijen@primjer.hr'), 0);
});

// ── V2: ograničenja duljine ulaza ──
test('predugačak tekst oglasa: 400, Anthropic se ne zove i limit se ne troši', async () => {
  const pozivi = mockFetch({});
  const r = await pozovi({ email: 'dugo@primjer.hr', oglas_tekst: 'x'.repeat(15001) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /predugačak/);
  assert.equal(pozivi.length, 0);
  assert.equal(iskoristeno('dugo@primjer.hr'), 0);
});

test('tekst oglasa točno na granici (15000 znakova) prolazi', async () => {
  mockFetch({});
  const r = await pozovi({ email: 'granica@primjer.hr', oglas_tekst: 'x'.repeat(15000) });
  assert.equal(r.status, 200);
});

test('predugačko ime ili agencija: 400', async () => {
  mockFetch({});
  const a = await pozovi({ email: 'ime@primjer.hr', oglas_tekst: 'T', ime: 'a'.repeat(101) });
  const b = await pozovi({ email: 'ime@primjer.hr', oglas_tekst: 'T', agencija: 'a'.repeat(101) });
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
});

test('predugačak ili neispravan email: 400, bez poziva prema Stripeu i Anthropicu', async () => {
  const pozivi = mockFetch({});
  for (const email of [`${'a'.repeat(250)}@x.hr`, 'bez-znaka-at', 'dva@@x.hr', 'razmak u@x.hr', 'a@bez-tocke']) {
    const r = await pozovi({ email, oglas_tekst: 'T' });
    assert.equal(r.status, 400, email);
    assert.match(r.body.error, /email/i, email);
  }
  assert.equal(pozivi.length, 0);
});

// ── V3: greška pri bilježenju ne smije poništiti već prikazanu analizu ──
test('Blobs pada pri bilježenju nakon uspješnog streama: analiza ipak završava s "kraj"', async () => {
  mockFetch({});
  blobsUpisPada = true;
  const r = await pozovi({ email: 'blobs@primjer.hr', oglas_tekst: 'T', request_id: 'req-blobs-1' });
  assert.equal(r.status, 200);
  assert.ok(r.body.kraj);
  assert.equal(r.body.greska, undefined);
  assert.equal(r.body.rezultat.analiza.naslov, IZVJESTAJ.naslov);
});

// ── Ključni podaci iz forme ──
function uhvatiPoziv() {
  const lazniFetch = global.fetch;
  const uhvaceno = {};
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com') uhvaceno.tijelo = JSON.parse(opts.body);
    return lazniFetch(url, opts);
  };
  return uhvaceno;
}

test('podaci iz forme: idu u poruku modela, u prompt je pravilo o prednosti, rezultat vraća "uneseno"', async () => {
  mockFetch({});
  const u = uhvatiPoziv();
  const podaci = { cijena_eur: 250000, povrsina_m2: 70, grad: 'Split', kvart: 'Meje', kat: 3, lift: 'da', parking: 'javni', godina_gradnje: 1985 };
  const r = await pozovi({ email: 'podaci@primjer.hr', oglas_tekst: 'Stan', podaci });
  assert.equal(r.status, 200);
  const poruka = u.tijelo.messages[0].content;
  for (const dio of ['Tražena cijena: 250000 €', 'Stambena površina: 70 m²', 'Grad: Split', 'Kvart: Meje', 'Kat: 3', 'Lift: da', 'Parking: javni', 'Godina gradnje: 1985']) {
    assert.ok(poruka.includes(dio), dio);
  }
  assert.match(u.tijelo.system, /POTVRĐENI i imaju prednost pred tekstom oglasa/);
  assert.match(u.tijelo.system, /razliku kao rizik ili kao pitanje za prodavatelja/);
  assert.deepEqual(r.body.rezultat.uneseno, podaci);
});

test('korisnički podaci imaju prednost pred onim što je izvukao AI (analiza i izračuni)', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson()); // model: 240000 €, 72 m², Split/Znanovac
  const r = await pozovi({ email: 'prednost@primjer.hr', oglas_tekst: 'Stan', podaci: { cijena_eur: 200000, povrsina_m2: 80, grad: 'Zagreb' } });
  const { analiza, izracuni } = r.body.rezultat;
  assert.equal(analiza.cijena_eur, 200000);
  assert.equal(analiza.povrsina_m2, 80);
  assert.equal(analiza.lokacija.grad, 'Zagreb');
  assert.equal(analiza.lokacija.kvart, 'Znanovac', 'neupisano ostaje od AI-ja');
  assert.equal(izracuni.cijena_po_m2, 2500);          // 200000 / 80, ne 240000 / 72
  assert.equal(izracuni.porez_na_promet, 6000);
});

test('korisnička cijena vrijedi i kad je model nije našao (nema "Nedovoljno podataka")', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: null }));
  const r = await pozovi({ email: 'cijenaform@primjer.hr', oglas_tekst: 'Stan', podaci: { cijena_eur: 240000 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.rezultat.analiza.cijena_eur, 240000);
  assert.equal(r.body.rezultat.analiza.preporuka, 'oprez', '240000 € je iznad fer raspona 205–230k (preporuku određuje kod)');
  assert.equal(r.body.rezultat.analiza.ocjena, 3, 'ocjena modela (5) stegnuta na raspon za oprez');
});

test('analiza bez teksta oglasa: dopuštena uz cijenu + površinu + grad', async () => {
  mockFetch({});
  const u = uhvatiPoziv();
  claudeOdgovor = () => claudeStream(izvjestajJson());
  const r = await pozovi({ email: 'bezteksta@primjer.hr', oglas_tekst: '', podaci: { cijena_eur: '185.000', povrsina_m2: '60', grad: 'Zagreb' } });
  assert.equal(r.status, 200);
  assert.match(u.tijelo.messages[0].content, /nije zalijepio tekst oglasa/);
  assert.equal(r.body.rezultat.analiza.cijena_eur, 185000, 'zapis 185.000 parsiran istim parserom');
  assert.equal(iskoristeno('bezteksta@primjer.hr'), 1);
});

test('bez teksta i bez cijene + površine + grada: 400, bez poziva i bez trošenja limita', async () => {
  const pozivi = mockFetch({});
  for (const podaci of [undefined, {}, { cijena_eur: 100000, povrsina_m2: 50 }, { povrsina_m2: 50, grad: 'Zagreb' }, { grad: 'Zagreb', kvart: 'Jarun' }]) {
    const r = await pozovi({ email: 'nista@primjer.hr', oglas_tekst: '   ', podaci });
    assert.equal(r.status, 400, JSON.stringify(podaci));
  }
  assert.equal(pozivi.length, 0);
  assert.equal(iskoristeno('nista@primjer.hr'), 0);
});

test('nevaljana polja forme: 400, bez poziva i bez trošenja limita', async () => {
  const pozivi = mockFetch({});
  const lose = [
    { cijena_eur: -5 }, { cijena_eur: 0 }, { cijena_eur: 5e9 }, { cijena_eur: 'abc' }, { povrsina_m2: 0 }, { povrsina_m2: 99999 },
    { povrsina_m2: 'x' }, { grad: 'g'.repeat(81) }, { kvart: 'k'.repeat(81) }, { grad: '<script>' }, { kat: 1.5 }, { kat: 500 },
    { godina_gradnje: 1200 }, { godina_gradnje: 3000 }, { lift: 'možda' }, { parking: 'garaža' }, 'tekst', [1],
  ];
  for (const podaci of lose) {
    const r = await pozovi({ email: 'losa@primjer.hr', oglas_tekst: 'Stan', podaci });
    assert.equal(r.status, 400, JSON.stringify(podaci));
  }
  assert.equal(pozivi.length, 0);
  assert.equal(iskoristeno('losa@primjer.hr'), 0);
});

// ── anti-anchoring: slijepa procjena (poziv 1) + analiza (poziv 2) ──
// Bilježi sva tijela zahtjeva prema Anthropicu, po nazivu alata.
function bilježiPozive() {
  const lazniFetch = global.fetch;
  const pozivi = [];
  global.fetch = async (url, opts) => {
    if (new URL(url).hostname === 'api.anthropic.com') {
      const tijelo = JSON.parse(opts.body);
      pozivi.push({ alat: tijelo.tool_choice.name, tijelo, poruke: JSON.stringify(tijelo.messages), sustav: tijelo.system });
    }
    return lazniFetch(url, opts);
  };
  return pozivi;
}

const OGLAS_S_CIJENOM = 'Prodaje se stan u Splitu, Znanovac, 72 m², 3. kat. Cijena: 694.896 €. To je 9.651 €/m². ' +
  'Tražimo 694 896,00 EUR, odnosno €695k (695 tis.), po dogovoru. Kupac plaća porez. Stan je obnovljen 2019.';

test('poziv 1 (slijepa procjena) nikad ne dobije traženu cijenu: ni iz teksta ni iz forme', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  const r = await pozovi({
    email: 'slijepo@primjer.hr', oglas_tekst: `${OGLAS_S_CIJENOM} Tražena cijena 694896.`,
    podaci: { cijena_eur: '694.896', povrsina_m2: 72, grad: 'Split' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(pozivi.map((p) => p.alat), ['procjena', 'izvjestaj'], 'dva sekvencijalna poziva, procjena prva');
  // Referentni blok (tržišni prosjek, npr. "5811 €/m²") nije cijena oglasa — izuzima se iz provjere.
  const slijepi = pozivi[0].poruke.replace(/Referentni tržišni podaci[\s\S]*?\\n\\n/, '');
  assert.ok(pozivi[0].poruke.includes('Grad Split: medijan stvarno plaćenih cijena stanova/apartmana u 2025. iznosi 4067 €/m²'), 'referenca grada ide u poziv 1');
  for (const zabranjeno of ['694', '695', '9.651', '9651', '€', 'EUR', '/m²', 'Tražena cijena', 'Cijena:']) {
    assert.ok(!slijepi.includes(zabranjeno), `poziv 1 sadrži "${zabranjeno}": ${slijepi}`);
  }
  assert.ok(slijepi.includes('[cijena uklonjena]'));
  assert.ok(slijepi.includes('Stambena površina: 72 m²') && slijepi.includes('Grad: Split'), 'ostala polja forme idu u poziv 1');
  assert.ok(slijepi.includes('Stan je obnovljen 2019'), 'ostatak oglasa ostaje');
  const tijelo1 = pozivi[0].tijelo;
  assert.equal(tijelo1.temperature, 0);
  assert.ok(tijelo1.max_tokens <= 1000);
  assert.deepEqual(tijelo1.tool_choice, { type: 'tool', name: 'procjena' });
  assert.match(pozivi[0].sustav, /isključivo iz karakteristika nekretnine i lokacije/);
  assert.match(pozivi[0].sustav, /smanji pouzdanost umjesto da pogađaš/);
  // poziv 2 dobiva punu cijenu i fiksnu procjenu
  assert.ok(pozivi[1].poruke.includes('694.896') && pozivi[1].poruke.includes('Tražena cijena: 694896 €'));
  const ocek = ocekivanaFer('Split');
  assert.ok(pozivi[1].poruke.includes(`${ocek.min_eur}–${ocek.max_eur} €`) && pozivi[1].poruke.includes('Fiksna procjena tržišta'));
});

test('poziv 1 bez cijene u formi: cijena iz oglasa se također uklanja', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  await pozovi({ email: 'slijepo2@primjer.hr', oglas_tekst: 'Stan 60 m2, Zagreb. Cijena 185.000 eur.' });
  assert.ok(!/185/.test(pozivi[0].poruke), pozivi[0].poruke);
  assert.ok(/185\.000/.test(pozivi[1].poruke), 'poziv 2 vidi cijenu');
});

test('model ne može prepisati fer raspon ni najam: u izvještaju je procjena iz poziva 1', async () => {
  mockFetch({});
  // model u pozivu 2 (mimo sheme) vrati vlastiti raspon uz traženu cijenu 240000
  claudeOdgovor = () => claudeStream(JSON.stringify({
    ...IZVJESTAJ_BEZ_PROCJENE,
    fer_vrijednost: { min_eur: 230000, max_eur: 250000, pouzdanost: 'visoka', obrazlozenje: 'Prilagođeno traženoj cijeni.' },
    najam: { dugorocni_mj_eur: 1500, turisticki_godisnje_eur: 20000 },
  }));
  const r = await pozovi({ email: 'fiksno@primjer.hr', oglas_tekst: 'Stan u Splitu' });
  const { analiza } = r.body.rezultat;
  const ocek = ocekivanaFer('Split');
  assert.deepEqual(analiza.fer_vrijednost, ocek);
  assert.deepEqual(analiza.najam, { ...PROCJENA.najam, pouzdanost: 'srednja' }, 'najam iz poziva 1; pouzdanost postavlja kod');
  assert.equal(analiza.cijena_eur, 240000);
  assert.equal(analiza.preporuka, 240000 > ocek.max_eur ? 'oprez' : 240000 < ocek.min_eur ? 'povoljno' : 'pregovaraj', 'preporuka iz odnosa cijene i izračunatog raspona');
  assert.notEqual(analiza.fer_vrijednost.max_eur, 250000, 'raspon modela iz poziva 2 se ignorira');
});

test('preporuku određuje kod: ispod / unutar / iznad fer raspona (granice uključene)', async () => {
  const slucajevi = [
    [150000, 'povoljno', 7, 10], [204999, 'povoljno', 7, 10], [205000, 'pregovaraj', 4, 6], [220000, 'pregovaraj', 4, 6],
    [230000, 'pregovaraj', 4, 6], [230001, 'oprez', 1, 3], [695000, 'oprez', 1, 3],
  ];
  let i = 0;
  for (const [cijena, preporuka, oMin, oMax] of slucajevi) {
    mockFetch({});
    // model tvrdi suprotno: uvijek "povoljno" 9
    claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: cijena, preporuka: 'povoljno', ocjena: 9 }));
    const r = await pozovi({ email: `kod${i++}@primjer.hr`, oglas_tekst: 'Stan' });
    const a = r.body.rezultat.analiza;
    assert.equal(a.preporuka, preporuka, `cijena ${cijena}`);
    assert.ok(a.ocjena >= oMin && a.ocjena <= oMax, `cijena ${cijena}: ocjena ${a.ocjena}`);
  }
});

test('ocjena modela unutar raspona preporuke ostaje; izvan raspona se stegne na granicu', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: 220000, preporuka: 'pregovaraj', ocjena: 5 }));
  assert.equal((await pozovi({ email: 'oc1@primjer.hr', oglas_tekst: 'S' })).body.rezultat.analiza.ocjena, 5);
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: 220000, preporuka: 'pregovaraj', ocjena: 9 }));
  assert.equal((await pozovi({ email: 'oc2@primjer.hr', oglas_tekst: 'S' })).body.rezultat.analiza.ocjena, 6);
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: 300000, preporuka: 'povoljno', ocjena: 9 }));
  assert.equal((await pozovi({ email: 'oc3@primjer.hr', oglas_tekst: 'S' })).body.rezultat.analiza.ocjena, 3);
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: 100000, preporuka: 'oprez', ocjena: 1 }));
  assert.equal((await pozovi({ email: 'oc4@primjer.hr', oglas_tekst: 'S' })).body.rezultat.analiza.ocjena, 7);
});

test('bez cijene i dalje "nedovoljno podataka" (preporuka i ocjena null), procjena ipak ide u izvještaj', async () => {
  mockFetch({});
  claudeOdgovor = () => claudeStream(izvjestajJson({ cijena_eur: null, preporuka: 'oprez', ocjena: 2 }));
  const r = await pozovi({ email: 'bezcijene@primjer.hr', oglas_tekst: 'Stan u Splitu bez cijene' });
  const { analiza } = r.body.rezultat;
  assert.equal(analiza.preporuka, null);
  assert.equal(analiza.ocjena, null);
  assert.deepEqual(analiza.fer_vrijednost, ocekivanaFer('Split'));
});

test('bez fer raspona (null) preporuka ostaje od modela, uz običnu validaciju', async () => {
  mockFetch({});
  procjenaOdgovor = () => claudeStream(procjenaJson({ fer_vrijednost: { min_eur: null, max_eur: null, pouzdanost: 'niska', obrazlozenje: 'Nepoznato mjesto.' } }));
  claudeOdgovor = () => claudeStream(izvjestajJson({ preporuka: 'pregovaraj', ocjena: 5 }));
  const r = await pozovi({ email: 'bezraspona@primjer.hr', oglas_tekst: 'Stan' });
  assert.equal(r.status, 200);
  assert.equal(r.body.rezultat.analiza.preporuka, 'pregovaraj');
  assert.equal(r.body.rezultat.analiza.fer_vrijednost.min_eur, null);
});

test('nevaljana procjena (poziv 1): jedan ponovni pokušaj; ako ne uspije, greška i limit se ne troši', async () => {
  mockFetch({});
  let poziva = 0;
  procjenaOdgovor = () => { poziva++; return claudeStream('{"fer_vrijednost": {"min_eur": 5'); };
  const pozivi = bilježiPozive();
  const r = await pozovi({ email: 'losaprocjena@primjer.hr', oglas_tekst: 'Stan' });
  assert.equal(poziva, 2);
  assert.ok(!pozivi.some((p) => p.alat === 'izvjestaj'), 'analiza se ne zove bez procjene');
  assert.match(r.body.greska, /ne broji u limit/);
  assert.equal(iskoristeno('losaprocjena@primjer.hr'), 0);
  poziva = 0;
  procjenaOdgovor = () => (++poziva === 1 ? claudeStream('smeće') : claudeStream(procjenaJson()));
  assert.equal((await pozovi({ email: 'losaprocjena@primjer.hr', oglas_tekst: 'Stan' })).status, 200);
});

test('vrijeme: ako poziv 1 potroši gotovo cijeli limit, poziv 2 se ne pokreće — postojeća greška, bez brojanja', async () => {
  mockFetch({});
  const pravoSada = Date.now;
  let pomak = 0;
  Date.now = () => pravoSada() + pomak;
  try {
    procjenaOdgovor = () => { pomak += 40000; return claudeStream(procjenaJson()); }; // 40 s od 55 s
    const pozivi = bilježiPozive();
    const r = await pozovi({ email: 'sporo@primjer.hr', oglas_tekst: 'Stan', request_id: 'req-sporo-0001' });
    assert.deepEqual(pozivi.map((p) => p.alat), ['procjena']);
    assert.match(r.body.greska, /predugo.*ne broji u limit/);
    assert.equal(iskoristeno('sporo@primjer.hr'), 0);
    assert.equal(statistika().length, 0);
    assert.equal(zapisiZahtjeva().length, 0);
  } finally {
    Date.now = pravoSada;
  }
});

test('log bilježi trajanje oba poziva', async () => {
  mockFetch({});
  const logovi = [];
  const staro = console.log;
  console.log = (...a) => logovi.push(a.join(' '));
  try { await pozovi({ email: 'log@primjer.hr', oglas_tekst: 'Stan' }); } finally { console.log = staro; }
  assert.ok(logovi.some((l) => /Trajanje poziva: procjena \d+ ms, analiza \d+ ms, ukupno \d+ ms/.test(l)), logovi.join('|'));
});

// ── referentni tržišni podaci u pozivu 1: usklađeni medijan realiziranih cijena ──
const referencaPoruka = (poruke) => (poruke.match(/Referentni tržišni podaci[\s\S]*?\\n\\n/) || [''])[0];

test('poziv 1 dobiva usklađeni medijan realiziranih cijena s izvorima; cijena i dalje ne, poziv 2 ne dobiva blok', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  const r = await pozovi({
    email: 'ref1@primjer.hr', oglas_tekst: 'Stan, Središće. Cijena 250.000 €.',
    podaci: { cijena_eur: 250000, grad: 'Zagreb' },
  });
  assert.equal(r.status, 200);
  const ref = referencaPoruka(pozivi[0].poruke);
  assert.ok(ref.includes('REALIZIRANE cijene (transakcijske, ne tražene)'), ref);
  assert.ok(ref.includes('Grad Zagreb: medijan stvarno plaćenih cijena stanova/apartmana u 2025. iznosi 2917 €/m² (7616 prodaja'), ref);
  assert.ok(ref.includes('regija Zagreb, faktor 1,1353) na II. tromjesečje 2026. (privremeni podaci): 3312 €/m²'), ref);
  assert.ok(ref.includes('Ministarstvo prostornoga uređenja') && ref.includes('Državni zavod za statistiku'), ref);
  assert.ok(!/nekretnine\.hr/i.test(pozivi[0].poruke), 'nema podataka nekretnine.hr');
  assert.ok(!pozivi[0].poruke.includes('250000') && !pozivi[0].poruke.includes('250.000'), 'cijena oglasa nije u pozivu 1');
  assert.ok(!referencaPoruka(pozivi[1].poruke), 'poziv 2 ne dobiva referentni blok');
  assert.deepEqual(r.body.rezultat.referenca, {
    razina: 'grad', naziv: 'Zagreb', trazena: null,
    realizirana: { godina: 2025, medijan_eur_m2: 2917, broj_prodaja: 7616, uskladeno_eur_m2: 3312, indeks_razdoblje: 'II. tromjesečje 2026.', privremeno: true },
  });
  const sustav = pozivi[0].sustav;
  assert.match(sustav, /REALIZIRANE cijene: medijan STVARNO PLAĆENIH cijena stanova\/apartmana/);
  assert.match(sustav, /svi stanovi svih starosti i stanja/);
  assert.match(sustav, /Kreni od usklađenog medijana/);
  assert.match(sustav, /stanje i opremljenost, kat, lift, parking, starost/);
  assert.match(sustav, /veliki stanovi često imaju niži €\/m²/);
  assert.match(sustav, /predloži KOREKCIJE/);
  assert.match(sustav, /NE računaj zbroj, €\/m², raspon ni ukupne iznose/);
  assert.match(sustav, /najviše 6 stavki/);
  // Alat: model vraća korekcije, ne min_eur/max_eur.
  const svojstva = pozivi[0].tijelo.tools[0].input_schema.properties;
  assert.ok('korekcije' in svojstva && !('fer_vrijednost' in svojstva) && !('min_eur' in svojstva));
  // Raspon i obrazloženje računa kod iz medijana 3312 €/m² i korekcija.
  const fer = r.body.rezultat.analiza.fer_vrijednost;
  assert.equal(fer.izracun.polaziste_m2, 3312);
  assert.ok(fer.obrazlozenje.startsWith('Polazište: usklađeni medijan Zagreb 3.312 €/m².'), fer.obrazlozenje);
  assert.match(sustav, /za najam nemaš referentnih podataka/);
});

test('grad se prepoznaje iz teksta oglasa kad nije u formi; medijan se usklađuje regijom grada', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  const r = await pozovi({ email: 'ref2@primjer.hr', oglas_tekst: 'Prodaje se stan u Osijeku, 55 m². Cijena 90.000 €.' });
  const ref = referencaPoruka(pozivi[0].poruke);
  assert.ok(ref.includes('Grad Osijek: medijan stvarno plaćenih cijena stanova/apartmana u 2025. iznosi 1666 €/m² (670 prodaja'), ref);
  assert.ok(ref.includes('regija Ostalo, faktor 1,1334') && ref.includes('1888 €/m²'), ref);
  assert.equal(r.body.rezultat.referenca.realizirana.uskladeno_eur_m2, 1888);
});

test('bez reference (nepoznat grad, Pazin bez regije): poruka to kaže, referenca je null, pouzdanost i najam niski', async () => {
  for (const [email, tekst] of [['ref3@primjer.hr', 'Stan u Makarskoj, 50 m².'], ['ref4@primjer.hr', 'Stan u Pazinu, 50 m².']]) {
    mockFetch({});
    procjenaOdgovor = () => claudeStream(procjenaJson({ fer_vrijednost: { ...PROCJENA.fer_vrijednost, pouzdanost: 'visoka' } }));
    const pozivi = bilježiPozive();
    const r = await pozovi({ email, oglas_tekst: tekst });
    assert.ok(pozivi[0].poruke.includes('NEMA podataka za ovu lokaciju'), tekst);
    assert.equal(r.body.rezultat.referenca, null, tekst);
    assert.equal(r.body.rezultat.analiza.fer_vrijednost.pouzdanost, 'niska', tekst);
    assert.equal(r.body.rezultat.analiza.najam.pouzdanost, 'niska', tekst);
    assert.equal(r.body.rezultat.analiza.fer_vrijednost.bez_reference, true, 'bez medijana: jasno označeno');
    assert.ok(!('korekcije' in pozivi[0].tijelo.tools[0].input_schema.properties), 'bez medijana: raniji oblik alata');
  }
});

test('pouzdanost: razina grada najviše srednja, bez podatka niska — model ne može zaobići; najam najviše srednja', async () => {
  const slucaj = async (email, tijelo, pouzdanost) => {
    mockFetch({});
    procjenaOdgovor = (t) => claudeStream(t.tools[0].input_schema.required.includes('korekcije')
      ? korekcijeJson({ pouzdanost })
      : procjenaJson({ fer_vrijednost: { ...PROCJENA.fer_vrijednost, pouzdanost } }));
    const a = (await pozovi({ email, ...tijelo })).body.rezultat.analiza;
    return [a.fer_vrijednost.pouzdanost, a.najam.pouzdanost];
  };
  assert.deepEqual(await slucaj('p1@primjer.hr', { oglas_tekst: 'Stan', podaci: { grad: 'Zagreb', kvart: 'Trnje' } }, 'visoka'), ['srednja', 'srednja']);
  assert.deepEqual(await slucaj('p2@primjer.hr', { oglas_tekst: 'Stan', podaci: { grad: 'Zagreb' } }, 'srednja'), ['srednja', 'srednja']);
  assert.deepEqual(await slucaj('p3@primjer.hr', { oglas_tekst: 'Stan', podaci: { grad: 'Zagreb' } }, 'niska'), ['niska', 'niska']);
  assert.deepEqual(await slucaj('p4@primjer.hr', { oglas_tekst: 'Stan', podaci: { grad: 'Makarska' } }, 'srednja'), ['niska', 'niska']);
});

test('prompt: poziv 1 i 2 dobivaju današnji datum i gotovu starost zgrade i renovacije iz koda', async () => {
  mockFetch({});
  const poruke = {};
  const prije = { p: procjenaOdgovor, a: claudeOdgovor };
  procjenaOdgovor = (t) => { poruke.procjena = t.messages[0].content; return zadanaProcjena(t); };
  claudeOdgovor = (t) => { poruke.analiza = t.messages[0].content; return claudeStream(izvjestajJson()); };
  try {
    const r = await pozovi({
      email: 'datum@primjer.hr', oglas_tekst: 'Stan u Splitu, renovirano 2015. godine.', request_id: 'req-datum-001',
      podaci: { cijena_eur: 240000, povrsina_m2: 72, grad: 'Split', godina_gradnje: 1980 },
    });
    assert.equal(r.status, 200);
    const godina = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric' }).format(new Date()));
    for (const naziv of ['procjena', 'analiza']) {
      assert.match(poruke[naziv], new RegExp(`Današnji datum: ${godina}-\\d\\d-\\d\\d`), `${naziv}: datum`);
      assert.ok(poruke[naziv].includes(`Starost zgrade: ${godina - 1980} godina`), `${naziv}: starost`);
      assert.ok(poruke[naziv].includes(`Renovacija prema oglasu: 2015. (prije ${godina - 2015} godina)`), `${naziv}: renovacija`);
    }
  } finally {
    procjenaOdgovor = prije.p; claudeOdgovor = prije.a;
  }
});

// ── kvart iz podataka: medijan k.o. umjesto gradskog; korekcija lokacije se odbacuje ──
test('Središće s tipfelerom: polazište je medijan k.o. Zaprudski Otok; korekcija za lokaciju koju model vrati se odbacuje', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  procjenaOdgovor = () => claudeStream(korekcijeJson({
    korekcije: [{ razlog: 'Središće', postotak: 5 }, { razlog: 'dobra mikrolokacija', postotak: 4 }, { razlog: 'renovirano', postotak: 8 }, { razlog: 'bez parkinga', postotak: -5 }],
    povrsina_m2: 130.45,
  }));
  const r = await pozovi({
    email: 'ko1@primjer.hr', oglas_tekst: 'Stan, Središće.', podaci: { grad: 'Zagreb', kvart: 'sredušće', povrsina_m2: 130.45 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = referencaPoruka(pozivi[0].poruke);
  assert.ok(ref.includes('katastarska općina Zaprudski Otok (Grad Zagreb)') && ref.includes('3345 €/m²'), ref);
  assert.match(pozivi[0].sustav, /medijan KATASTARSKE OPĆINE kvarta[\s\S]*NE vraćaj nikakvu korekciju za lokaciju/);
  assert.doesNotMatch(pozivi[0].sustav, /kvart i mikrolokaciju \(medijan cijelog grada/);
  const fer = r.body.rezultat.analiza.fer_vrijednost;
  assert.equal(fer.izracun.polaziste_m2, 3345);
  assert.deepEqual(fer.izracun.korekcije, [{ razlog: 'renovirano', postotak: 8 }, { razlog: 'bez parkinga', postotak: -5 }]);
  assert.ok(fer.obrazlozenje.startsWith('Polazište: medijan k.o. Zaprudski Otok (usklađen DZS indeksom) 3.345 €/m².'), fer.obrazlozenje);
  assert.equal(fer.pouzdanost, 'srednja');
  assert.equal(r.body.rezultat.referenca.ko, 'Zaprudski Otok');
});

test('nepoznat kvart: gradski medijan, model dobiva ranije upute (kvart smije korigirati), obrazloženje nosi oznaku', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  procjenaOdgovor = () => claudeStream(korekcijeJson({ korekcije: [{ razlog: 'kvart', postotak: 3 }], povrsina_m2: 72 }));
  const r = await pozovi({ email: 'ko2@primjer.hr', oglas_tekst: 'Stan.', podaci: { grad: 'Zagreb', kvart: 'Utrine', povrsina_m2: 72 } });
  assert.equal(r.status, 200);
  assert.match(pozivi[0].sustav, /kvart i mikrolokaciju \(medijan cijelog grada/);
  const fer = r.body.rezultat.analiza.fer_vrijednost;
  assert.equal(fer.izracun.polaziste_m2, 3312);
  assert.deepEqual(fer.izracun.korekcije, [{ razlog: 'kvart', postotak: 3 }]);
  assert.ok(fer.obrazlozenje.includes('Kvart „Utrine” nije mapiran na k.o.: gradski medijan.'), fer.obrazlozenje);
  assert.equal(r.body.rezultat.referenca.napomena_kvart, 'Kvart „Utrine” nije mapiran na k.o.: gradski medijan.');
});

// ── sažetak: gotovi brojevi od koda, validacija krivih brojki ──
test('poziv 2 dobiva gotove brojeve sažetka (cijena iz forme); sažetak s izmišljenim postotkom se odbija i ponavlja', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  let n2 = 0;
  claudeOdgovor = () => {
    n2++;
    return claudeStream(izvjestajJson({ cijena_eur: 400000, preporuka: 'oprez', ocjena: 2,
      sazetak: n2 === 1 ? 'Cijena je 3 % iznad raspona.' : 'Cijena je iznad raspona; vidi izračun.' }));
  };
  const r = await pozovi({ email: 'saz1@primjer.hr', oglas_tekst: 'Stan, Zagreb.', podaci: { cijena_eur: 400000, grad: 'Zagreb', povrsina_m2: 72 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const analize = pozivi.filter((p) => p.alat === 'izvjestaj');
  assert.equal(analize.length, 2, 'prvi sažetak nije prošao validaciju → jedan ponovni pokušaj');
  const fer = r.body.rezultat.analiza.fer_vrijednost;
  const iznad = 400000 - fer.max_eur;
  const ocekivano = `${String(iznad).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} € (${(Math.round(iznad / fer.max_eur * 1000) / 10).toString().replace('.', ',')} % iznad gornje granice raspona)`;
  for (const p of analize) assert.ok(p.poruke.includes(ocekivano), `${ocekivano} u: ${p.poruke}`);
  assert.match(analize[0].sustav, /Gotovi brojevi za sažetak/);
  assert.equal(r.body.rezultat.analiza.sazetak, 'Cijena je iznad raspona; vidi izračun.');
});

test('cijena samo u tekstu oglasa: poziv 2 ne dobiva brojke razlike i traži opisni sažetak', async () => {
  mockFetch({});
  const pozivi = bilježiPozive();
  const r = await pozovi({ email: 'saz2@primjer.hr', oglas_tekst: 'Stan, Split, 72 m², 240.000 €.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const poruka = pozivi.find((p) => p.alat === 'izvjestaj').poruke;
  assert.match(poruka, /Razlika cijene i raspona nije izračunata/);
});
