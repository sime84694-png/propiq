// Testovi izračuna fer vrijednosti iz korekcija (public/assets/js/izracuni.js + netlify/lib/izvjestaj.mjs).
// Model predlaže samo korekcije u postocima; središnja €/m², raspon i ukupni € računaju se u kodu.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import I from '../public/assets/js/izracuni.js';
import {
  parsirajIValidirajProcjenu, validirajAnalizu, izracunaj, jeKorekcijaLokacije, cinjeniceSazetka, tekstCinjenicaSazetka, provjeriSazetak,
} from '../netlify/lib/izvjestaj.mjs';

const { FER, izracunajFer, ocistiKorekcije, obrazlozenjeFer } = I;
const najam = { dugorocni_mj_eur: 1400, turisticki_godisnje_eur: null };

// Slučaj iz izvještaja o grešci: Zagreb, Središće, 130,45 m², usklađeni medijan 3312 €/m², zbroj +7%.
const SREDISCE = [
  { razlog: 'Središće', postotak: 5 }, { razlog: 'renovacija', postotak: 8 }, { razlog: 'parking', postotak: -5 },
  { razlog: 'veliki stan', postotak: -3 }, { razlog: 'lift/kat', postotak: 2 },
];
const ulaz = (promjene = {}) => ({ medijan_eur_m2: 3312, korekcije: SREDISCE, pouzdanost: 'srednja', povrsina_m2: 130.45, naziv: 'Zagreb', ...promjene });

test('zadane korekcije daju točan raspon (Zagreb, Središće, 130,45 m²)', () => {
  const r = izracunajFer(ulaz());
  const iz = r.izracun;
  assert.equal(iz.zbroj_posto, 7);
  assert.equal(iz.sredina_m2, Math.round(3312 * 1.07)); // 3544
  assert.equal(iz.sirina_posto, 7);
  assert.deepEqual(iz.raspon_m2, { min: Math.round(3544 * 0.93), max: Math.round(3544 * 1.07) }); // 3296–3792
  assert.equal(r.min_eur, Math.round((3296 * 130.45) / 5000) * 5000); // 430.000
  assert.equal(r.max_eur, Math.round((3792 * 130.45) / 5000) * 5000); // 495.000
  assert.equal(r.min_eur % 5000, 0);
  assert.equal(r.max_eur % 5000, 0);
});

test('širina raspona ovisi o pouzdanosti: visoka ±5 %, srednja ±7 %, niska ±10 %', () => {
  assert.deepEqual(FER.SIRINA_POSTO, { visoka: 5, srednja: 7, niska: 10 });
  for (const [p, w] of [['visoka', 5], ['srednja', 7], ['niska', 10]]) {
    const iz = izracunajFer(ulaz({ pouzdanost: p })).izracun;
    assert.equal(iz.sirina_posto, w);
    assert.equal(iz.raspon_m2.min, Math.round(iz.sredina_m2 * (1 - w / 100)));
    assert.equal(iz.raspon_m2.max, Math.round(iz.sredina_m2 * (1 + w / 100)));
  }
  assert.equal(izracunajFer(ulaz({ pouzdanost: 'nepoznata' })), null);
});

test('isti popis korekcija uvijek daje isti raspon (deterministično, neovisno o ponavljanju)', () => {
  const prvi = JSON.stringify(izracunajFer(ulaz()));
  for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(izracunajFer(ulaz())), prvi);
  // i kroz cijeli put validacije (poziv 1)
  const tijelo = JSON.stringify({ korekcije: SREDISCE, pouzdanost: 'srednja', povrsina_m2: 130.45, najam });
  const kontekst = { medijan_eur_m2: 3312, naziv: 'Zagreb' };
  const a = parsirajIValidirajProcjenu(tijelo, kontekst);
  const b = parsirajIValidirajProcjenu(tijelo, kontekst);
  assert.equal(a.ok, true);
  assert.deepEqual(a, b);
  assert.deepEqual([a.procjena.fer_vrijednost.min_eur, a.procjena.fer_vrijednost.max_eur], [430000, 495000]);
});

test('pojedina korekcija je ograničena na −15…+15, cijela i s najviše 6 stavki', () => {
  const o = ocistiKorekcije([
    { razlog: 'a', postotak: 40 }, { razlog: 'b', postotak: -99 }, { razlog: 'c', postotak: 4.6 }, { razlog: 'd', postotak: -0.2 },
    { razlog: 'e', postotak: 1 }, { razlog: 'f', postotak: 2 }, { razlog: 'g', postotak: 3 }, { razlog: 'h', postotak: 4 },
  ]);
  assert.equal(o.length, FER.MAX_STAVKI);
  assert.deepEqual(o.map((k) => k.postotak), [15, -15, 5, 0, 1, 2]);
  assert.ok(o.every((k) => Number.isInteger(k.postotak) && Math.abs(k.postotak) <= 15 && !Object.is(k.postotak, -0)));
  assert.equal(ocistiKorekcije([{ razlog: 'x'.repeat(200), postotak: 1 }])[0].razlog.length, FER.MAX_RAZLOG);
  // razlog se reže na granici riječi, bez viseće interpunkcije
  assert.equal(ocistiKorekcije([{ razlog: 'renovirano 2015., vrhunski materijali, energetski razred A', postotak: 1 }])[0].razlog,
    'renovirano 2015., vrhunski materijali');
  assert.equal(ocistiKorekcije([{ razlog: 'bez lifta', postotak: -3 }])[0].razlog, 'bez lifta');
  // nevaljan oblik
  for (const lose of [null, 'tekst', [{ razlog: '', postotak: 1 }], [{ razlog: 'a', postotak: '5' }], [{ razlog: 'a', postotak: NaN }], [{ postotak: 3 }], [7]]) {
    assert.equal(ocistiKorekcije(lose), null, JSON.stringify(lose));
  }
  // idempotentno
  assert.deepEqual(ocistiKorekcije(o), o);
});

test('zbroj korekcija je ograničen na −30…+30', () => {
  const sve = (p) => Array.from({ length: 6 }, (_, i) => ({ razlog: `k${i}`, postotak: p }));
  const gore = izracunajFer(ulaz({ korekcije: sve(15) })).izracun; // zbroj 90 → 30
  assert.equal(gore.zbroj_posto, 90);
  assert.equal(gore.zbroj_primijenjen_posto, 30);
  assert.equal(gore.sredina_m2, Math.round(3312 * 1.3));
  const dolje = izracunajFer(ulaz({ korekcije: sve(-15) })).izracun;
  assert.equal(dolje.zbroj_primijenjen_posto, -30);
  assert.equal(dolje.sredina_m2, Math.round(3312 * 0.7));
  assert.match(obrazlozenjeFer(gore), /zbroj \+30% \(ograničen s \+90% na \+30%\)/);
  assert.equal(izracunajFer(ulaz({ korekcije: [] })).izracun.sredina_m2, 3312, 'bez korekcija = medijan');
});

test('min < max uvijek (i za male površine i granične slučajeve zaokruživanja)', () => {
  const pouzdanosti = Object.keys(FER.SIRINA_POSTO);
  for (const medijan of [500, 1500, 3312, 8000]) {
    for (const m2 of [5, 12.5, 20, 33.3, 72, 130.45, 400, 10000]) {
      for (const zbroj of [-30, -7, 0, 7, 30]) {
        for (const p of pouzdanosti) {
          const kor = zbroj === 0 ? [] : [{ razlog: 'z', postotak: Math.sign(zbroj) * Math.min(15, Math.abs(zbroj)) }, ...(Math.abs(zbroj) > 15 ? [{ razlog: 'y', postotak: Math.sign(zbroj) * (Math.abs(zbroj) - 15) }] : [])];
          const r = izracunajFer({ medijan_eur_m2: medijan, korekcije: kor, pouzdanost: p, povrsina_m2: m2 });
          assert.ok(r.izracun.raspon_m2.min < r.izracun.raspon_m2.max, `€/m² ${medijan}/${m2}/${zbroj}/${p}`);
          assert.ok(r.min_eur < r.max_eur, `€ ${medijan}/${m2}/${zbroj}/${p}: ${r.min_eur}–${r.max_eur}`);
          assert.ok(r.min_eur > 0 && r.min_eur % 5000 === 0 && r.max_eur % 5000 === 0);
        }
      }
    }
  }
});

test('bez površine nema ukupnih iznosa, ali ima €/m²; neispravan medijan ne daje izračun', () => {
  const r = izracunajFer(ulaz({ povrsina_m2: null }));
  assert.equal(r.min_eur, null);
  assert.equal(r.max_eur, null);
  assert.ok(r.izracun.raspon_m2.min < r.izracun.raspon_m2.max);
  assert.equal(izracunajFer(ulaz({ medijan_eur_m2: null })), null);
  assert.equal(izracunajFer(ulaz({ medijan_eur_m2: 0 })), null);
});

test('obrazloženje se slaže iz istih brojeva: polazište → korekcije → zbroj → raspon', () => {
  const r = izracunajFer(ulaz());
  assert.equal(obrazlozenjeFer(r.izracun),
    'Polazište: usklađeni medijan Zagreb 3.312 €/m². ' +
    'Korekcije: +5% Središće, +8% renovacija, −5% parking, −3% veliki stan, +2% lift/kat; zbroj +7%. ' +
    'Središnja 3.544 €/m², raspon ±7%: 3.296–3.792 €/m².');
  // brojke u tekstu su upravo one iz izračuna (min nikad iznad max)
  const brojevi = obrazlozenjeFer(r.izracun).match(/(\d\.\d{3})–(\d\.\d{3}) €\/m²/);
  assert.ok(Number(brojevi[1].replace('.', '')) < Number(brojevi[2].replace('.', '')));
  assert.match(obrazlozenjeFer(izracunajFer(ulaz({ korekcije: [] })).izracun), /bez korekcija; zbroj 0%/);
});

test('poziv 1: model ne vraća raspon; kod ga računa, površina iz forme ima prednost, pouzdanost je ograničena referencom', () => {
  const tijelo = (promjene = {}) => JSON.stringify({ korekcije: SREDISCE, pouzdanost: 'visoka', povrsina_m2: 100, najam, ...promjene });
  // površina iz forme (130,45) pobjeđuje onu koju je model prepisao (100)
  const a = parsirajIValidirajProcjenu(tijelo(), { medijan_eur_m2: 3312, povrsina_m2: 130.45, najvisaPouzdanost: 'srednja', naziv: 'Zagreb' });
  assert.equal(a.ok, true);
  const f = a.procjena.fer_vrijednost;
  assert.equal(f.pouzdanost, 'srednja', 'visoka → srednja prije računanja širine');
  assert.equal(f.izracun.sirina_posto, 7);
  assert.equal(f.izracun.povrsina_m2, 130.45);
  assert.equal(f.obrazlozenje, obrazlozenjeFer(f.izracun));
  // bez forme: površina koju je model prepisao iz oglasa
  const b = parsirajIValidirajProcjenu(tijelo({ pouzdanost: 'niska' }), { medijan_eur_m2: 3312, najvisaPouzdanost: 'srednja' });
  assert.equal(b.procjena.fer_vrijednost.izracun.povrsina_m2, 100);
  assert.equal(b.procjena.fer_vrijednost.izracun.sirina_posto, 10);
  // model koji unatoč shemi pošalje min_eur/max_eur: ignorira se
  const c = parsirajIValidirajProcjenu(tijelo({ min_eur: 1, max_eur: 2, fer_vrijednost: { min_eur: 1, max_eur: 2 } }), { medijan_eur_m2: 3312, povrsina_m2: 130.45 });
  assert.notEqual(c.procjena.fer_vrijednost.min_eur, 1);
  assert.ok(c.procjena.fer_vrijednost.min_eur < c.procjena.fer_vrijednost.max_eur);
  // korekcije kao JSON-kodiran tekst se raspakiraju, ali ista pravila vrijede
  const d = parsirajIValidirajProcjenu(tijelo({ korekcije: JSON.stringify(SREDISCE) }), { medijan_eur_m2: 3312, povrsina_m2: 130.45 });
  assert.equal(d.ok, true);
  // nevaljano: nema pouzdanosti / korekcije nisu popis / stavka bez razloga
  for (const lose of [{ pouzdanost: 'jako' }, { korekcije: 'puno' }, { korekcije: [{ razlog: '', postotak: 2 }] }, { korekcije: [{ razlog: 'a', postotak: 'x' }] }]) {
    assert.equal(parsirajIValidirajProcjenu(tijelo(lose), { medijan_eur_m2: 3312, povrsina_m2: 130.45 }).ok, false, JSON.stringify(lose));
  }
});

test('bez medijana za grad: raniji oblik (model daje ukupni raspon), jasno označen bez_reference', () => {
  const fer = { min_eur: 150000, max_eur: 170000, pouzdanost: 'niska', obrazlozenje: 'Procjena modela.' };
  for (const kontekst of [undefined, {}, { medijan_eur_m2: null }]) {
    const v = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: fer, najam }), kontekst);
    assert.equal(v.ok, true);
    assert.deepEqual(v.procjena.fer_vrijednost, { ...fer, bez_reference: true });
    assert.ok(!('izracun' in v.procjena.fer_vrijednost));
  }
  assert.equal(parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: { ...fer, min_eur: 200000 }, najam }), {}).ok, false, 'min > max i dalje pada');
});

test('ponovna validacija u izvještaju ne mijenja izračun; izracuni.fer_po_m2 slijedi isti izračun', () => {
  const a = parsirajIValidirajProcjenu(JSON.stringify({ korekcije: SREDISCE, pouzdanost: 'srednja', povrsina_m2: 130.45, najam }), { medijan_eur_m2: 3312, naziv: 'Zagreb' }).procjena;
  const osnova = {
    naslov: 'Stan', lokacija: { grad: 'Zagreb', kvart: 'Središće' }, povrsina_m2: 130.45, cijena_eur: 694896, preporuka: 'oprez', ocjena: 2,
    sazetak: 'x', fer_vrijednost: a.fer_vrijednost, najam: a.najam, prednosti: [], rizici: [],
    pregovaranje: { ciljana_ponuda_eur: null, aduti: [], pitanja_prodavatelju: [] }, nedostajuci_podaci: [],
  };
  const v = validirajAnalizu(osnova);
  assert.equal(v.ok, true, v.razlog);
  assert.deepEqual(v.analiza.fer_vrijednost, a.fer_vrijednost);
  const iz = izracunaj(v.analiza);
  assert.deepEqual(iz.fer_po_m2, a.fer_vrijednost.izracun.raspon_m2, '€/m² na kartici = €/m² iz obrazloženja');
  // izmijenjen min_eur u izvještaju ne može razjediniti brojeve: vraćaju se iz izračuna
  const potvrda = validirajAnalizu({ ...osnova, fer_vrijednost: { ...a.fer_vrijednost, min_eur: 1, max_eur: 2 } });
  assert.deepEqual(potvrda.analiza.fer_vrijednost, a.fer_vrijednost);
});

// ── k.o. kao polazište: korekcija za lokaciju/kvart se odbacuje u kodu ──
test('korekcija za lokaciju se odbacuje kad postoji medijan k.o.; ostale korekcije ostaju', () => {
  const kontekst = { medijan_eur_m2: 3345, povrsina_m2: 130.45, naziv: 'k.o. Zaprudski Otok', bezLokacije: true, lokacijaRijeci: ['Središće', 'Zaprudski Otok', 'Zagreb', 'sredisce'] };
  const tijelo = JSON.stringify({ korekcije: SREDISCE, pouzdanost: 'srednja', povrsina_m2: 130.45, najam });
  const a = parsirajIValidirajProcjenu(tijelo, kontekst);
  assert.equal(a.ok, true);
  const iz = a.procjena.fer_vrijednost.izracun;
  assert.deepEqual(a.odbaceno, [{ razlog: 'Središće', postotak: 5 }]);
  assert.deepEqual(iz.korekcije.map((k) => k.razlog), ['renovacija', 'parking', 'veliki stan', 'lift/kat']);
  assert.equal(iz.zbroj_posto, 2, '+8 −5 −3 +2, bez +5 za Središće');
  assert.match(a.procjena.fer_vrijednost.obrazlozenje, /^Polazište: medijan k\.o\. Zaprudski Otok \(usklađen DZS indeksom\) 3\.345 €\/m²\./);
  assert.ok(a.procjena.fer_vrijednost.obrazlozenje.length <= 350);
  // isto bez filtra (gradski medijan) ostavlja korekciju kvarta
  const b = parsirajIValidirajProcjenu(tijelo, { ...kontekst, bezLokacije: false });
  assert.equal(b.procjena.fer_vrijednost.izracun.zbroj_posto, 7);
  assert.equal(b.odbaceno, undefined);
  // stabilno: dva ista ulaza = isti raspon
  assert.deepEqual(parsirajIValidirajProcjenu(tijelo, kontekst).procjena, a.procjena);
});

test('jeKorekcijaLokacije: opći izrazi lokacije i imena kvarta (s padežima), ne i stanje/kat/parking', () => {
  const r = ['Središće', 'Zagreb'];
  for (const razlog of ['kvart', 'dobra lokacija', 'mikrolokacija', 'blizina centra', 'centar grada', 'zona Novog Zagreba', 'Središće', 'u Središću', 'Zagreb premium', 'udaljenost od tramvaja']) {
    assert.equal(jeKorekcijaLokacije(razlog, r), true, razlog);
  }
  for (const razlog of ['renovirano', 'bez lifta', 'parking', 'veliki stan', 'zadnji kat', 'centralno grijanje', 'starost zgrade', 'novogradnja']) {
    assert.equal(jeKorekcijaLokacije(razlog, r), false, razlog);
  }
});

test('obrazloženje s gradskim medijanom nosi napomenu zašto nije korišten k.o.', () => {
  const r = izracunajFer(ulaz({ naziv: 'Zagreb', napomena: 'Kvart „Utrine” nije mapiran na k.o.: gradski medijan.' }));
  const t = obrazlozenjeFer(r.izracun);
  assert.ok(t.startsWith('Polazište: usklađeni medijan Zagreb 3.312 €/m². Kvart „Utrine” nije mapiran na k.o.: gradski medijan. Korekcije:'), t);
  assert.ok(t.length <= 350, `${t.length}`);
});

// ── sažetak: brojke računa kod, validacija hvata one koje se ne slažu ──
const FER_RASPON = { min_eur: 430000, max_eur: 495000 };

test('činjenice sažetka: iznad/ispod/unutar raspona, razlika u € i % računa kod', () => {
  assert.deepEqual(cinjeniceSazetka(694896, FER_RASPON), { polozaj: 'iznad', razlika_eur: 199896, posto: 40.4 });
  assert.deepEqual(cinjeniceSazetka(400000, FER_RASPON), { polozaj: 'ispod', razlika_eur: 30000, posto: 7 });
  assert.deepEqual(cinjeniceSazetka(450000, FER_RASPON), { polozaj: 'unutar', razlika_eur: 0, posto: 0 });
  assert.equal(cinjeniceSazetka(null, FER_RASPON), null);
  assert.equal(cinjeniceSazetka(450000, { min_eur: null, max_eur: null }), null);
  const t = tekstCinjenicaSazetka(694896, FER_RASPON, true);
  assert.match(t, /199\.896 € \(40,4 % iznad gornje granice raspona\)/);
  assert.match(t, /Tražena cijena 694\.896 €, fer raspon 430\.000–495\.000 €/);
  assert.match(tekstCinjenicaSazetka(694896, FER_RASPON, false), /NE navodi postotke ni razlike u eurima/);
  assert.match(tekstCinjenicaSazetka(450000, FER_RASPON, true), /unutar raspona, nema razlike/);
});

test('sažetak s krivim postotkom ili iznosom pada validaciju; točne brojke prolaze', () => {
  const fer = { ...FER_RASPON, pouzdanost: 'srednja', obrazlozenje: 'x' };
  const prov = (sazetak, cijena = 694896) => provjeriSazetak(sazetak, cijena, fer);
  // ispravno
  assert.equal(prov('Cijena je 199.896 € (40,4 %) iznad gornje granice raspona.'), null);
  assert.equal(prov('Traži 694.896 €, raspon 430.000–495.000 €; iznad za 40 %.'), null, 'cijeli broj = zaokruženi izračun');
  assert.equal(prov('Cijena je iznad raspona; ima prostora za pregovor.'), null, 'bez brojki');
  assert.equal(prov('Cijena po m² je 5.327 €/m², iznad raspona.'), null, '€/m² nije iznos razlike');
  assert.equal(prov('Cijena je 200 tisuća eura iznad.'), 'sazetak: iznos "200 tisuća eura" ne odgovara izračunu');
  // pogrešno
  assert.match(prov('Cijena je 25 % iznad raspona.'), /postotak "25 %" ne odgovara izračunu \(40,4 %\)/);
  assert.match(prov('Cijena je 40,9 % iznad raspona.'), /postotak/);
  assert.match(prov('Cijena je 150.000 € iznad raspona.'), /iznos "150\.000 €" ne odgovara izračunu/);
  assert.match(prov('Cijena je za 12 posto viša.', 450000), /nema razlike prema rasponu/, 'unutar raspona: nikakav postotak');
  // validirajAnalizu odbija takav izvještaj
  const osnova = { naslov: 'Stan', lokacija: { grad: 'Zagreb', kvart: null }, povrsina_m2: 100, cijena_eur: 694896, preporuka: 'oprez', ocjena: 2,
    sazetak: 'Cijena je 25 % iznad raspona.', fer_vrijednost: fer, najam: { dugorocni_mj_eur: 1000, turisticki_godisnje_eur: null },
    prednosti: [], rizici: [], pregovaranje: { ciljana_ponuda_eur: null, aduti: [], pitanja_prodavatelju: [] }, nedostajuci_podaci: [] };
  const v = validirajAnalizu(osnova);
  assert.equal(v.ok, false);
  assert.match(v.razlog, /postotak "25 %"/);
  assert.equal(validirajAnalizu({ ...osnova, sazetak: 'Cijena je 40,4 % iznad raspona.' }).ok, true);
});
