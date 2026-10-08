// Dimni test prikaza izvještaja u rezultat.html: izvršava kod za izgradnju kartica nad
// minimalnim lažnim DOM-om (nema preglednika) i provjerava tekst koji korisnik vidi.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { validirajAnalizu, izracunaj } from '../netlify/lib/izvjestaj.mjs';

class Cvor {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.style = { setProperty() {} }; this.sluSatelji = {}; }
  addEventListener(ime, f) { this.sluSatelji[ime] = f; }
  set textContent(t) { this._text = String(t); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); }
  appendChild(c) { this.children.push(c); return c; }
  get lastChild() { return this.children.at(-1); }
}
const lazniDocument = {
  createElement: (t) => new Cvor(t), createDocumentFragment: () => new Cvor('#frag'),
  createTextNode: (t) => { const c = new Cvor('#text'); c.textContent = t; return c; },
};
const nadji = (c, uvjet) => (uvjet(c) ? [c] : []).concat(...c.children.map((d) => nadji(d, uvjet)));

const html = fs.readFileSync(path.join(import.meta.dirname, '../public/rezultat.html'), 'utf8');
const skripta = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const kod = skripta.slice(skripta.indexOf('// ─── Prikaz izvještaja ───'), skripta.indexOf('function prikaziAnalizu'));
const zajednicki = require('../public/assets/js/izracuni.js');
let zadnjiPrikaz = null;
const lazniAnaliza = { replaceChildren(f) { zadnjiPrikaz = f; } };
const ctx = vm.createContext({ document: lazniDocument, Intl, Number, Math, String, Boolean, PropIQIzracuni: zajednicki, analizaEl: lazniAnaliza });
vm.runInContext(`${kod}\nthis.izgradi = izgradiIzvjestaj;`, ctx);

const puno = {
  naslov: 'Stan, Zagreb – Trešnjevka, 60 m²', lokacija: { grad: 'Zagreb', kvart: 'Trešnjevka' },
  povrsina_m2: 60, cijena_eur: 180000, preporuka: 'pregovaraj', ocjena: 5, sazetak: 'Sažetak.',
  fer_vrijednost: { min_eur: 150000, max_eur: 170000, pouzdanost: 'srednja', obrazlozenje: 'Obrazloženje.' },
  najam: { dugorocni_mj_eur: 750, turisticki_godisnje_eur: null },
  prednosti: ['Prednost'], rizici: [{ naslov: 'Rizik', opis: 'Opis rizika.', razina: 'visok' }],
  pregovaranje: { ciljana_ponuda_eur: 162000, aduti: ['Adut'], pitanja_prodavatelju: ['Pitanje?'] },
  nedostajuci_podaci: ['Energetski razred'],
};
const prikaz = (promjene) => {
  const v = validirajAnalizu({ ...puno, ...promjene });
  assert.ok(v.ok, v.razlog);
  return ctx.izgradi(v.analiza, izracunaj(v.analiza)).textContent;
};

test('puni izvještaj: sve kartice, ocjena, značka, ušteda i footer', () => {
  const t = prikaz({});
  for (const dio of ['Stan, Zagreb', 'Zagreb · Trešnjevka', 'Za pregovore', '5 / 10', 'Fer vrijednost', 'Prinos od najma',
    'Rizici', 'Porez na promet', 'Strategija pregovaranja', 'ušteda', 'Vaši aduti', 'Pitanja za prodavatelja',
    'Što oglas ne navodi', 'Energetski razred', 'nije investicijski savjet', 'iznad procijenjenog fer raspona']) {
    assert.ok(t.includes(dio), dio);
  }
  assert.ok(/3[.\s ]?000/.test(t), '€/m²');
  assert.ok(!/NaN|undefined|null|Infinity/.test(t));
});

test('značke preporuke: tekst po preporuci', () => {
  assert.ok(prikaz({ preporuka: 'povoljno', ocjena: 8 }).includes('Povoljna prilika'));
  assert.ok(prikaz({ preporuka: 'oprez', ocjena: 2 }).includes('Oprez'));
});

const bezSvega = {
  povrsina_m2: null, cijena_eur: null, lokacija: { grad: null, kvart: null },
  fer_vrijednost: { min_eur: null, max_eur: null, pouzdanost: 'niska', obrazlozenje: 'Premalo podataka.' },
  najam: { dugorocni_mj_eur: null, turisticki_godisnje_eur: null },
  pregovaranje: { ciljana_ponuda_eur: null, aduti: [], pitanja_prodavatelju: [] },
};
const brojac = (t, re) => (t.match(re) || []).length;

test('null vrijednosti: nikad 0/NaN, tri vrste poruka', () => {
  const t = prikaz(bezSvega);
  assert.ok(!/(^|\s)0\s?(€|%|m²|god)/.test(t), 'nigdje 0 umjesto null');
  assert.ok(!/NaN|undefined|null|Infinity/.test(t));
  assert.ok(brojac(t, /nije navedeno u oglasu/g) >= 3, 'površina, cijena, lokacija');
  assert.ok(brojac(t, /nije moguće izračunati/g) >= 5, 'izračuni');
  assert.ok(brojac(t, /nema procjene/g) >= 3, 'AI procjene');
});

test('vrste null: podatak oglasa / izračun s razlogom / AI procjena', () => {
  const c = ctx.izgradi(...(() => { const a = validirajAnalizu({ ...puno, ...bezSvega }).analiza; return [a, izracunaj(a)]; })());
  const tekstovi = (re) => nadji(c, (n) => n.className.split(' ').includes('nd') && re.test(n.textContent)).length;
  // oglas: lokacija, površina, cijena
  const oglas = nadji(c, (n) => n.className.split(' ').includes('nd') && n.textContent === 'nije navedeno u oglasu');
  assert.equal(oglas.length, 3);
  // izračuni: €/m², bruto, neto, godine, porez + traka + fer €/m² nije prikazan (nema raspona)
  assert.equal(tekstovi(/^nije moguće izračunati — nedostaje cijena( i površina)?$/), 6);
  assert.ok(tekstovi(/^nije moguće izračunati — nema procjene fer vrijednosti$/) === 0);
  // AI procjene: raspon, najam, ciljana ponuda
  assert.equal(nadji(c, (n) => n.className.split(' ').includes('nd') && n.textContent === 'nema procjene').length, 3);
});

test('null vrijednosti nose klasu .nd, a ta je manja i prigušena (ne velika kurziva)', () => {
  const css = html.match(/\.nd, \.metrika-vrijednost\.nd[^{]*\{([^}]*)\}/)[1];
  assert.match(css, /font-size:\s*0\.8\d*rem/);
  assert.match(css, /font-style:\s*normal/);
  assert.match(css, /color:\s*var\(--cream-40\)/);
});

test('bez cijene: siva značka "Nedovoljno podataka" s objašnjenjem, bez ocjene i preporuke', () => {
  const v = validirajAnalizu({ ...puno, ...bezSvega, preporuka: 'oprez', ocjena: 1 });
  const c = ctx.izgradi(v.analiza, izracunaj(v.analiza));
  const t = c.textContent;
  assert.equal(nadji(c, (n) => n.className === 'znacka nedovoljno').length, 1);
  assert.ok(t.includes('Nedovoljno podataka'));
  assert.ok(/bez nje nema investicijske ocjene/.test(t));
  for (const nema of ['Oprez', 'Povoljna prilika', 'Za pregovore', '/ 10']) assert.ok(!t.includes(nema), nema);
  assert.equal(nadji(c, (n) => n.className.includes('ocjena')).length, 0);
});

test('s cijenom i dalje nema polja za unos ni značke "Nedovoljno podataka"', () => {
  const c = ctx.izgradi(...(() => { const a = validirajAnalizu(puno).analiza; return [a, izracunaj(a)]; })());
  assert.ok(!c.textContent.includes('Nedovoljno podataka'));
  assert.equal(nadji(c, (n) => n.tag === 'input').length, 0);
});

test('ručni unos cijene: polje + gumb u zaglavlju, preračun na klijentu, ocjena ostaje nedostupna', () => {
  const a = validirajAnalizu({ ...puno, cijena_eur: null }).analiza;
  const c = ctx.izgradi(a, izracunaj(a));
  assert.ok(c.textContent.includes('Upiši traženu cijenu (€)'));
  const polje = nadji(c, (n) => n.tag === 'input')[0];
  const gumb = nadji(c, (n) => n.tag === 'button')[0];
  assert.equal(gumb.textContent, 'Preračunaj');
  const greska = nadji(c, (n) => n.className === 'cijena-greska')[0];

  // nevaljan unos: poruka, bez preračuna
  polje.value = 'abc';
  zadnjiPrikaz = null;
  gumb.sluSatelji.click();
  assert.equal(zadnjiPrikaz, null);
  assert.match(greska.textContent, /valjanu cijenu/);

  // valjan unos: cijeli izvještaj se gradi iznova iz upisane cijene
  polje.value = '180.000';
  gumb.sluSatelji.click();
  const t = zadnjiPrikaz.textContent;
  assert.ok(/3[.\s ]?000/.test(t), '€/m²');
  assert.ok(/4,1\s?%/.test(t), 'neto prinos');
  assert.ok(/24,7\s?god/.test(t), 'godine povrata');
  assert.ok(/5[.\s ]?400\s?€/.test(t), 'porez 3 %');
  assert.ok(/ušteda 18[.\s ]?000/.test(t), 'ušteda prema ciljanoj ponudi');
  assert.ok(nadji(zadnjiPrikaz, (n) => n.className === 'znacka nedovoljno').length === 1, 'ocjena se ne izmišlja');
  assert.ok(/ponovno pokrenite analizu s cijenom/.test(t));
  assert.ok((t.match(/na temelju cijene koju ste upisali/gi) || []).length >= 3);
  assert.ok(!/nije moguće izračunati — nedostaje cijena/.test(t));
  assert.ok(nadji(zadnjiPrikaz, (n) => n.className.includes('traka-cijena')).length === 1, 'pozicija na traci');
  assert.ok(!/NaN|undefined|null|Infinity/.test(t));
  // polje ostaje za ispravak, s upisanom vrijednošću
  assert.equal(nadji(zadnjiPrikaz, (n) => n.tag === 'input')[0].value, '180000');
});

test('preračun bez ciljane ponude: ušteda se ne prikazuje', () => {
  const a = validirajAnalizu({ ...puno, cijena_eur: null, pregovaranje: { ciljana_ponuda_eur: null, aduti: [], pitanja_prodavatelju: [] } }).analiza;
  const c = ctx.izgradi(a, izracunaj(a));
  nadji(c, (n) => n.tag === 'input')[0].value = '180000';
  nadji(c, (n) => n.tag === 'button')[0].sluSatelji.click();
  assert.ok(!/ušteda \d/.test(zadnjiPrikaz.textContent));
});

const upisali = (c) => nadji(c, (n) => n.className === 'upisali').length;

test('oznaka "upisali ste" uz svaku vrijednost koju je upisao korisnik', () => {
  const a = validirajAnalizu(puno).analiza;
  const iz = izracunaj(a);
  assert.equal(upisali(ctx.izgradi(a, iz)), 0, 'bez unesenih podataka nema oznaka');
  assert.equal(upisali(ctx.izgradi(a, iz, undefined, { cijena_eur: 180000 })), 1);
  assert.equal(upisali(ctx.izgradi(a, iz, undefined, { cijena_eur: 180000, povrsina_m2: 60, grad: 'Zagreb' })), 3);
  const sve = ctx.izgradi(a, iz, undefined, { cijena_eur: 180000, povrsina_m2: 60, grad: 'Zagreb', kvart: 'Trešnjevka', kat: 0, lift: 'ne', parking: 'javni', godina_gradnje: 1985 });
  assert.equal(upisali(sve), 3 + 4, 'cijena, površina, lokacija + kat, lift, parking, godina');
  const t = sve.textContent;
  for (const dio of ['Kat: prizemlje', 'Lift: ne', 'Parking: javni', 'Godina gradnje: 1985', 'upisali ste']) assert.ok(t.includes(dio), dio);
});

test('s upisanom cijenom polje "Upiši traženu cijenu" se ne prikazuje; bez nje i bez cijene u oglasu ostaje', () => {
  const sCijenom = validirajAnalizu(puno).analiza;
  const c1 = ctx.izgradi(sCijenom, izracunaj(sCijenom), undefined, { cijena_eur: 180000 });
  assert.ok(!c1.textContent.includes('Upiši traženu cijenu'));
  assert.equal(nadji(c1, (n) => n.tag === 'input').length, 0);
  const bez = validirajAnalizu({ ...puno, cijena_eur: null }).analiza;
  const c2 = ctx.izgradi(bez, izracunaj(bez), undefined, { grad: 'Zagreb' });
  assert.ok(c2.textContent.includes('Upiši traženu cijenu (€)'), 'rezerva kad cijene nema ni u oglasu ni u formi');
});

test('analiza bez teksta oglasa (samo podaci iz forme) prikazuje se bez grešaka', () => {
  const a = validirajAnalizu({ ...puno, cijena_eur: 185000, povrsina_m2: 60, lokacija: { grad: 'Zagreb', kvart: null }, nedostajuci_podaci: [] }).analiza;
  const t = ctx.izgradi(a, izracunaj(a), undefined, { cijena_eur: 185000, povrsina_m2: 60, grad: 'Zagreb' }).textContent;
  assert.ok(t.includes('Zagreb') && /185[.\s ]?000/.test(t));
  assert.ok(!/NaN|undefined|null|Infinity/.test(t));
});

test('prikaziAnalizu predaje uneseno iz rezultata izvještaju', () => {
  assert.match(html, /izgradiIzvjestaj\(rezultat\.analiza, rezultat\.izracuni, undefined, rezultat\.uneseno, rezultat\.referenca\)/);
});

const realizirana = { godina: 2025, medijan_eur_m2: 2917, broj_prodaja: 7616, uskladeno_eur_m2: 3312, indeks_razdoblje: 'II. tromjesečje 2026.', privremeno: true };
const refZagreb = { razina: 'grad', naziv: 'Zagreb', realizirana, trazena: null };

test('napomena o referenci pod fer vrijednošću: realizirani medijan usklađen DZS-om, s izvorima; ili "nema podataka"', () => {
  const a = validirajAnalizu(puno).analiza;
  const iz = izracunaj(a);
  const t = ctx.izgradi(a, iz, undefined, undefined, refZagreb).textContent;
  const ocekivano = /Referenca: medijan stvarno plaćenih cijena stanova za Zagreb 2025\. \(7[.\s ]?616 prodaja\), usklađen DZS indeksom na II\. tromjesečje 2026\. \(privremeni podaci\): 3[.\s ]?312 €\/m²\. Izvori: Ministarstvo prostornoga uređenja, graditeljstva i državne imovine \(Pregled tržišta nekretnina 2025\.\); Državni zavod za statistiku\./;
  assert.ok(ocekivano.test(t), t);
  assert.ok(!t.includes('statistika.'), 'ispravan padež: "Državni zavod za statistiku"');
  const konacno = ctx.izgradi(a, iz, undefined, undefined, { ...refZagreb, realizirana: { ...realizirana, privremeno: false, indeks_razdoblje: 'I. tromjesečje 2026.' } }).textContent;
  assert.ok(/na I\. tromjesečje 2026\.: 3[.\s ]?312/.test(konacno) && !konacno.includes('privremeni'));
  for (const nema of [null, undefined, {}, { razina: 'grad', naziv: 'Zagreb', realizirana: null }]) {
    const n = ctx.izgradi(a, iz, undefined, undefined, nema).textContent;
    assert.ok(n.includes('Nema referentnih tržišnih podataka za ovu lokaciju'), String(nema));
    assert.ok(!/Referenca: medijan/.test(n));
  }
  assert.ok(!/NaN|undefined|Infinity/.test(t));
  assert.match(html, /preracunajSCijenom\(a, polje\.value, greska, uneseno, referenca\)/, 'napomena ostaje i nakon ručnog unosa cijene');
});

test('najam: napomena da je AI procjena bez referentnog izvora, uz pouzdanost koju je postavio poslužitelj', () => {
  const kartica = (najam) => {
    const a = validirajAnalizu({ ...puno, najam }).analiza;
    const c = ctx.izgradi(a, izracunaj(a), undefined, undefined, refZagreb);
    return nadji(c, (n) => n.className.includes('kartica') && n.textContent.includes('Prinos od najma')).find((n) => !n.textContent.includes('Fer vrijednost'));
  };
  const s = kartica({ dugorocni_mj_eur: 750, turisticki_godisnje_eur: null, pouzdanost: 'srednja' });
  assert.ok(s, 'kartica prinosa');
  assert.ok(s.textContent.includes('Procjena najma je AI procjena bez referentnih tržišnih podataka (nema javno dostupnog izvora najma po m²). Pouzdanost procjene najma: srednja.'), s.textContent);
  assert.ok(!kartica({ dugorocni_mj_eur: 750, turisticki_godisnje_eur: null, pouzdanost: 'niska' }).textContent.includes('srednja.'));
  assert.ok(kartica({ dugorocni_mj_eur: 750, turisticki_godisnje_eur: null }).textContent.includes('Procjena najma je AI procjena'), 'i bez pouzdanosti');
  assert.ok(!kartica({ dugorocni_mj_eur: null, turisticki_godisnje_eur: null }).textContent.includes('Procjena najma je AI procjena'), 'bez ikakve procjene nema napomene');
  assert.ok(!kartica({ dugorocni_mj_eur: 750, turisticki_godisnje_eur: null }).textContent.includes('Referenca najma'));
});
