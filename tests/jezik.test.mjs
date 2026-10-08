// Testovi jezične obrade i provjera izvještaja (netlify/lib/jezik.mjs, sazetak.mjs, izvjestaj.mjs):
// ćirilica, ponovljene riječi, strani pojmovi, omjeri, ciljana ponuda, prva rečenica sažetka, razlog korekcije.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import { ocistiCirilicu, ukloniPonovljeneRijeci, zamijeniStranePojmove, obradiTekst, provjeriOmjere, provjeriPonudu, recenice, POJMOVNIK_TEKST } from '../netlify/lib/jezik.mjs';
import { omjerCijene, prvaRecenicaSazetka, tekstCinjenicaSazetka, validirajAnalizu, parsirajIValidiraj, parsirajIValidirajProcjenu, TOOL, TOOL_PROCJENA } from '../netlify/lib/izvjestaj.mjs';
import zajednicki from '../public/assets/js/izracuni.js';

const FER = { min_eur: 350000, max_eur: 400000, pouzdanost: 'srednja', obrazlozenje: 'Usporedive prodaje.' };
const osnova = (promjene = {}) => ({
  naslov: 'Stan, Zagreb, 60 m²', lokacija: { grad: 'Zagreb', kvart: null }, povrsina_m2: 60, cijena_eur: 590000,
  preporuka: 'oprez', ocjena: 2, sazetak: 'Cijena je iznad raspona.', fer_vrijednost: FER,
  najam: { dugorocni_mj_eur: 900, turisticki_godisnje_eur: null }, prednosti: ['Blizina tramvaja'],
  rizici: [{ naslov: 'Visoka cijena', opis: 'Cijena je iznad raspona.', razina: 'visok' }],
  pregovaranje: { aduti: ['Cijena iznad fer raspona'], pitanja_prodavatelju: ['Koliki je iznos pričuve?'] },
  nedostajuci_podaci: ['Energetski razred'], ...promjene,
});

// ── B1 ćirilica ──
test('ćirilično "у" usred hrvatske riječi zamjenjuje se latiničnim "u" i logira', () => {
  const log = [];
  assert.equal(ocistiCirilicu('Stan ima dobrу lokaciju', 'sazetak', log), 'Stan ima dobru lokaciju');
  assert.deepEqual(log, [{ vrsta: 'cirilica', polje: 'sazetak', prije: 'dobrу', poslije: 'dobru' }]);
});

test('ćirilica: lookalike slova u miješanoj riječi, samostalno "у"; cijele ćirilične riječi ostaju', () => {
  assert.equal(ocistiCirilicu('Pоdrum vlаžan'), 'Podrum vlažan');
  const log = [];
  assert.equal(ocistiCirilicu('Stan у Zagrebu', '', log), 'Stan u Zagrebu');
  assert.equal(ocistiCirilicu('Београд', '', log), 'Београд');
  assert.equal(log.length, 1);
  assert.equal(ocistiCirilicu('bez ćirilice', '', log), 'bez ćirilice');
});

// ── B2 ponovljene riječi ──
test('ponovljene riječi ("li li") se uklanjaju; brojevi, zarez i različite riječi ostaju', () => {
  const log = [];
  assert.equal(ukloniPonovljeneRijeci('Je li li stan renoviran?', 'p', log), 'Je li stan renoviran?');
  assert.equal(ukloniPonovljeneRijeci('Cijena je je visoka. Ima ima lift.'), 'Cijena je visoka. Ima lift.');
  assert.equal(ukloniPonovljeneRijeci('Ne, ne želim. Soba 10 10 m. Kat kata.'), 'Ne, ne želim. Soba 10 10 m. Kat kata.');
  assert.equal(ukloniPonovljeneRijeci('da da da'), 'da');
  assert.equal(log[0].vrsta, 'ponovljena_rijec');
});

// ── B3 strani pojmovi ──
test('"HOA" postaje "pričuva"; pojmovnik je u promptu', () => {
  assert.equal(zamijeniStranePojmove('Visoka HOA za zgradu.'), 'Visoka pričuva za zgradu.');
  assert.equal(zamijeniStranePojmove('HOA naknada je visoka'), 'pričuva je visoka');
  assert.equal(zamijeniStranePojmove('SHOAH'), 'SHOAH');
  assert.equal(obradiTekst('Visoka HOA HOA.'), 'Visoka pričuva.');
  assert.match(POJMOVNIK_TEKST, /"HOA" → "pričuva"/);
});

// ── B4 omjeri ──
test('omjerCijene: cijena / sredina raspona, jedna decimala', () => {
  assert.equal(omjerCijene(590000, FER), 1.6);
  assert.equal(omjerCijene(300000, FER), 0.8);
  assert.equal(omjerCijene(null, FER), null);
  assert.equal(omjerCijene(590000, { min_eur: null, max_eur: null }), null);
});

test('blok gotovih brojki sadrži omjer ("1,6 puta više od sredine raspona"); bez potvrđene cijene zabranjuje omjere', () => {
  const b = tekstCinjenicaSazetka(590000, FER, true);
  assert.match(b, /Omjer tražene cijene i sredine fer raspona: 1,6 puta više od sredine raspona/);
  assert.match(b, /Prvu rečenicu sažetka .* slaže sustav/);
  assert.match(tekstCinjenicaSazetka(590000, FER, false), /ni omjere/);
});

test('provjeriOmjere: tvrdnje o višekratniku moraju odgovarati omjeru iz koda', () => {
  assert.equal(provjeriOmjere('Cijena je 1,6× sredina raspona.', 1.6), null);
  assert.equal(provjeriOmjere('Cijena je 1,6 puta veća od sredine.', 1.6), null);
  assert.match(provjeriOmjere('Cijena je dvostruko viša od raspona.', 1.6), /dvostruko/);
  assert.match(provjeriOmjere('Traže triput više.', 1.6), /triput/);
  assert.match(provjeriOmjere('Cijena je 2 puta veća.', 1.6), /2 puta/);
  assert.match(provjeriOmjere('Dva puta skuplje od raspona.', 1.6), /ne odgovara/);
  assert.match(provjeriOmjere('To je 3× više.', 1.6), /3×/);
  assert.equal(provjeriOmjere('Cijena je dvostruko viša.', 2.0), null);
  assert.match(provjeriOmjere('Cijena je dvostruko viša.', null), /omjer nije izračunat/);
  assert.equal(provjeriOmjere('Pregled se radi tri puta godišnje, 2 puta tjedno.', 1.6), null);
});

test('validacija odbija "dvostruko" kad se ne slaže s omjerom, prihvaća točan omjer', () => {
  assert.match(validirajAnalizu(osnova({ sazetak: 'Cijena je dvostruko viša od raspona.' })).razlog, /dvostruko/);
  assert.match(validirajAnalizu(osnova({ pregovaranje: { aduti: ['Traže triput više od fer raspona'], pitanja_prodavatelju: [] } })).razlog, /aduti\[0\].*triput/);
  assert.equal(validirajAnalizu(osnova({ sazetak: 'Cijena je 1,6× sredina raspona.' })).ok, true);
});

// ── B5 ciljana ponuda nije vrijednost ──
test('provjeriPonudu: ponuda se ne smije zvati realnom/fer vrijednošću', () => {
  assert.match(provjeriPonudu('Ciljana ponuda je realna vrijednost nekretnine.', 375000), /vrijednošću/);
  assert.match(provjeriPonudu('Ponuda od 375.000 € iznosi fer vrijednost.', 375000), /vrijednošću/);
  assert.match(provjeriPonudu('Realna vrijednost je oko 375.000 €.', 375000), /vrijednošću/);
  assert.match(provjeriPonudu('Fer vrijednost iznosi 375 000 €.', 375000), /vrijednošću/);
  assert.equal(provjeriPonudu('Ciljana ponuda od 375.000 € je prijedlog za pregovore.', 375000), null);
  assert.equal(provjeriPonudu('Fer vrijednost je 350.000–400.000 €, a ponuda 375.000 €.', 375000), null);
  // iznos jednak granici raspona nije samo ponuda
  assert.equal(provjeriPonudu('Realna vrijednost je 400.000 €.', 400000, [400000]), null);
});

test('validacija odbija ponudu nazvanu vrijednošću (iznos ponude iz koda)', () => {
  const ponuda = zajednicki.izracunajPonudu(590000, FER.min_eur, FER.max_eur).ponuda_eur;
  const iznos = String(ponuda).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const v = validirajAnalizu(osnova({ pregovaranje: { aduti: [`Realna vrijednost je ${iznos} €`], pitanja_prodavatelju: [] } }));
  assert.equal(v.ok, false);
  assert.match(v.razlog, /ciljana ponuda ne smije/);
  assert.equal(validirajAnalizu(osnova({ pregovaranje: { aduti: [`Ponudite ${iznos} € – cijena je iznad fer raspona`], pitanja_prodavatelju: [] } })).ok, true);
});

// ── B6 prva rečenica sažetka ──
test('prvaRecenicaSazetka: iznad, ispod i unutar raspona, gramatički ispravno', () => {
  assert.equal(prvaRecenicaSazetka(590000, FER),
    'Tražena cijena od 590.000 € nalazi se 190.000 € (47,5 %) iznad gornje granice fer raspona od 350.000 do 400.000 €, što je 1,6 puta više od sredine raspona.');
  assert.equal(prvaRecenicaSazetka(300000, FER),
    'Tražena cijena od 300.000 € nalazi se 50.000 € (14,3 %) ispod donje granice fer raspona od 350.000 do 400.000 €, što je 0,8 sredine raspona.');
  assert.equal(prvaRecenicaSazetka(375000, FER), 'Tražena cijena od 375.000 € nalazi se unutar fer raspona od 350.000 do 400.000 €.');
  assert.equal(prvaRecenicaSazetka(null, FER), null);
});

test('sažetak: prvu rečenicu slaže kod, od modela ostaje samo prva rečenica', () => {
  const v = validirajAnalizu(osnova({ sazetak: 'Cijena je iznad raspona zbog lokacije. Druga rečenica se odbacuje.' }), { slozi: true });
  assert.equal(v.ok, true);
  assert.equal(v.analiza.sazetak,
    'Tražena cijena od 590.000 € nalazi se 190.000 € (47,5 %) iznad gornje granice fer raspona od 350.000 do 400.000 €, što je 1,6 puta više od sredine raspona. Cijena je iznad raspona zbog lokacije.');
  assert.equal(validirajAnalizu(osnova({ sazetak: 'Cijena je iznad raspona. Još jedna.' })).analiza.sazetak, 'Cijena je iznad raspona. Još jedna.', 'bez slozi sažetak ostaje kakav je');
});

test('parsirajIValidiraj: prvu rečenicu slaže kod samo kad je cijena upisana u formu', () => {
  const procjena = { fer_vrijednost: FER, najam: osnova().najam };
  const ulaz = JSON.stringify({ ...osnova({ cijena_eur: 1 }), fer_vrijednost: undefined, najam: undefined });
  const s = parsirajIValidiraj(ulaz, { cijena_eur: 590000 }, procjena);
  assert.equal(s.ok, true, s.razlog);
  assert.match(s.analiza.sazetak, /^Tražena cijena od 590\.000 € nalazi se 190\.000 €/);
  const bez = parsirajIValidiraj(JSON.stringify({ ...osnova(), fer_vrijednost: undefined, najam: undefined }), { grad: 'Zagreb' }, procjena);
  assert.equal(bez.analiza.sazetak, 'Cijena je iznad raspona.');
});

// ── obrada u validaciji ──
test('validirajAnalizu: obrada čisti sva polja i vraća popis promjena za log', () => {
  const v = validirajAnalizu(osnova({
    sazetak: 'Visoka HOA, je li li renovirano?',
    prednosti: ['Dobrу lokacija'],
    rizici: [{ naslov: 'Pričuva', opis: 'HOA je je visoka.', razina: 'srednji' }],
  }));
  assert.equal(v.ok, true, v.razlog);
  assert.equal(v.analiza.sazetak, 'Visoka pričuva, je li renovirano?');
  assert.deepEqual(v.analiza.prednosti, ['Dobru lokacija']);
  assert.equal(v.analiza.rizici[0].opis, 'pričuva je visoka.');
  assert.deepEqual(new Set(v.obrada.map((o) => o.vrsta)), new Set(['strani_pojam', 'ponovljena_rijec', 'cirilica']));
  assert.ok(v.obrada.some((o) => o.polje === 'prednosti[0]'));
});

// ── B7 razlog korekcije ──
test('razlog korekcije: shema i konstanta traže najviše ~35 znakova, rez ostaje na 40', () => {
  assert.equal(zajednicki.FER.CILJ_RAZLOG, 35);
  assert.equal(zajednicki.FER.MAX_RAZLOG, 40);
  const opis = TOOL_PROCJENA.input_schema.properties.korekcije.items.properties.razlog.description;
  assert.match(opis, /35/);
  assert.match(opis, /starost zgrade ~46 god\., energetski/);
  assert.ok('starost zgrade ~46 god., energetski'.length <= 35);
  assert.match(TOOL.input_schema.properties.sazetak.description, /JEDNA rečenica/);
});

test('procjena: razlog korekcije prolazi jezičnu obradu (ćirilica, HOA)', () => {
  const r = parsirajIValidirajProcjenu(JSON.stringify({
    korekcije: [{ razlog: 'visoka HOA', postotak: -3 }, { razlog: 'bez lifta у zgradi', postotak: -4 }],
    pouzdanost: 'srednja', povrsina_m2: 60, najam: { dugorocni_mj_eur: 800, turisticki_godisnje_eur: null },
  }), { medijan_eur_m2: 3000, povrsina_m2: 60 });
  assert.equal(r.ok, true, r.razlog);
  assert.deepEqual(r.procjena.fer_vrijednost.izracun.korekcije.map((k) => k.razlog), ['visoka pričuva', 'bez lifta u zgradi']);
  assert.equal(r.obrada.length, 2);
});

test('recenice: kratice ne prekidaju rečenicu', () => {
  assert.deepEqual(recenice('Stan je u k.o. Trešnjevka, tj. blizu centra. Druga rečenica.'), ['Stan je u k.o. Trešnjevka, tj. blizu centra.', 'Druga rečenica.']);
});
