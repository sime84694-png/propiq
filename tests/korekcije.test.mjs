// Testovi determinističnih korekcija (netlify/lib/korekcije.mjs): model izvlači činjenice, postotke daje tablica pravila PropIQ-a.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import I from '../public/assets/js/izracuni.js';
import {
  TABLICA, CINJENICE_SHEMA, izvuciLift, izvuciKat, izvuciGodinuGradnje, izvuciGodinuObnove, klasificirajStanje, citatUOglasu, skupiCinjenice, korekcijeIzCinjenica,
} from '../netlify/lib/korekcije.mjs';
import { parsirajIValidirajProcjenu } from '../netlify/lib/izvjestaj.mjs';

const { FER } = I;
const GODINA = 2026;
const SADA = new Date('2026-06-15T12:00:00Z');
const najam = { dugorocni_mj_eur: 1000, turisticki_godisnje_eur: null };

// ── činjenice → postoci (tablica) ──
const NEP = { vrijednost: 'nepoznato', izvor: null };
const c = (promjene = {}) => ({
  lift: NEP, kat: { vrijednost: null, izvor: null }, godina_gradnje: { vrijednost: null, izvor: null }, parking: NEP, stanje: NEP,
  godina_obnove: { vrijednost: null, izvor: null }, energetski_razred: NEP, pogled_na_more: NEP, povrsina_m2: { vrijednost: null, izvor: null },
  ...Object.fromEntries(Object.entries(promjene).map(([k, v]) => [k, v !== null && typeof v === 'object' ? v : { vrijednost: v, izvor: 'test' }])),
});
const posto = (promjene) => korekcijeIzCinjenica(c(promjene), { godina: GODINA }).map((k) => k.postotak);
const zbroj = (promjene) => posto(promjene).reduce((a, b) => a + b, 0);

test('lift i kat: bez lifta ovisi o katu; lift se računa tek od 3. kata; prizemlje samo kad lift ne daje korekciju', () => {
  assert.deepEqual(posto({ lift: 'ne', kat: 4 }), [-6]);
  assert.deepEqual(posto({ lift: 'ne', kat: 7 }), [-6]);
  assert.deepEqual(posto({ lift: 'ne', kat: 3 }), [-3]);
  assert.deepEqual(posto({ lift: 'ne', kat: 2 }), []);
  assert.deepEqual(posto({ lift: 'ne', kat: null }), [-2], 'kat nepoznat');
  assert.deepEqual(posto({ lift: 'da', kat: 3 }), [2]);
  assert.deepEqual(posto({ lift: 'da', kat: 2 }), []);
  assert.deepEqual(posto({ lift: 'da' }), [], 'lift bez poznatog kata');
  assert.deepEqual(posto({ lift: 'ne', kat: 0 }), [-3], 'prizemlje bez lifta: lift 0 %, prizemlje −3 %');
  assert.deepEqual(posto({ kat: 0 }), [-3]);
  assert.deepEqual(posto({ lift: 'nepoznato', kat: 5 }), [], 'lift nepoznat: nema korekcije ni za visoki kat');
});

test('parking: vlastito +3, garaža +5, javno i nepoznato 0', () => {
  assert.deepEqual(posto({ parking: 'vlastito' }), [3]);
  assert.deepEqual(posto({ parking: 'garaza' }), [5]);
  assert.deepEqual(posto({ parking: 'javno' }), []);
  assert.deepEqual(posto({ parking: 'nepoznato' }), []);
});

test('starost zgrade: samo bonusi za novu gradnju; starija gradnja se nikad ne kažnjava', () => {
  const s = (g) => posto({ godina_gradnje: g });
  assert.deepEqual([s(2026), s(2024), s(2021)], [[8], [8], [8]], '0–5 god.');
  assert.deepEqual([s(2020), s(2011)], [[3], [3]], '6–15 god.');
  assert.deepEqual([s(2010), s(1985), s(1963), s(1900)], [[], [], [], []], 'starije: 0 %, nikad negativno');
  assert.deepEqual(s(2030), [], 'buduća godina: nema pravila');
});

test('stanje: obnova do 10 god. +5, bez godine +2, starija 0; djelomična +2; za renovaciju −6; useljivo 0', () => {
  const st = (stanje, godina_obnove = null, godina_gradnje = null) => posto({ stanje, godina_obnove, godina_gradnje });
  assert.deepEqual(st('renovirano', 2020), [5]);
  assert.deepEqual(st('renovirano', 2016), [5], 'točno 10 godina');
  assert.deepEqual(st('renovirano', 2015, 1985), [], 'obnova starija od 10 god. vrijedi 0, a starost 1985. ne kažnjava');
  assert.deepEqual(st('renovirano'), [2], 'godina obnove nije navedena: konzervativno +2');
  assert.deepEqual(st('djelomicno'), [2]);
  assert.deepEqual(st('za_renovaciju'), [-6]);
  assert.deepEqual(st('useljivo'), []);
});

test('stanje prebrisuje starost (jedna stavka u skupini); stare zgrade dobivaju korekciju samo kroz "za renovaciju"', () => {
  const nova = { godina_gradnje: 2024 };
  assert.deepEqual(posto({ ...nova }), [8]);
  assert.deepEqual(posto({ ...nova, stanje: 'djelomicno' }), [2], 'stanje zamjenjuje bonus za novu gradnju');
  assert.deepEqual(posto({ ...nova, stanje: 'renovirano', godina_obnove: 2025 }), [5]);
  assert.deepEqual(posto({ ...nova, stanje: 'useljivo' }), [8], 'useljivo je 0 pa ostaje starost');
  assert.deepEqual(posto({ godina_gradnje: 1960, stanje: 'za_renovaciju' }), [-6]);
  assert.deepEqual(posto({ godina_gradnje: 1960 }), [], 'kamena kuća u centru: bez korekcije za starost');
});

test('energetski razred: A+/A/B +2, C/D 0, E/F/G −2', () => {
  for (const [r, p] of [['A+', [2]], ['A', [2]], ['B', [2]], ['C', []], ['D', []], ['E', [-2]], ['F', [-2]], ['G', [-2]], ['nepoznato', []]]) {
    assert.deepEqual(posto({ energetski_razred: r }), p, r);
  }
});

test('površina: granice pragova', () => {
  const p = (m2) => posto({ povrsina_m2: m2 });
  assert.deepEqual([p(25), p(29.99)], [[5], [5]]);
  assert.deepEqual([p(30), p(39.99)], [[2], [2]]);
  assert.deepEqual([p(40), p(58), p(80)], [[], [], []]);
  assert.deepEqual([p(80.01), p(120)], [[-2], [-2]]);
  assert.deepEqual([p(120.01), p(200)], [[-4], [-4]]);
});

test('pogled na more +8; blizina mora bez pogleda ne postoji u tablici', () => {
  assert.deepEqual(posto({ pogled_na_more: 'da' }), [8]);
  assert.deepEqual(posto({ pogled_na_more: 'nepoznato' }), []);
  assert.equal(TABLICA.pogled_na_more, 8);
});

test('ukupna korekcija ograničena na ±15 %; najviše jedna stavka po skupini (6 stavki), razlozi staju u MAX_RAZLOG', () => {
  assert.equal(FER.MAX_ZBROJ, 15);
  const sve = c({
    lift: 'da', kat: 5, parking: 'garaza', godina_gradnje: 2025, energetski_razred: 'A+', povrsina_m2: 25, pogled_na_more: 'da',
  });
  const k = korekcijeIzCinjenica(sve, { godina: GODINA });
  assert.ok(k.length <= FER.MAX_STAVKI);
  assert.equal(k.reduce((a, b) => a + b.postotak, 0), 2 + 5 + 8 + 2 + 5 + 8, 'zbroj prije ograničenja');
  const r = I.izracunajFer({ medijan_eur_m2: 3000, korekcije: k, pouzdanost: 'niska', povrsina_m2: 25 });
  assert.equal(r.izracun.zbroj_primijenjen_posto, 15);
  assert.match(I.obrazlozenjeFer(r.izracun), /ograničen s \+30% na \+15%/);
  const najgore = korekcijeIzCinjenica(c({ lift: 'ne', kat: 6, godina_gradnje: 1960, stanje: 'za_renovaciju', energetski_razred: 'G', povrsina_m2: 150, parking: 'javno' }), { godina: GODINA });
  assert.equal(I.izracunajFer({ medijan_eur_m2: 3000, korekcije: najgore, pouzdanost: 'niska' }).izracun.zbroj_primijenjen_posto, -15);
  for (const x of [...k, ...najgore]) assert.ok(x.razlog.length <= FER.MAX_RAZLOG, x.razlog);
});

test('tablica nema pravila za lokaciju ni kvart (lokacija je već u medijanu)', () => {
  assert.deepEqual(Object.keys(TABLICA).sort(), ['energetski', 'lift_da', 'lift_ne', 'parking', 'pogled_na_more', 'povrsina', 'prizemlje', 'stanje', 'starost']);
  assert.ok(!('kvart' in CINJENICE_SHEMA.properties) && !('lokacija' in CINJENICE_SHEMA.properties));
});

// ── predekstrakcija u kodu ──
test('izvuciLift: jednoznačno da/ne; zaziranje, protivrječje i nejasan navod nisu odluka', () => {
  assert.equal(izvuciLift('Stan, 3. kat, bez lifta.'), 'ne');
  assert.equal(izvuciLift('Zgrada nema lift.'), 'ne');
  assert.equal(izvuciLift('Nema dizala'), 'ne');
  assert.equal(izvuciLift('Lift: ne'), 'ne');
  assert.equal(izvuciLift('Stan u zgradi s liftom.'), 'da');
  assert.equal(izvuciLift('Zgrada ima lift, 2 parkirna mjesta'), 'da');
  assert.equal(izvuciLift('Lift: da'), 'da');
  assert.equal(izvuciLift('Stan na prvom katu, useljiv.'), undefined, 'lift se ne spominje');
  assert.notEqual(izvuciLift('Bez lifta, ali zgrada ima lift.'), 'ne', 'protivrječje');
  assert.notEqual(izvuciLift('Mogućnost ugradnje lifta.'), 'da');
  assert.notEqual(izvuciLift('Mogućnost ugradnje lifta.'), 'ne');
  assert.notEqual(izvuciLift('Lift ne radi.'), 'ne', 'lift koji ne radi nije "nema lifta"');
  assert.notEqual(izvuciLift('Lift u izgradnji.'), 'da');
});

test('izvuciKat: redni brojevi, "kat: 2/4", prizemlje; visina zgrade i dvosmislenost nisu kat', () => {
  assert.equal(izvuciKat('Stan na 2. katu.'), 2);
  assert.equal(izvuciKat('Stan, 3. kat, bez lifta'), 3);
  assert.equal(izvuciKat('Kat: 4'), 4);
  assert.equal(izvuciKat('Kat 2/5'), 2);
  assert.equal(izvuciKat('Stan na drugom katu'), 2);
  assert.equal(izvuciKat('Prvi kat, 58 m2'), 1);
  assert.equal(izvuciKat('Stan u prizemlju'), 0);
  assert.equal(izvuciKat('Zgrada ima 4 kata i lift.'), undefined, 'visina zgrade nije kat stana');
  assert.equal(izvuciKat('Zgrada od 5 katova.'), undefined);
  assert.ok(typeof izvuciKat('Stan na 2. katu ili 3. kat') !== 'number', 'dva različita kata: nije jednoznačno');
  assert.notEqual(izvuciKat('Stan na 2. katu, prizemlje je poslovni prostor'), 2, 'dva kata spomenuta: nije jednoznačno');
  assert.ok(typeof izvuciKat('Visoko prizemlje') !== 'number', 'visoko prizemlje nije ni prizemlje ni kat');
  assert.equal(izvuciKat('Stan 58 m2, Zadar'), undefined);
});

test('izvuciGodinuGradnje: izgrađen/sagrađen/godina gradnje; raspon i obnova nisu godina gradnje', () => {
  assert.equal(izvuciGodinuGradnje('Stan, izgrađen 1985., 2. kat.', GODINA), 1985);
  assert.equal(izvuciGodinuGradnje('Zgrada sagrađena 1963. godine', GODINA), 1963);
  assert.equal(izvuciGodinuGradnje('Godina gradnje: 1998', GODINA), 1998);
  assert.equal(izvuciGodinuGradnje('1975. godine izgrađena zgrada', GODINA), 1975);
  assert.equal(izvuciGodinuGradnje('Izgrađen 1985., obnovljen 2019.', GODINA), 1985, 'godina obnove nije godina gradnje');
  assert.equal(izvuciGodinuGradnje('PVC stolarija 2019.', GODINA), undefined);
  assert.notEqual(izvuciGodinuGradnje('Izgrađen 1960.-1970.', GODINA), 1960, 'raspon nije jednoznačan');
  assert.notEqual(typeof izvuciGodinuGradnje('Izgrađen 1960. do 1970.', GODINA), 'number');
  assert.notEqual(typeof izvuciGodinuGradnje('Izgrađen 1985., sagrađen 1990.', GODINA), 'number', 'dvije različite godine');
  assert.equal(izvuciGodinuGradnje('Izgradnja 2031.', GODINA), undefined, 'buduća godina');
});

test('izvuciGodinuObnove: samo jedina navedena godina obnove', () => {
  assert.equal(izvuciGodinuObnove('Potpuno renoviran 2021.', GODINA), 2021);
  assert.equal(izvuciGodinuObnove('Obnovljena kupaonica 2018. i renovirana kuhinja 2022.', GODINA), null);
  assert.equal(izvuciGodinuObnove('PVC stolarija 2019.', GODINA), null);
});

// ── skupljanje činjenica: forma > kod > model uz citat ──
const OGLAS = 'Stan u Zadru, Relja, 58 m², izgrađen 1985., bez lifta, javno parkiralište u blizini, PVC stolarija 2019.';
const model = (promjene = {}) => ({
  lift: { vrijednost: 'nepoznato', citat: '' }, kat: { vrijednost: null, citat: '' }, godina_gradnje: { vrijednost: null, citat: '' },
  parking: { vrijednost: 'nepoznato', citat: '' }, stanje: { vrijednost: 'nepoznato', citat: '' }, energetski_razred: { vrijednost: 'nepoznato', citat: '' },
  pogled_na_more: { vrijednost: 'nepoznato', citat: '' }, ...promjene,
});
const skupi = (m, oglas = OGLAS, podaci = {}, povrsinaModel = null) => skupiCinjenice({ model: m, oglas, podaci, godina: GODINA, povrsinaModel });

test('prednost izvora: forma > kod > model; model ne može nadjačati jednoznačan podatak u oglasu', () => {
  const a = skupi(model({ lift: { vrijednost: 'da', citat: 'bez lifta' } }), OGLAS, { lift: 'da' });
  assert.deepEqual(a.cinjenice.lift, { vrijednost: 'da', izvor: 'forma' });
  const b = skupi(model({ lift: { vrijednost: 'da', citat: 'bez lifta' } }));
  assert.deepEqual(b.cinjenice.lift, { vrijednost: 'ne', izvor: 'kod' }, 'oglas kaže "bez lifta", model je pogriješio');
  assert.deepEqual(b.cinjenice.godina_gradnje, { vrijednost: 1985, izvor: 'kod' });
  const d = skupi(model(), OGLAS, { kat: 3, godina_gradnje: 1990 });
  assert.deepEqual([d.cinjenice.kat, d.cinjenice.godina_gradnje], [{ vrijednost: 3, izvor: 'forma' }, { vrijednost: 1990, izvor: 'forma' }]);
});

test('model: činjenica bez citata u oglasu je "nepoznato" (0 %); s citatom prolazi', () => {
  const bez = skupi(model({ energetski_razred: { vrijednost: 'A', citat: 'energetski razred A' } }));
  assert.equal(bez.cinjenice.energetski_razred.vrijednost, 'nepoznato');
  assert.deepEqual(bez.odbaceno.map((o) => [o.cinjenica, o.uzrok]), [['energetski_razred', 'citat nije u oglasu']]);
  const s = skupi(model({ energetski_razred: { vrijednost: 'B', citat: 'Energetski razred B' } }), `${OGLAS} Energetski razred B.`);
  assert.deepEqual(s.cinjenice.energetski_razred, { vrijednost: 'B', izvor: 'model' });
  assert.equal(skupi(model({ energetski_razred: { vrijednost: 'A', citat: 'Energetski razred B' } }), `${OGLAS} Energetski razred B.`).cinjenice.energetski_razred.vrijednost, 'nepoznato', 'razred u citatu ne odgovara vrijednosti');
  assert.equal(citatUOglasu('IZGRAĐEN 1985', OGLAS), true, 'neosjetljivo na velika slova i dijakritike');
  assert.equal(citatUOglasu('izgrađen 1963', OGLAS), false);
  assert.equal(citatUOglasu('', OGLAS), false);
});

test('pogled na more: bez citata = nepoznato (0 %); blizina mora nije pogled; jasan ekvivalent prolazi', () => {
  const ad = 'Stan 60 m2, 100 m do mora, pogled na more s terase, blizu plaže.';
  const ima = (tekst, citat, vrijednost = 'da') => skupi(model({ pogled_na_more: { vrijednost, citat } }), tekst).cinjenice.pogled_na_more.vrijednost;
  assert.equal(ima(ad, 'pogled na more s terase'), 'da');
  assert.equal(ima('Stan s morskim pogledom.', 'morskim pogledom'), 'da', 'ekvivalent');
  assert.equal(ima('Stan s pogledom prema moru.', 'pogledom prema moru'), 'da');
  assert.equal(ima(ad, ''), 'nepoznato', 'bez citata');
  assert.equal(ima(ad, 'pogled na more i otoke'), 'nepoznato', 'citata nema u oglasu');
  assert.equal(ima(ad, '100 m do mora'), 'nepoznato', 'blizina mora nije pogled');
  assert.equal(ima(ad, 'blizu plaže'), 'nepoznato');
  assert.equal(ima('Bez pogleda na more.', 'Bez pogleda na more'), 'nepoznato');
  // bez citata model dobiva 0 %, s citatom +8 %
  assert.deepEqual(posto({ pogled_na_more: skupi(model({ pogled_na_more: { vrijednost: 'da', citat: '' } }), ad).cinjenice.pogled_na_more }), []);
  assert.deepEqual(posto({ pogled_na_more: skupi(model({ pogled_na_more: { vrijednost: 'da', citat: 'pogled na more s terase' } }), ad).cinjenice.pogled_na_more }), [8]);
});

test('parking: javni parking ne može biti vlastiti; vlastito i garaža traže izričit navod', () => {
  const p = (tekst, citat, vrijednost, podaci = {}) => skupi(model({ parking: { vrijednost, citat } }), tekst, podaci).cinjenice.parking.vrijednost;
  assert.equal(p(OGLAS, 'javno parkiralište u blizini', 'vlastito'), 'nepoznato');
  assert.equal(p(OGLAS, 'javno parkiralište u blizini', 'javno'), 'javno');
  assert.equal(p('Stan s garažom.', 'garažom', 'garaza'), 'garaza');
  assert.equal(p('Stan, parkirno mjesto u cijeni.', 'parkirno mjesto u cijeni', 'vlastito'), 'vlastito');
  assert.equal(p('Stan, parkirno mjesto u blizini.', 'parkirno mjesto u blizini', 'vlastito'), 'nepoznato');
  assert.equal(p('Stan bez parkinga.', 'bez parkinga', 'vlastito'), 'nepoznato');
  assert.equal(p(OGLAS, '', 'nepoznato', { parking: 'da' }), 'vlastito', 'forma: da');
  assert.equal(p(OGLAS, 'javno parkiralište u blizini', 'vlastito', { parking: 'javni' }), 'javno', 'forma: javni');
  assert.equal(p('Stan s garažom.', 'garažom', 'garaza', { parking: 'da' }), 'garaza', 'forma da + oglas garaža');
  assert.equal(p('Stan.', '', 'nepoznato', { parking: 'ne' }), 'nepoznato');
});

test('stanje: kod klasificira citat; useljivo nije renovirano, jedan dio nije potpuna obnova', () => {
  assert.equal(klasificirajStanje('Potpuno namješten i odmah useljiv'), 'useljivo');
  assert.equal(klasificirajStanje('PVC stolarija 2019'), 'djelomicno');
  assert.equal(klasificirajStanje('nova stolarija'), 'djelomicno');
  assert.equal(klasificirajStanje('obnovljena kupaonica 2020'), 'djelomicno');
  assert.equal(klasificirajStanje('potpuno renovirano 2021'), 'renovirano');
  assert.equal(klasificirajStanje('adaptiran 2018'), 'renovirano');
  assert.equal(klasificirajStanje('stan za renovaciju'), 'za_renovaciju');
  assert.equal(klasificirajStanje('potrebno ulaganje'), 'za_renovaciju');
  assert.equal(klasificirajStanje('neuređen'), 'za_renovaciju');
  assert.equal(klasificirajStanje('2. kat'), 'nepoznato');
  const st = (citat, vrijednost, tekst = `Stan. ${citat}.`) => skupi(model({ stanje: { vrijednost, citat } }), tekst).cinjenice;
  assert.equal(st('Potpuno namješten i odmah useljiv', 'renovirano').stanje.vrijednost, 'useljivo', 'model tvrdi "renovirano", citat kaže useljivo');
  assert.equal(st('PVC stolarija 2019', 'renovirano').stanje.vrijednost, 'djelomicno');
  const r = st(`renoviran ${GODINA - 3}`, 'renovirano');
  assert.deepEqual([r.stanje.vrijednost, r.godina_obnove.vrijednost], ['renovirano', GODINA - 3], 'godina obnove iz citata');
  assert.equal(st('potpuno renovirano', 'renovirano', 'Stan, potpuno renovirano, obnovljeno 2022.').godina_obnove.vrijednost, 2022, 'jedina godina obnove u oglasu');
});

test('površina za pravilo veličine: forma, ili broj koji stvarno stoji u oglasu; izmišljen broj ne ulazi', () => {
  assert.deepEqual(skupi(model(), OGLAS, {}, 58).cinjenice.povrsina_m2, { vrijednost: 58, izvor: 'model' });
  assert.deepEqual(skupi(model(), OGLAS, {}, 25).cinjenice.povrsina_m2, { vrijednost: null, izvor: null }, '25 m² nema u oglasu');
  assert.deepEqual(skupi(model(), 'Stan 58,5 m2', {}, 58.5).cinjenice.povrsina_m2.vrijednost, 58.5);
  assert.deepEqual(skupi(model(), OGLAS, { povrsina_m2: 64 }, 25).cinjenice.povrsina_m2, { vrijednost: 64, izvor: 'forma' });
});

// ── isti oglas = isti raspon ──
// Slučaj iz izvještaja o grešci: Zadar, Relja, 58 m², 1985., bez lifta, javno parkiralište, PVC stolarija 2019.
// Korekcije su ranije varirale (−3 %, −5 %, 0 %) pa se raspon pomicao za 5.000–10.000 €.
const kontekst = (promjene = {}) => ({
  medijan_eur_m2: 3117, najvisaPouzdanost: 'niska', naziv: 'Zadar', napomena: 'Za kvart Relja nemamo podatke.', bezLokacije: true,
  lokacijaRijeci: ['Relja', 'Zadar'], izvori: { oglas: OGLAS, podaci: {} }, sada: SADA, ...promjene,
});
const odgovor = (promjene = {}) => JSON.stringify({ cinjenice: model(), povrsina_m2: 58, najam, ...promjene });
const raspon = (v) => [v.procjena.fer_vrijednost.min_eur, v.procjena.fer_vrijednost.max_eur];

test('isti oglas 3× daje isti raspon, i kad model različito formulira, ispusti ili pogriješi činjenice', () => {
  const varijante = [
    odgovor({ cinjenice: model({ lift: { vrijednost: 'ne', citat: 'bez lifta' }, parking: { vrijednost: 'javno', citat: 'javno parkiralište u blizini' }, stanje: { vrijednost: 'djelomicno', citat: 'PVC stolarija 2019' } }) }),
    // model ispušta lift (kod ga nalazi sam) i drukčije piše citate (velika slova, dijakritici)
    odgovor({ cinjenice: model({ parking: { vrijednost: 'javno', citat: 'JAVNO PARKIRALISTE' }, stanje: { vrijednost: 'djelomicno', citat: 'pvc stolarija 2019.' } }) }),
    // model griješi: lift "da", parking "vlastito" uz citat javnog parkinga, stanje "renovirano" uz citat stolarije, izmišljen pogled na more bez citata
    odgovor({ cinjenice: model({ lift: { vrijednost: 'da', citat: 'bez lifta' }, parking: { vrijednost: 'vlastito', citat: 'javno parkiralište u blizini' }, stanje: { vrijednost: 'renovirano', citat: 'PVC stolarija 2019' }, pogled_na_more: { vrijednost: 'da', citat: '' } }), pouzdanost: 'visoka', korekcije: [{ razlog: 'lift', postotak: -3, izvor: 'bez lifta' }] }),
    // model ne zna ništa o stanju: bez citata nema korekcije (+2 % za stolariju se gubi), ali to je ISTI ulaz modela samo u 3. pokretanju
  ];
  const rasponi = varijante.map((t) => raspon(parsirajIValidirajProcjenu(t, kontekst())));
  assert.deepEqual(rasponi[0], rasponi[1]);
  assert.deepEqual(rasponi[0], rasponi[2]);
  // izračun: bez lifta (kat nepoznat) −2 %, djelomična obnova +2 %, gradnja 1985. 0 %, 58 m² 0 % → zbroj 0 %: 3117 €/m² ±10 %, 58 m²
  const v = parsirajIValidirajProcjenu(varijante[0], kontekst());
  assert.deepEqual(v.procjena.fer_vrijednost.izracun.korekcije, [{ razlog: 'bez lifta', postotak: -2 }, { razlog: 'djelomična obnova', postotak: 2 }]);
  assert.equal(v.procjena.fer_vrijednost.izracun.zbroj_posto, 0);
  assert.deepEqual(rasponi[0], [165000, 200000]);
  // doslovno isti odgovor 3× = identičan cijeli rezultat (korekcije, obrazloženje, brojke)
  const tri = [1, 2, 3].map(() => parsirajIValidirajProcjenu(varijante[0], kontekst()));
  assert.deepEqual(tri[0], tri[1]);
  assert.deepEqual(tri[0], tri[2]);
});

test('bez citata za stanje (model ništa ne izvuče) korekcija je 0 %, nikad slobodan postotak; pogled na more bez citata = 0 %', () => {
  const v = parsirajIValidirajProcjenu(odgovor({ cinjenice: model({ pogled_na_more: { vrijednost: 'da', citat: '' } }) }), kontekst());
  assert.equal(v.ok, true);
  assert.deepEqual(v.procjena.fer_vrijednost.izracun.korekcije, [{ razlog: 'bez lifta', postotak: -2 }]);
  assert.ok(!/more/.test(v.procjena.fer_vrijednost.obrazlozenje));
  const sCitatom = parsirajIValidirajProcjenu(odgovor({ cinjenice: model({ pogled_na_more: { vrijednost: 'da', citat: 'pogled na more' } }) }), kontekst({ izvori: { oglas: `${OGLAS} Pogled na more.`, podaci: {} } }));
  assert.ok(sCitatom.procjena.fer_vrijednost.izracun.korekcije.some((k) => k.razlog === 'pogled na more' && k.postotak === 8));
});

test('obrazloženje korekcije kaže da su to pravila PropIQ-a', () => {
  const v = parsirajIValidirajProcjenu(odgovor(), kontekst());
  assert.match(v.procjena.fer_vrijednost.obrazlozenje, /Korekcije \(pravila PropIQ-a\): −2% bez lifta/);
  assert.ok(v.procjena.fer_vrijednost.obrazlozenje.length <= 350, `${v.procjena.fer_vrijednost.obrazlozenje.length}`);
});

test('pouzdanost dolazi iz razine reference, ne iz modela: niska za grad bez kvarta, srednja za k.o., visoka za kvart', () => {
  for (const [granica, ocekivano, sirina] of [['niska', 'niska', 10], ['srednja', 'srednja', 7], ['visoka', 'visoka', 5], [null, 'niska', 10]]) {
    const v = parsirajIValidirajProcjenu(odgovor({ pouzdanost: 'visoka' }), kontekst({ najvisaPouzdanost: granica }));
    assert.equal(v.procjena.fer_vrijednost.pouzdanost, ocekivano);
    assert.equal(v.procjena.fer_vrijednost.izracun.sirina_posto, sirina);
  }
});

test('svaka korekcija ima izvor: bez forme i bez teksta oglasa činjenice su nepoznate i korekcija nema', () => {
  const v = parsirajIValidirajProcjenu(odgovor({ cinjenice: model({ lift: { vrijednost: 'ne', citat: 'bez lifta' }, stanje: { vrijednost: 'za_renovaciju', citat: 'za renovaciju' } }) }), kontekst({ izvori: { oglas: '', podaci: {} } }));
  assert.deepEqual(v.procjena.fer_vrijednost.izracun.korekcije, [], 'citata nema u (praznom) oglasu');
  assert.deepEqual(v.odbaceno.map((o) => o.uzrok), ['citat nije u oglasu', 'citat nije u oglasu']);
  const sFormom = parsirajIValidirajProcjenu(odgovor(), kontekst({ izvori: { oglas: '', podaci: { lift: 'ne', kat: 4 } } }));
  assert.deepEqual(sFormom.procjena.fer_vrijednost.izracun.korekcije, [{ razlog: 'bez lifta, 4. kat', postotak: -6 }], 'polja forme su izvor i bez teksta oglasa');
});
