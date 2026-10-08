// Testovi sheme, validacije i izračuna strukturiranog izvještaja (netlify/lib/izvjestaj.mjs).
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { odrediReferencu, tekstReference } from '../netlify/lib/trziste.mjs';
import { TOOL, TOOL_PROCJENA, TOOL_PROCJENA_BEZ_REFERENCE, MAX_OBRAZLOZENJE, skratiObrazlozenje, danasZagreb, godinaRenovacije, vremenskeCinjenice, validirajAnalizu, provjeriSazetak, tekstCinjenicaSazetka, parsirajIValidirajProcjenu, primijeniPreporuku, preporukaIzRaspona, parsirajIValidiraj, izracunaj, parsirajCijenu, validirajPodatke, mozeAnaliza, primijeniPodatke } from '../netlify/lib/izvjestaj.mjs';
import zajednicki from '../public/assets/js/izracuni.js';

const osnova = () => ({
  naslov: 'Stan, Zagreb – Trešnjevka, 58 m²',
  lokacija: { grad: 'Zagreb', kvart: 'Trešnjevka' },
  povrsina_m2: 60,
  cijena_eur: 180000,
  preporuka: 'pregovaraj',
  ocjena: 5,
  sazetak: 'Cijena je na gornjoj granici.',
  fer_vrijednost: { min_eur: 150000, max_eur: 170000, pouzdanost: 'srednja', obrazlozenje: 'Usporedive prodaje.' },
  najam: { dugorocni_mj_eur: 750, turisticki_godisnje_eur: 9000 },
  prednosti: ['Blizina tramvaja'],
  rizici: [{ naslov: 'Stara instalacija', opis: 'Godina obnove nije navedena.', razina: 'srednji' }],
  pregovaranje: { ciljana_ponuda_eur: 162000, aduti: ['Cijena iznad fer raspona'], pitanja_prodavatelju: ['Koliki je iznos pričuve?'] },
  nedostajuci_podaci: ['Energetski razred'],
});
const valjan = (promjene) => validirajAnalizu({ ...osnova(), ...promjene });

// ── shema ──
test('tool shema traži sva polja iz specifikacije i ne dopušta višak', () => {
  const sh = TOOL.input_schema;
  assert.equal(sh.additionalProperties, false);
  const { fer_vrijednost: _f, najam: _n, ...bezProcjene } = osnova();
  assert.deepEqual([...sh.required].sort(), Object.keys(bezProcjene).sort(), 'fer_vrijednost i najam nisu u shemi analize');
  assert.ok(!('fer_vrijednost' in sh.properties) && !('najam' in sh.properties));
  assert.deepEqual([...TOOL_PROCJENA.input_schema.required].sort(), ['korekcije', 'najam', 'pouzdanost', 'povrsina_m2'], 'model ne vraća min_eur/max_eur');
  assert.deepEqual([...TOOL_PROCJENA_BEZ_REFERENCE.input_schema.required].sort(), ['fer_vrijednost', 'najam'], 'bez medijana: raniji oblik');
  assert.equal(TOOL_PROCJENA.input_schema.additionalProperties, false);
  assert.equal(TOOL_PROCJENA_BEZ_REFERENCE.input_schema.additionalProperties, false);
  assert.deepEqual(sh.properties.preporuka.enum, ['povoljno', 'pregovaraj', 'oprez', null]);
  assert.deepEqual(sh.properties.ocjena.type, ['integer', 'null']);
  assert.deepEqual(sh.properties.rizici.items.properties.razina.enum, ['nizak', 'srednji', 'visok']);
});

// ── validacija ──
test('ispravan izvještaj prolazi', () => {
  const v = valjan({});
  assert.equal(v.ok, true);
  assert.equal(v.analiza.lokacija.kvart, 'Trešnjevka');
});

test('null je dopušten za površinu, cijenu, raspon, najam i ponudu', () => {
  const v = valjan({
    povrsina_m2: null, cijena_eur: null,
    fer_vrijednost: { min_eur: null, max_eur: null, pouzdanost: 'niska', obrazlozenje: 'Nema površine.' },
    najam: { dugorocni_mj_eur: null, turisticki_godisnje_eur: null },
    pregovaranje: { ciljana_ponuda_eur: null, aduti: [], pitanja_prodavatelju: [] },
    lokacija: { grad: null, kvart: null },
  });
  assert.equal(v.ok, true);
});

test('ocjena mora biti konzistentna s preporukom', () => {
  for (const [preporuka, ocjena, ok] of [
    ['povoljno', 8, true], ['povoljno', 6, false], ['pregovaraj', 4, true], ['pregovaraj', 7, false],
    ['oprez', 2, true], ['oprez', 5, false], ['oprez', 3, true],
  ]) {
    assert.equal(valjan({ preporuka, ocjena }).ok, ok, `${preporuka} ${ocjena}`);
  }
});

test('odbija nevaljane tipove, enume i raspone', () => {
  const lose = [
    { preporuka: 'odlicno' },
    { ocjena: 5.5 },
    { ocjena: '5' },
    { povrsina_m2: 0 },
    { povrsina_m2: -3 },
    { povrsina_m2: '60' },
    { cijena_eur: NaN },
    { naslov: '' },
    { sazetak: 12 },
    { fer_vrijednost: { min_eur: 200000, max_eur: 100000, pouzdanost: 'srednja', obrazlozenje: 'x' } },
    { fer_vrijednost: { min_eur: 100000, max_eur: null, pouzdanost: 'srednja', obrazlozenje: 'x' } },
    { fer_vrijednost: { min_eur: 1, max_eur: 2, pouzdanost: 'jako', obrazlozenje: 'x' } },
    { rizici: [{ naslov: 'a', opis: 'b', razina: 'kritican' }] },
    { prednosti: [1, 2] },
    { prednosti: Array(7).fill('x') },
    { nedostajuci_podaci: 'nema' },
    { lokacija: null },
  ];
  for (const p of lose) assert.equal(valjan(p).ok, false, JSON.stringify(p));
  assert.equal(validirajAnalizu(null).ok, false);
  assert.equal(validirajAnalizu([]).ok, false);
});

test('parsirajIValidiraj: odrezan JSON i smeće nisu valjani', () => {
  assert.equal(parsirajIValidiraj('{"naslov": "x"').ok, false);
  assert.equal(parsirajIValidiraj('').ok, false);
  assert.equal(parsirajIValidiraj('Evo analize').ok, false);
  assert.equal(parsirajIValidiraj(JSON.stringify(osnova())).ok, true);
});

test('validacija vraća očišćenu kopiju (višak polja se odbacuje)', () => {
  const v = valjan({ nepoznato: '<script>alert(1)</script>' });
  assert.equal(v.ok, true);
  assert.equal('nepoznato' in v.analiza, false);
});

// ── izračuni ──
const izr = (promjene) => izracunaj(valjan(promjene).analiza);

test('izračuni: €/m², fer €/m², porez na promet, prinosi, godine povrata', () => {
  const i = izr({});
  assert.equal(i.cijena_po_m2, 3000);                // 180000 / 60
  assert.deepEqual(i.fer_po_m2, { min: 2500, max: 2833 });
  assert.equal(i.porez_na_promet, 5400);             // 3 %
  assert.equal(i.najam_godisnje, 9000);              // 750 × 12
  assert.equal(i.bruto_prinos, 5);                   // 9000 / 180000
  assert.equal(i.neto_najam_godisnje, 7290);         // 9000 × 0,9 × 0,9
  assert.equal(i.neto_prinos, 4.1);                  // 7290 / 180000
  assert.equal(i.godine_povrata, 24.7);              // 180000 / 7290
  assert.equal(i.bruto_prinos_turisticki, 5);        // 9000 / 180000
  assert.equal(i.ciljana_ponuda_eur, 160000);        // cijena iznad raspona 150–170k → sredina
  assert.equal(i.usteda_eur, 20000);                 // 180000 − 160000
  assert.equal(i.usteda_posto, 11.1);
  assert.equal(i.pretpostavke.length, 4);
  assert.match(i.pretpostavke[0], /10 % troškova.*10 % poreza/);
});

test('izračuni: nedostajući ulaz daje null, nikad 0 ili NaN', () => {
  const bezCijene = izr({ cijena_eur: null });
  assert.equal(bezCijene.cijena_po_m2, null);
  assert.equal(bezCijene.porez_na_promet, null);
  assert.equal(bezCijene.bruto_prinos, null);
  assert.equal(bezCijene.neto_prinos, null);
  assert.equal(bezCijene.godine_povrata, null);
  assert.equal(bezCijene.usteda_eur, null);
  assert.equal(bezCijene.traka, null);

  const bezM2 = izr({ povrsina_m2: null });
  assert.equal(bezM2.cijena_po_m2, null);
  assert.deepEqual(bezM2.fer_po_m2, { min: null, max: null });
  assert.equal(bezM2.porez_na_promet, 5400, 'porez ne ovisi o površini');

  const bezNajma = izr({ najam: { dugorocni_mj_eur: null, turisticki_godisnje_eur: null } });
  assert.equal(bezNajma.najam_godisnje, null);
  assert.equal(bezNajma.bruto_prinos, null);
  assert.equal(bezNajma.neto_prinos, null);
  assert.equal(bezNajma.godine_povrata, null);
  assert.equal(bezNajma.bruto_prinos_turisticki, null);

  const sve = JSON.stringify(izr({ cijena_eur: null, povrsina_m2: null, najam: { dugorocni_mj_eur: null, turisticki_godisnje_eur: null } }));
  assert.ok(!/NaN|Infinity/.test(sve));
});

const ponuda = (cijena, min, max) => zajednicki.izracunajPonudu(cijena, min, max);

test('ciljana ponuda: tražena iznad raspona → sredina raspona', () => {
  assert.deepEqual(ponuda(694896, 400000, 460000), { ponuda_eur: 430000, napomena: null }); // slučaj iz prijave
  assert.equal(ponuda(500000, 400000, 450000).ponuda_eur, 425000);
  assert.equal(ponuda(500000, 401000, 460000).ponuda_eur, 430000); // 430.500 → 430.000 (korak 5.000)
});

test('ciljana ponuda: tražena unutar raspona → donja granica + 25 % širine, ne iznad tražene', () => {
  assert.equal(ponuda(450000, 400000, 460000).ponuda_eur, 415000);
  assert.equal(ponuda(460000, 400000, 460000).ponuda_eur, 415000); // na gornjoj granici
  assert.equal(ponuda(400000, 400000, 460000).ponuda_eur, 400000); // na donjoj granici: nije iznad tražene
  assert.equal(ponuda(402000, 400000, 460000).ponuda_eur, 400000); // 415k bi bilo iznad tražene; zaokruženo ne prelazi
  assert.equal(ponuda(404000, 400000, 460000).ponuda_eur, 400000);
});

test('ciljana ponuda: tražena ispod raspona → nema pregovora, tražena cijena + napomena, bez uštede', () => {
  assert.deepEqual(ponuda(380000, 400000, 460000), { ponuda_eur: 380000, napomena: 'cijena je već ispod fer raspona' });
  const i = izr({ cijena_eur: 140000 });
  assert.equal(i.ciljana_ponuda_eur, 140000);
  assert.equal(i.ciljana_ponuda_napomena, 'cijena je već ispod fer raspona');
  assert.equal(i.usteda_eur, null);
  assert.equal(i.usteda_posto, null);
});

test('ciljana ponuda: bez cijene ili bez raspona → nema procjene', () => {
  assert.equal(ponuda(null, 400000, 460000), null);
  assert.equal(ponuda(500000, null, null), null);
  const bezRaspona = izr({ fer_vrijednost: { min_eur: null, max_eur: null, pouzdanost: 'niska', obrazlozenje: 'Bez reference.' } });
  assert.equal(bezRaspona.ciljana_ponuda_eur, null);
  assert.equal(bezRaspona.usteda_eur, null);
  assert.equal(izr({ cijena_eur: null }).ciljana_ponuda_eur, null);
});

test('izračun: slučaj iz prijave (694.896 €, raspon 400–460k) → 430.000 €, ušteda iz istog izračuna', () => {
  const i = izr({ cijena_eur: 694896, fer_vrijednost: { min_eur: 400000, max_eur: 460000, pouzdanost: 'srednja', obrazlozenje: 'x' } });
  assert.equal(i.ciljana_ponuda_eur, 430000);
  assert.equal(i.usteda_eur, 264896);
  assert.equal(i.usteda_posto, 38.1);
});

test('model više ne vraća ciljanu ponudu: shema je nema, validacija je ignorira', () => {
  assert.ok(!('ciljana_ponuda_eur' in TOOL.input_schema.properties.pregovaranje.properties));
  assert.ok(!TOOL.input_schema.properties.pregovaranje.required.includes('ciljana_ponuda_eur'));
  const a = valjan({ pregovaranje: { ciljana_ponuda_eur: 1, aduti: [], pitanja_prodavatelju: [] } }).analiza;
  assert.ok(!('ciljana_ponuda_eur' in a.pregovaranje));
});

test('sažetak smije navesti ciljanu ponudu iz koda, ne neku drugu', () => {
  const fer = { min_eur: 400000, max_eur: 460000 };
  assert.equal(provjeriSazetak('Predložena ponuda je 430.000 €.', 694896, fer), null);
  assert.match(provjeriSazetak('Predložena ponuda je 380.000 €.', 694896, fer), /iznos/);
  assert.match(tekstCinjenicaSazetka(694896, fer, true), /Ciljana ponuda \(izračunao sustav\): 430\.000 €/);
  assert.match(tekstCinjenicaSazetka(380000, fer, true), /nema pregovora, cijena je već ispod fer raspona/);
});

test('traka: položaj tražene cijene u odnosu na fer raspon', () => {
  const iznad = izr({}).traka;                       // 180000 > 170000
  assert.equal(iznad.polozaj, 'iznad');
  assert.ok(iznad.cijena_posto > iznad.fer_do_posto);
  assert.ok(iznad.fer_od_posto < iznad.fer_do_posto);
  const unutar = izr({ cijena_eur: 160000 }).traka;
  assert.equal(unutar.polozaj, 'unutar');
  assert.ok(unutar.cijena_posto > unutar.fer_od_posto && unutar.cijena_posto < unutar.fer_do_posto);
  const ispod = izr({ cijena_eur: 100000 }).traka;
  assert.equal(ispod.polozaj, 'ispod');
  for (const t of [iznad, unutar, ispod]) {
    for (const k of ['fer_od_posto', 'fer_do_posto', 'cijena_posto']) assert.ok(t[k] >= 0 && t[k] <= 100, k);
  }
});

// ── nedovoljno podataka (nema tražene cijene) ──
test('bez cijene preporuka i ocjena su null, čak i ako ih je model vratio', () => {
  const v = valjan({ cijena_eur: null, preporuka: 'oprez', ocjena: 2 });
  assert.equal(v.ok, true, 'nedostatak cijene ne ruši odgovor');
  assert.equal(v.analiza.preporuka, null);
  assert.equal(v.analiza.ocjena, null);
  const v2 = valjan({ cijena_eur: null, preporuka: null, ocjena: null });
  assert.equal(v2.ok, true);
  assert.equal(v2.analiza.ocjena, null);
});

test('s cijenom preporuka i ocjena su obavezne (null nije dopušten)', () => {
  assert.equal(valjan({ preporuka: null, ocjena: null }).ok, false);
  assert.equal(valjan({ preporuka: 'povoljno', ocjena: null }).ok, false);
  assert.equal(valjan({ preporuka: null, ocjena: 8 }).ok, false);
});

test('system prompt: preporuka/ocjena null samo bez cijene, cijena ne smije sama rušiti ocjenu', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../netlify/functions/analiza.mjs'), 'utf8');
  assert.match(src, /cijena_eur" nedostaje[^\n]*"preporuka" i "ocjena" MORAJU biti null/);
  assert.match(src, /NIKAD ne snižava ocjenu/);
  assert.match(src, /Ako cijena POSTOJI[^\n]*nikad null/);
});

// ── zajednički modul formula (server i preglednik) ──
test('server i preglednik dijele isti modul formula (bez dupliciranja)', () => {
  assert.equal(izracunaj, zajednicki.izracunaj);
  const izvor = fs.readFileSync(path.join(import.meta.dirname, '../netlify/lib/izvjestaj.mjs'), 'utf8');
  assert.ok(!/POREZ_NA_PROMET\s*\)|\*\s*0\.9|netoGod/.test(izvor), 'formule nisu u izvjestaj.mjs');
  const html = fs.readFileSync(path.join(import.meta.dirname, '../public/rezultat.html'), 'utf8');
  assert.ok(html.includes('assets/js/izracuni.js'));
  assert.ok(!/TROSKOVI_NAJMA|POREZ_NA_NAJAM|netoGod/.test(html), 'formule nisu u rezultat.html');
});

test('preračun s upisanom cijenom jednak je izračunu poslužitelja za istu cijenu', () => {
  const bez = valjan({ cijena_eur: null }).analiza;
  const klijent = zajednicki.izracunaj({ ...bez, cijena_eur: 180000 });
  const poslužitelj = izr({});
  const { razlozi: _a, ...k } = klijent;
  const { razlozi: _b, ...p } = poslužitelj;
  assert.deepEqual(k, p);
  assert.equal(klijent.cijena_po_m2, 3000);
  assert.equal(klijent.neto_prinos, 4.1);
  assert.equal(klijent.porez_na_promet, 5400);
  assert.equal(klijent.usteda_eur, 20000);
  assert.equal(klijent.traka.polozaj, 'iznad');
});

test('razlozi: zašto izračun nije moguće napraviti', () => {
  const r = izr({ cijena_eur: null }).razlozi;
  for (const k of ['cijena_po_m2', 'porez_na_promet', 'bruto_prinos', 'neto_prinos', 'godine_povrata', 'usteda', 'traka']) {
    assert.equal(r[k], 'nedostaje cijena', k);
  }
  assert.equal(izr({ povrsina_m2: null }).razlozi.cijena_po_m2, 'nedostaje površina');
  assert.equal(izr({ najam: { dugorocni_mj_eur: null, turisticki_godisnje_eur: null } }).razlozi.neto_prinos, 'nema procjene najma');
  assert.equal(izr({}).razlozi.neto_prinos, null);
});

test('parsirajCijenu: hrvatski i obični zapisi, nevaljano je null', () => {
  for (const [ulaz, izlaz] of [['185000', 185000], ['185.000', 185000], ['185 000 €', 185000], ['185.000,50', 185000.5],
    ['1.250.000', 1250000], ['99,5', 99.5]]) {
    assert.equal(parsirajCijenu(ulaz), izlaz, ulaz);
  }
  for (const lose of ['', 'abc', '0', '-5', '1e9', '9999999999', '12a', null, undefined, 5]) {
    assert.equal(parsirajCijenu(lose), null, String(lose));
  }
});

// ── polja forme: validacija, prednost, mogućnost analize ──
test('validirajPodatke: prazno je dopušteno, upisano se čisti i parsira (isti parser cijene)', () => {
  assert.deepEqual(validirajPodatke(undefined), { ok: true, podaci: {} });
  assert.deepEqual(validirajPodatke({ cijena_eur: '', povrsina_m2: ' ', grad: '', lift: '' }), { ok: true, podaci: {} });
  const v = validirajPodatke({ cijena_eur: '185.000,50', povrsina_m2: '58,5', grad: ' Zagreb ', kvart: 'Jarun', kat: '0', lift: 'da', parking: 'javni', godina_gradnje: '1985' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.podaci, { cijena_eur: 185000.5, povrsina_m2: 58.5, grad: 'Zagreb', kvart: 'Jarun', kat: 0, lift: 'da', parking: 'javni', godina_gradnje: 1985 });
  for (const z of ['185 000 €', '185.000', '185000']) assert.equal(validirajPodatke({ cijena_eur: z }).podaci.cijena_eur, parsirajCijenu(z));
});

test('validirajPodatke: odbija nepozitivne, nerazumne i predugačke vrijednosti', () => {
  for (const lose of [{ cijena_eur: -1 }, { cijena_eur: 999 }, { cijena_eur: 2e9 }, { povrsina_m2: 4 }, { povrsina_m2: 20000 },
    { kat: -4 }, { kat: 2.5 }, { godina_gradnje: 1599 }, { godina_gradnje: 2101 }, { grad: 'a'.repeat(81) }, { grad: 5 },
    { lift: 'da!' }, { parking: 'privatni' }, 'x', []]) {
    assert.equal(validirajPodatke(lose).ok, false, JSON.stringify(lose));
  }
  assert.equal(validirajPodatke({ grad: 'a'.repeat(80) }).ok, true);
});

test('mozeAnaliza: tekst oglasa ILI cijena + površina + grad', () => {
  const p = { cijena_eur: 1e5, povrsina_m2: 50, grad: 'Zagreb' };
  assert.equal(mozeAnaliza('Stan na prodaju', {}), true);
  assert.equal(mozeAnaliza('', p), true);
  assert.equal(mozeAnaliza('  ', p), true);
  assert.equal(mozeAnaliza('', { ...p, grad: undefined }), false);
  assert.equal(mozeAnaliza('', { ...p, povrsina_m2: undefined }), false);
  assert.equal(mozeAnaliza('', { ...p, cijena_eur: undefined }), false);
  assert.equal(mozeAnaliza('', {}), false);
});

test('primijeniPodatke: korisnik nadjačava AI; parsirajIValidiraj primjenjuje to prije validacije', () => {
  const ai = osnova();
  const k = primijeniPodatke(ai, { cijena_eur: 99000, grad: 'Rijeka' });
  assert.equal(k.cijena_eur, 99000);
  assert.equal(k.lokacija.grad, 'Rijeka');
  assert.equal(k.lokacija.kvart, 'Trešnjevka');
  assert.equal(ai.cijena_eur, 180000, 'ulaz se ne mijenja');
  const v = parsirajIValidiraj(JSON.stringify(osnova()), { povrsina_m2: 90 });
  assert.equal(v.analiza.povrsina_m2, 90);
});

test('klijent i poslužitelj dijele validaciju polja; index.html ne duplicira pravila', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('assets/js/izracuni.js'));
  assert.ok(html.includes('PropIQIzracuni.validirajPodatke') && html.includes('PropIQIzracuni.mozeAnaliza'));
  assert.ok(!/parsirajCijenu|replace\(\/\\\.\/g/.test(html), 'parsiranje cijene nije dupliciran u index.html');
  for (const id of ['kp_cijena', 'kp_povrsina', 'kp_grad', 'kp_kvart', 'kp_kat', 'kp_lift', 'kp_parking', 'kp_godina']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /<details class="vise-detalja"[\s\S]*kp_kat[\s\S]*kp_godina[\s\S]*kp_lift[\s\S]*kp_parking[\s\S]*<\/details>/);
  assert.ok(html.includes('Ključni podaci (neobavezno — ako ih oglas nema ili ih želite ispraviti)'));
  assert.ok(!/id="oglas_tekst"[^>]*required/.test(html), 'tekst oglasa više nije obavezan');
});

// ── procjena (poziv 1) i preporuka iz koda ──
test('parsirajIValidirajProcjenu: valjana, nevaljana i odrezana procjena', () => {
  const { fer_vrijednost, najam } = osnova();
  const v = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost, najam, visak: 1 }));
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.procjena), ['fer_vrijednost', 'najam']);
  assert.equal(parsirajIValidirajProcjenu('{"fer_vrijednost":').ok, false);
  assert.equal(parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: { ...fer_vrijednost, min_eur: 9e5 }, najam })).ok, false);
  assert.equal(parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost, najam: null })).ok, false);
});

test('preporukaIzRaspona: ispod → povoljno, unutar (granice uključene) → pregovaraj, iznad → oprez', () => {
  assert.equal(preporukaIzRaspona(99, 100, 200), 'povoljno');
  assert.equal(preporukaIzRaspona(100, 100, 200), 'pregovaraj');
  assert.equal(preporukaIzRaspona(200, 100, 200), 'pregovaraj');
  assert.equal(preporukaIzRaspona(201, 100, 200), 'oprez');
});

test('primijeniPreporuku: bez cijene ili bez raspona objekt ostaje neizmijenjen', () => {
  const bezCijene = { ...osnova(), cijena_eur: null };
  assert.equal(primijeniPreporuku(bezCijene), bezCijene);
  const bezRaspona = { ...osnova(), fer_vrijednost: { min_eur: null, max_eur: null, pouzdanost: 'niska', obrazlozenje: 'x' } };
  assert.equal(primijeniPreporuku(bezRaspona), bezRaspona);
});

test('parsirajIValidiraj s procjenom: fer_vrijednost/najam uvijek iz poziva 1, preporuka iz koda', () => {
  const procjena = { fer_vrijednost: { min_eur: 100000, max_eur: 120000, pouzdanost: 'niska', obrazlozenje: 'Fiksno.' }, najam: { dugorocni_mj_eur: 500, turisticki_godisnje_eur: null } };
  const model = { ...osnova(), fer_vrijednost: { min_eur: 170000, max_eur: 190000, pouzdanost: 'visoka', obrazlozenje: 'Prepisano.' }, najam: { dugorocni_mj_eur: 9999, turisticki_godisnje_eur: 1 }, preporuka: 'povoljno', ocjena: 9 };
  const v = parsirajIValidiraj(JSON.stringify(model), null, procjena);
  assert.equal(v.ok, true);
  assert.deepEqual(v.analiza.fer_vrijednost, procjena.fer_vrijednost);
  assert.deepEqual(v.analiza.najam, procjena.najam);
  assert.equal(v.analiza.preporuka, 'oprez');      // 180000 > 120000
  assert.equal(v.analiza.ocjena, 3);               // 9 stegnuto na granicu raspona za oprez
  // nedostaju fer_vrijednost i najam u odgovoru modela (kao u novoj shemi) — i dalje valjano
  const { fer_vrijednost: _f, najam: _n, ...novaShema } = osnova();
  assert.equal(parsirajIValidiraj(JSON.stringify(novaShema), null, procjena).ok, true);
});

// ── regresija: Zagreb, Središće, 130,45 m², cijena 694.896 (procjena je padala na "fer_vrijednost") ──
test('procjena: slučaj Zagreb/Središće 130,45 m² — referenca je ukupni €/m², raspon prolazi validaciju', () => {
  const ref = odrediReferencu({ grad: 'Zagreb', kvart: 'Utrine', povrsina_m2: 130.45 }, 'Stan u Zagrebu, Utrine, 130,45 m²');
  const r = ref.realizirana;
  assert.equal(r.uskladeno_eur_m2, Math.round(2917 * 113.53 / 100));
  // Raspon iz korigiranog €/m² × površina, u ukupnim eurima (ne €/m²).
  const min = Math.round(r.uskladeno_eur_m2 * 0.9 * 130.45);
  const max = Math.round(r.uskladeno_eur_m2 * 1.15 * 130.45);
  assert.ok(min > 1e5 && max < 1e8);
  const fer = { min_eur: min, max_eur: max, pouzdanost: 'srednja', obrazlozenje: 'Zagreb, usklađeni medijan 3311 €/m²; +15% zbog kvarta.' };
  const v = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: fer, najam: { dugorocni_mj_eur: 1400, turisticki_godisnje_eur: null } }));
  assert.equal(v.ok, true);
  assert.equal(preporukaIzRaspona(694896, min, max), 'oprez');
  // Cijena nikad ne ulazi u prompt poziva 1.
  assert.ok(!tekstReference(ref).includes('694'));
});

test('procjena: fer_vrijednost kao JSON-kodiran tekst se raspakira, ali ista pravila vrijede', () => {
  const { fer_vrijednost, najam } = osnova();
  const kodirano = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: JSON.stringify(fer_vrijednost), najam }));
  assert.equal(kodirano.ok, true);
  assert.deepEqual(kodirano.procjena.fer_vrijednost, { ...fer_vrijednost, bez_reference: true });
  const krivo = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: JSON.stringify({ ...fer_vrijednost, min_eur: 9e5 }), najam }));
  assert.equal(krivo.ok, false, 'granice i dalje vrijede nakon raspakiravanja');
});

test('procjena: razlog odbijanja i sirova vrijednost fer_vrijednost za log', () => {
  const { najam } = osnova();
  for (const [sirovoFer, dio] of [['2.800–3.400 €/m²', 'tekst'], [[1, 2], 'popis'], [null, 'null'], [undefined, 'undefined']]) {
    const v = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: sirovoFer, najam }));
    assert.equal(v.ok, false);
    assert.match(v.razlog, new RegExp(`očekivan objekt, stigao ${dio === 'tekst' ? 'string' : dio}`));
    assert.deepEqual(v.sirovo, sirovoFer);
  }
  assert.deepEqual(parsirajIValidirajProcjenu('{"fer_vrijednost":').sirovo, undefined);
});

test('procjena: shema i prompt traže ukupne eure (ne €/m²) i kratko obrazloženje', () => {
  const p = TOOL_PROCJENA_BEZ_REFERENCE.input_schema.properties.fer_vrijednost.properties;
  assert.match(p.min_eur.description, /UKUPNE/);
  assert.match(p.max_eur.description, /UKUPNE/);
  assert.match(p.obrazlozenje.description, /350/);
});

// ── datum i starost (račun u kodu) ──
test('danasZagreb: datum po Europe/Zagreb, ne po UTC-u', () => {
  assert.deepEqual(danasZagreb(new Date('2026-10-07T10:00:00Z')), { godina: 2026, datum: '2026-10-07' });
  // 31.12. 23:30 UTC je već 1.1. u Zagrebu
  assert.deepEqual(danasZagreb(new Date('2026-12-31T23:30:00Z')), { godina: 2027, datum: '2027-01-01' });
});

test('vremenskeCinjenice: starost zgrade i renovacija kao gotovi brojevi', () => {
  const sada = new Date('2026-10-07T10:00:00Z');
  const t = vremenskeCinjenice({ godinaGradnje: 1980, oglas: 'Stan renovirano 2015. godine.', sada });
  assert.match(t, /Današnji datum: 2026-10-07/);
  assert.match(t, /Starost zgrade: 46 godina \(izgrađena 1980\.\)/);
  assert.match(t, /Renovacija prema oglasu: 2015\. \(prije 11 godina\)/);
  // bez godine gradnje i bez navoda renovacije nema izmišljenih brojeva
  const prazno = vremenskeCinjenice({ oglas: 'Lijep stan.', sada });
  assert.ok(!/Starost|Renovacija/.test(prazno));
  // buduća godina gradnje (npr. u izgradnji) ne daje negativnu starost
  assert.ok(!/Starost/.test(vremenskeCinjenice({ godinaGradnje: 2030, sada })));
});

test('godinaRenovacije: samo izričit navod, najnovija godina, nikad buduća', () => {
  assert.equal(godinaRenovacije('Adaptiran 2019. godine, obnovljena fasada 2022.', 2026), 2022);
  assert.equal(godinaRenovacije('Izgrađen 1975., trosoban stan.', 2026), null);
  assert.equal(godinaRenovacije('Renovacija planirana 2031.', 2026), null);
  assert.equal(godinaRenovacije(undefined, 2026), null);
});

// ── tvrdo ograničenje obrazloženja procjene ──
test('obrazloženje preko 350 znakova se skraćuje u validaciji (na kraju rečenice ili riječi)', () => {
  const rec = 'Zagreb, usklađeni medijan 3.600 €/m²; +10% kvart, −8% zadnji kat bez lifta, niži €/m² po m² zbog veličine. ';
  const dugo = rec.repeat(8);
  const v = parsirajIValidirajProcjenu(JSON.stringify({ fer_vrijednost: { ...osnova().fer_vrijednost, obrazlozenje: dugo }, najam: osnova().najam }));
  assert.equal(v.ok, true, 'ne odbija se: nema ponovnog poziva');
  const o = v.procjena.fer_vrijednost.obrazlozenje;
  assert.ok(o.length <= MAX_OBRAZLOZENJE, `duljina ${o.length}`);
  assert.ok(o.endsWith('.'), 'režeš na kraju cijele rečenice');
  // bez točke: granica riječi + "…"
  const bezTocke = skratiObrazlozenje('riječ '.repeat(100));
  assert.ok(bezTocke.length <= MAX_OBRAZLOZENJE && bezTocke.endsWith('…'));
  // kratko ostaje netaknuto
  assert.equal(skratiObrazlozenje('Kratko.'), 'Kratko.');
  // i shema nosi ograničenje
  assert.equal(TOOL_PROCJENA_BEZ_REFERENCE.input_schema.properties.fer_vrijednost.properties.obrazlozenje.maxLength, MAX_OBRAZLOZENJE);
});

test('shema analize: kratki limiti polja (brzina poziva 2)', () => {
  const p = TOOL.input_schema.properties;
  assert.equal(p.rizici.maxItems, 4);
  assert.equal(p.prednosti.maxItems, 4);
  assert.equal(p.pregovaranje.properties.aduti.maxItems, 3);
  assert.equal(p.pregovaranje.properties.pitanja_prodavatelju.maxItems, 4);
  assert.equal(p.nedostajuci_podaci.maxItems, 5);
  assert.match(p.rizici.items.properties.opis.description, /2 kratke rečenice/);
});
