// Testovi referentnih tržišnih podataka (data/trziste.json, netlify/lib/trziste.mjs): struktura podataka,
// normalizacija i prepoznavanje lokacije, usklađivanje DZS indeksom, prompt, pravila pouzdanosti.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normaliziraj, nadjiGradPoImenu, nadjiKvartPoImenu, gradIzTeksta, kvartIzTeksta, uskladiMedijan, odrediReferencu,
  tekstReference, ogranicitiPouzdanost, ogranicitiNajam, referencaZaKlijenta,
  nadjiKo, rjecnikKo, napomenaKvarta, nazivPolazista, MIN_PRODAJA_KO, granicaPouzdanosti,
} from '../netlify/lib/trziste.mjs';

const sirovo = fs.readFileSync(path.join(import.meta.dirname, '../data/trziste.json'), 'utf8');
const baza = JSON.parse(sirovo);

// Izmišljeni fixture za tražene cijene po zonama (tip "trazena" je u stvarnim podacima prazan do dozvole izvora).
// Iznosi su lažni i služe samo za provjeru koda; imena zona su ista kao u prijašnjim podacima.
const zona = (n) => ({ prosjek_eur_m2: n, izvor: 'https://primjer.test/trazene', datum: '2000-01' });
const bazaSTrazenim = {
  ...baza,
  trazena: {
    gradovi: {
      Zagreb: {
        ...zona(1111),
        kvartovi: {
          Trnje: zona(1001), Maksimir: zona(1002), 'Donji grad': zona(1003), 'Trešnjevka - jug': zona(1004),
          'Trešnjevka - sjever': zona(1005), 'Novi Zagreb - istok': zona(1006), 'Novi Zagreb - zapad': zona(1007),
        },
      },
      Split: { ...zona(2222), kvartovi: { Centar: zona(2001), 'Firule, Trstenik, Žnjan': zona(2002) } },
    },
  },
};

const GRADOVI_24 = ['Rijeka', 'Kaštela', 'Split', 'Pazin', 'Pula', 'Koprivnica', 'Bjelovar', 'Osijek', 'Samobor', 'Velika Gorica', 'Sisak',
  'Varaždin', 'Zadar', 'Čakovec', 'Vukovar', 'Vinkovci', 'Virovitica', 'Karlovac', 'Slavonski Brod', 'Šibenik', 'Krapina', 'Dubrovnik',
  'Požega', 'Gospić'];

test('podaci: nema nekretnine.hr vrijednosti (uvjeti korištenja zabranjuju komercijalnu uporabu)', () => {
  assert.ok(!/nekretnine\.hr/i.test(sirovo), 'nijedan URL ni naziv nekretnine.hr');
  assert.ok(!('prosjek_eur_m2' in baza.realizirane) && !sirovo.includes('najam_eur_m2_mj'), 'nema prodajnih ni najamnih prosjeka s portala');
  assert.deepEqual(baza.trazena.gradovi, {}, 'tip "trazena" je prazan dok nema dozvole');
});

test('podaci: Zagreb + 24 velika grada, medijan stanova 2025., broj prodaja, regija, izvor', () => {
  const g = baza.realizirane.gradovi;
  assert.deepEqual(Object.keys(g).sort(), ['Zagreb', ...GRADOVI_24].sort());
  assert.equal(baza.realizirane.godina, 2025);
  assert.match(baza.realizirane.izvor.tablica, /Tablica 3\.6\./);
  assert.match(baza.realizirane.izvor.url, /^https:\/\/mpgi\.gov\.hr\//);
  for (const [grad, v] of Object.entries(g)) {
    assert.ok(Number.isInteger(v.medijan_eur_m2) && v.medijan_eur_m2 > 500 && v.medijan_eur_m2 < 8000, grad);
    assert.ok(Number.isInteger(v.broj_prodaja) && v.broj_prodaja >= 10, `${grad}: izvor ne objavljuje ispod 10 prodaja`);
    assert.ok(['Zagreb', 'Jadran', 'Ostalo', null].includes(v.regija_dzs), grad);
  }
  // vrijednosti prepisane iz Tablice 3.6. (provjereno s Excel prilogom)
  assert.deepEqual([g.Zagreb.medijan_eur_m2, g.Zagreb.broj_prodaja], [2917, 7616]);
  assert.deepEqual([g.Zadar.medijan_eur_m2, g.Zadar.broj_prodaja], [2874, 707]);
  assert.deepEqual([g.Split.medijan_eur_m2, g.Split.broj_prodaja], [4067, 820], 'tablica kaže 820 (tekst publikacije 850)');
  assert.deepEqual([g.Sisak.medijan_eur_m2, g.Sisak.broj_prodaja], [1325, 119]);
  assert.deepEqual([g.Vukovar.medijan_eur_m2, g.Vukovar.broj_prodaja], [1011, 135]);
});

test('podaci: DZS regije — Zagreb / Jadran / Ostalo; Pazin i Gospić nisu potvrđeni', () => {
  const g = baza.realizirane.gradovi;
  assert.equal(g.Zagreb.regija_dzs, 'Zagreb');
  for (const j of ['Rijeka', 'Kaštela', 'Split', 'Pula', 'Zadar', 'Šibenik', 'Dubrovnik']) assert.equal(g[j].regija_dzs, 'Jadran', j);
  for (const o of ['Osijek', 'Varaždin', 'Karlovac', 'Sisak', 'Slavonski Brod', 'Požega', 'Krapina']) assert.equal(g[o].regija_dzs, 'Ostalo', o);
  assert.equal(g.Pazin.regija_dzs, null);
  assert.equal(g.Gospić.regija_dzs, null);
  assert.match(baza.indeks.definicija_regija, /PC-Axis.*nije dohvaćen/);
});

test('podaci: DZS indeks — Ø 2025 = 100, razine za I. i II. tromjesečje 2026., bez budućih objava', () => {
  const i = baza.indeks;
  assert.deepEqual(i.prosjek_2025, { Zagreb: 100, Jadran: 100, Ostalo: 100 });
  assert.deepEqual(Object.keys(i.razdoblja), ['2026-Q1', '2026-Q2'], 'Q3/Q4 2026. imaju buduće datume objave i ne unose se');
  assert.deepEqual(i.razdoblja['2026-Q1'].regije, { Zagreb: 109.04, Jadran: 107.22, Ostalo: 109.77 });
  assert.deepEqual(i.razdoblja['2026-Q2'].regije, { Zagreb: 113.53, Jadran: 108.46, Ostalo: 113.34 });
  assert.equal(i.razdoblja['2026-Q2'].privremeno, true);
  assert.equal(i.razdoblja['2026-Q1'].privremeno, false);
  assert.equal(i.koristi, '2026-Q2');
  for (const r of Object.values(i.razdoblja)) assert.ok(r.objavljeno <= '2026-10-06', 'objavljeno ne smije biti u budućnosti');
});

test('podaci: katastarske općine Zagreba — medijani su spremljeni, a koriste se samo uz pouzdano mapiranje', () => {
  const ko = baza.realizirane.zagreb_katastarske_opcine;
  assert.doesNotMatch(ko.napomena, /NE KORISTI SE/);
  assert.match(ko.napomena, /najmanje 30 prodaja/);
  assert.equal(ko.opcine['Zaprudski Otok'].medijan_eur_m2, 2946);
  assert.equal(ko.opcine['Zaprudski Otok'].broj_prodaja, 442);
  assert.equal(ko.opcine['Centar Novi'].medijan_eur_m2, 3256);
});

// ── kvart → k.o. (Zagreb): medijan k.o. umjesto gradskog ──
const ZG = (kvart, tekst = '') => odrediReferencu({ grad: 'Zagreb', kvart }, tekst);

test('k.o.: Središće (i s tipfelerom, bez dijakritika, velika/mala slova) → Zaprudski Otok; medijan k.o. usklađen istim DZS indeksom', () => {
  for (const unos of ['Središće', 'sredisce', 'SREDIŠĆE', 'sredušće', 'srediste', 'Sredisče', ' središće ']) {
    const r = ZG(unos);
    assert.equal(r.ko, 'Zaprudski Otok', unos);
    assert.equal(r.razina, 'ko', unos);
    assert.equal(r.kvartStatus, 'ko', unos);
    assert.deepEqual(
      [r.realizirana.medijan_eur_m2, r.realizirana.broj_prodaja, r.realizirana.uskladeno_eur_m2, r.realizirana.regija_dzs],
      [2946, 442, Math.round(2946 * 113.53 / 100), 'Zagreb'], unos);
  }
  assert.equal(nazivPolazista(ZG('Središće')), 'k.o. Zaprudski Otok');
  assert.match(tekstReference(ZG('Središće')), /katastarska općina Zaprudski Otok \(Grad Zagreb\)/);
  assert.equal(granicaPouzdanosti(ZG('Središće')), 'srednja', 'k.o. ne diže pouzdanost na visoku');
});

test('k.o.: točni nazivi k.o. i potvrđena jednoznačna imena; nema spajanja različitih kvartova', () => {
  const ko = (unos) => nadjiKo('Zagreb', unos);
  assert.deepEqual(ko('Trnje'), { status: 'ko', ko: 'Trnje' });
  assert.deepEqual(ko('trenje'), { status: 'ko', ko: 'Trnje' }, 'tipfeler (1 slovo)');
  assert.deepEqual(ko('Klara Nova'), { status: 'ko', ko: 'Klara Nova' });
  assert.deepEqual(ko('Stenjevec Jug'), { status: 'ko', ko: 'Stenjevec Jug' });
  assert.deepEqual(ko('Stenjevec Sjever'), { status: 'ko', ko: 'Stenjevec Sjever' });
  assert.deepEqual(ko('Gornje Vrapče'), { status: 'ko', ko: 'Gornje Vrapče' });
  assert.deepEqual(ko('Donje Vrapče'), { status: 'ko', ko: 'Donje Vrapče' });
  // nazivi koji nisu jedna k.o.: ne pogađa se
  for (const nejasno of ['Trešnjevka', 'Stenjevec', 'Klara', 'Centar', 'Vrapče', 'Dubrava', 'Sesvete', 'trešnjevka']) {
    assert.deepEqual(ko(nejasno), { status: 'dvosmisleno' }, nejasno);
  }
  // kratki nazivi samo točno; nepoznato i prazno
  assert.deepEqual(ko('Odrr'), { status: 'nepoznat' });
  assert.deepEqual(ko('Utrine'), { status: 'nepoznat' });
  assert.equal(ko('  '), null);
  // tipfeler u zadnjem slovu bilo kojeg naziva (duljine ≥ 5) ne smije dati drugu k.o.
  const rj = rjecnikKo('Zagreb');
  for (const [k, v] of rj) {
    if (k.length < 5) continue;
    const r = nadjiKo('Zagreb', k.slice(0, -1) + (k.at(-1) === 'x' ? 'y' : 'x'));
    assert.ok(r.status === 'nepoznat' || (v === null ? r.status === 'dvosmisleno' : r.ko === v), `${k} → ${JSON.stringify(r)}`);
  }
  // k.o. se ne traži izvan Zagreba
  assert.deepEqual(nadjiKo('Split', 'Središće'), { status: 'nepoznat' });
});

test('k.o.: nepoznat kvart → gradski medijan s oznakom; dvosmislen kvart → gradski medijan s oznakom', () => {
  const nepoznat = ZG('Utrine');
  assert.deepEqual([nepoznat.ko, nepoznat.razina, nepoznat.kvartStatus], [null, 'grad', 'nepoznat']);
  assert.equal(nepoznat.realizirana.uskladeno_eur_m2, 3312, 'gradski medijan');
  assert.equal(napomenaKvarta(nepoznat), 'Kvart „Utrine” nije mapiran na k.o.: gradski medijan.');
  assert.match(tekstReference(nepoznat), /Grad Zagreb: medijan[\s\S]*Napomena: Kvart „Utrine” nije mapiran/);
  assert.equal(nazivPolazista(nepoznat), 'Zagreb');
  const dvosmisleno = ZG('Trešnjevka');
  assert.deepEqual([dvosmisleno.ko, dvosmisleno.kvartStatus, dvosmisleno.realizirana.uskladeno_eur_m2], [null, 'dvosmisleno', 3312]);
  assert.match(napomenaKvarta(dvosmisleno), /obuhvaća više k\.o\.: gradski medijan/);
  // bez upisanog kvarta nema oznake (kao prije)
  const bez = ZG(undefined);
  assert.deepEqual([bez.ko, bez.kvartStatus, napomenaKvarta(bez)], [null, null, null]);
});

test('k.o. s premalo prodaja (< 30) → gradski medijan s oznakom; prag je konstanta', () => {
  assert.equal(MIN_PRODAJA_KO, 30);
  const malo = ZG('Lučko'); // 24 prodaje
  assert.deepEqual([malo.ko, malo.kvartStatus, malo.kvartKo, malo.realizirana.uskladeno_eur_m2], [null, 'malo_prodaja', 'Lučko', 3312]);
  assert.match(napomenaKvarta(malo), /K\.o\. Lučko ima manje od 30 prodaja: gradski medijan\./);
  // prag je granični: točno 31 prodaja prolazi (Gornji Stenjevec ima 31)
  assert.equal(ZG('Gornji Stenjevec').ko, 'Gornji Stenjevec');
});

test('k.o. u referenci za klijenta: naziv k.o. i napomena kad je korišten gradski medijan', () => {
  const k = referencaZaKlijenta(ZG('Središće'));
  assert.equal(k.ko, 'Zaprudski Otok');
  assert.equal(k.naziv, 'Zagreb');
  assert.equal(k.realizirana.medijan_eur_m2, 2946);
  assert.equal(k.realizirana.broj_prodaja, 442);
  assert.ok(!('napomena_kvart' in k));
  const g = referencaZaKlijenta(ZG('Utrine'));
  assert.ok(!('ko' in g));
  assert.equal(g.napomena_kvart, 'Kvart „Utrine” nije mapiran na k.o.: gradski medijan.');
});

test('normalizacija: dijakritici, đ, velika slova, crtice i razmaci', () => {
  assert.equal(normaliziraj('  Trešnjevka – JUG '), 'tresnjevka jug');
  assert.equal(normaliziraj('Đakovo, Čakovec, Žnjan, Šibenik, Ćosić'), 'dakovo cakovec znjan sibenik cosic');
  assert.equal(normaliziraj(null), '');
});

test('grad iz forme: svih 25 gradova, velika/mala slova, dijakritici, "grad X", padeži; nepoznat → null', () => {
  for (const g of Object.keys(baza.realizirane.gradovi)) {
    assert.equal(nadjiGradPoImenu(g), g, g);
    assert.equal(nadjiGradPoImenu(g.toUpperCase()), g, g.toUpperCase());
    assert.equal(nadjiGradPoImenu(`grad ${g}`), g, `grad ${g}`);
  }
  for (const [unos, grad] of [['varazdin', 'Varaždin'], ['Splitu', 'Split'], ['  osijek ', 'Osijek'], ['SLAVONSKI  BROD', 'Slavonski Brod'],
    ['velika gorica', 'Velika Gorica'], ['Sibenik', 'Šibenik'], ['pozega', 'Požega'], ['Kastelima', 'Kaštela']]) {
    assert.equal(nadjiGradPoImenu(unos), grad, unos);
  }
  assert.equal(nadjiGradPoImenu('Makarska'), null);
  assert.equal(nadjiGradPoImenu(''), null);
});

test('grad iz teksta: padeži, višerječni nazivi, jedinstvenost, velika slova za riječi koje su i imenice', () => {
  assert.equal(gradIzTeksta('Stan u Zagrebu, blizu parka'), 'Zagreb');
  assert.equal(gradIzTeksta('STAN U ZAGREBU'), 'Zagreb');
  assert.equal(gradIzTeksta('Stan u Splitu'), 'Split');
  assert.equal(gradIzTeksta('Stan s split klimom u Zadru'), 'Zadar', 'split klima nije grad');
  assert.equal(gradIzTeksta('Stan uz rijeku, Osijek'), 'Osijek', 'rijeka kao imenica nije grad');
  assert.equal(gradIzTeksta('Stan u Rijeci'), 'Rijeka');
  assert.equal(gradIzTeksta('Stan u Varaždinu'), 'Varaždin');
  assert.equal(gradIzTeksta('Stan u Varaždinskoj županiji'), null);
  assert.equal(gradIzTeksta('Stan u Velikoj Gorici'), 'Velika Gorica');
  assert.equal(gradIzTeksta('Stan u Slavonskom Brodu'), 'Slavonski Brod');
  assert.equal(gradIzTeksta('Stan u Kaštelima'), 'Kaštela');
  assert.equal(gradIzTeksta('Kuća u Šibeniku'), 'Šibenik');
  assert.equal(gradIzTeksta('Stan u Karlovcu'), 'Karlovac');
  assert.equal(gradIzTeksta('Stan u Zagrebu, 20 min od Splita'), null, 'više gradova → dvosmisleno');
  assert.equal(gradIzTeksta('Kuća na selu'), null);
});

test('usklađivanje: medijan 2025. × (indeks zadnjeg razdoblja / indeks prosjeka 2025.)', () => {
  const z = uskladiMedijan(2917, 'Zagreb', baza.indeks);
  assert.equal(z.uskladeno_eur_m2, Math.round(2917 * (113.53 / 100)));
  assert.equal(z.uskladeno_eur_m2, 3312);
  assert.equal(z.faktor, 1.1353);
  assert.deepEqual([z.razdoblje, z.privremeno], ['II. tromjesečje 2026.', true]);
  assert.equal(uskladiMedijan(2874, 'Jadran', baza.indeks).uskladeno_eur_m2, 3117);
  assert.equal(uskladiMedijan(1666, 'Ostalo', baza.indeks).uskladeno_eur_m2, 1888);
  // drugo razdoblje i druga osnova: računa kod, ne podaci
  const q1 = { ...baza.indeks, koristi: '2026-Q1' };
  assert.equal(uskladiMedijan(2917, 'Zagreb', q1).uskladeno_eur_m2, Math.round(2917 * 1.0904));
  assert.equal(uskladiMedijan(1000, 'Zagreb', { prosjek_2025: { Zagreb: 50 }, koristi: 'x', razdoblja: { x: { naziv: 'x', regije: { Zagreb: 75 } } } }).uskladeno_eur_m2, 1500);
  // bez regije / bez indeksa / neispravno → null
  assert.equal(uskladiMedijan(2182, null, baza.indeks), null);
  assert.equal(uskladiMedijan(2917, 'Nepoznato', baza.indeks), null);
  assert.equal(uskladiMedijan(2917, 'Zagreb', {}), null);
  assert.equal(uskladiMedijan(0, 'Zagreb', baza.indeks), null);
});

test('odrediReferencu: razina grada s usklađenim medijanom; forma ima prednost; nepoznat upisani grad ne ide u tekst', () => {
  const a = odrediReferencu({ grad: 'ZAGREB', kvart: 'Novi Zagreb - istok' }, 'Stan u Splitu');
  assert.deepEqual([a.grad, a.kvart, a.razina], ['Zagreb', null, 'grad'], 'kvart se ne koristi bez traženih cijena po zonama');
  assert.deepEqual([a.realizirana.medijan_eur_m2, a.realizirana.broj_prodaja, a.realizirana.uskladeno_eur_m2, a.realizirana.regija_dzs], [2917, 7616, 3312, 'Zagreb']);
  const b = odrediReferencu({}, 'Stan u Zadru');
  assert.deepEqual([b.grad, b.razina, b.realizirana.uskladeno_eur_m2], ['Zadar', 'grad', 3117]);
  const c = odrediReferencu({ grad: 'Makarska' }, 'Stan u Zagrebu');
  assert.deepEqual([c.grad, c.razina, c.realizirana], [null, null, null]);
  const d = odrediReferencu({ grad: 'Pazin' }, 'Stan');
  assert.deepEqual([d.grad, d.razina, d.realizirana], ['Pazin', null, null], 'Pazin nema potvrđenu DZS regiju → nema reference');
  assert.equal(odrediReferencu({}, 'Stan u Gospiću').razina, null);
  assert.equal(odrediReferencu(undefined, '').razina, null);
});

test('tekst reference: medijani stvarno plaćenih cijena, broj prodaja, faktor, tromjesečje, izvori; bez reference', () => {
  const t = tekstReference(odrediReferencu({ grad: 'Zagreb' }, ''));
  assert.match(t, /REALIZIRANE cijene \(transakcijske, ne tražene\)/);
  assert.match(t, /Grad Zagreb: medijan stvarno plaćenih cijena stanova\/apartmana u 2025\. iznosi 2917 €\/m² \(7616 prodaja; svi stanovi svih starosti i stanja/);
  assert.match(t, /Usklađen DZS indeksom cijena stambenih objekata \(regija Zagreb, faktor 1,1353\) na II\. tromjesečje 2026\. \(privremeni podaci\): 3312 €\/m²/);
  assert.match(t, /Ministarstvo prostornoga uređenja, graditeljstva i državne imovine \(Pregled tržišta nekretnina 2025\.\); Državni zavod za statistiku/);
  assert.ok(!/TRAŽENE/.test(t), 'bez traženih cijena nema ni njihovog bloka');
  assert.match(tekstReference(odrediReferencu({}, 'Stan')), /NEMA podataka.*"niska".*širi/);
  assert.match(tekstReference(odrediReferencu({ grad: 'Gospić' }, '')), /NEMA podataka/);
});

test('tip "trazena" (opcionalan): kad su podaci popunjeni, kvart i grad ulaze kao dodatna referenca i dižu razinu', () => {
  const r = odrediReferencu({ grad: 'Zagreb', kvart: 'Novi Zagreb - istok' }, '', bazaSTrazenim);
  assert.deepEqual([r.razina, r.kvart, r.trazenaKvart.prosjek_eur_m2, r.trazenaGrad.prosjek_eur_m2], ['kvart', 'Novi Zagreb - istok', 1006, 1111]);
  assert.equal(r.realizirana.uskladeno_eur_m2, 3312, 'realizirana ostaje polazište');
  const t = tekstReference(r);
  assert.match(t, /TRAŽENE \(oglasne\) cijene, ne transakcijske/);
  assert.match(t, /Kvart Novi Zagreb - istok \(Zagreb\): prosjek tražene cijene 1006 €\/m²/);
  const k = referencaZaKlijenta(r);
  assert.deepEqual([k.trazena.naziv, k.trazena.prosjek_eur_m2], ['Novi Zagreb - istok (Zagreb)', 1006]);
  assert.equal(referencaZaKlijenta(odrediReferencu({ grad: 'Zagreb' }, '')).trazena, null);
  // samo grad (kvart nije prepoznat) → razina grada
  assert.equal(odrediReferencu({ grad: 'Zagreb', kvart: 'Nepoznato' }, '', bazaSTrazenim).razina, 'grad');
});

test('aliasi kvartova (uz tražene cijene po zonama): Središće → Novi Zagreb - istok, Sveta Klara → zapad', () => {
  const k = (grad, unos) => nadjiKvartPoImenu(grad, unos, bazaSTrazenim);
  assert.equal(k('Zagreb', 'Središće'), 'Novi Zagreb - istok');
  assert.equal(k('Zagreb', 'SREDISCE'), 'Novi Zagreb - istok');
  for (const n of ['Sloboština', 'Utrine', 'Travno', 'Dugave', 'Zapruđe', 'Sopot', 'Siget']) assert.equal(k('Zagreb', n), 'Novi Zagreb - istok', n);
  assert.equal(k('Zagreb', 'Sveta Klara'), 'Novi Zagreb - zapad', 'Sveta Klara NIJE u istoku');
  assert.notEqual(k('Zagreb', 'Središće'), 'Trnje');
  assert.equal(k('Zagreb', 'Novi Zagreb - istok'), 'Novi Zagreb - istok');
  assert.equal(k('Zagreb', 'NOVI ZAGREB ISTOK'), 'Novi Zagreb - istok');
  assert.equal(k('Zagreb', 'Trešnjevka'), null, 'dvosmisleno (jug/sjever)');
  assert.equal(k('Zagreb', 'Medveščak'), null);
  assert.equal(k('Split', 'Žnjan'), 'Firule, Trstenik, Žnjan');
  assert.equal(k('Dubrovnik', 'Lapad'), null);
  const t = (grad, tekst) => kvartIzTeksta(grad, tekst, bazaSTrazenim);
  assert.equal(t('Zagreb', 'Stan u Središću'), 'Novi Zagreb - istok');
  assert.equal(t('Zagreb', 'Stan u Sloboštini'), 'Novi Zagreb - istok');
  assert.equal(t('Zagreb', 'Stan u Svetoj Klari'), null, 'nepoznat padež → bez zone, ne kriva zona');
  assert.equal(t('Zagreb', 'Stan u blizini centra'), null);
  assert.equal(t('Zagreb', 'Stan u Trnju i na Maksimiru'), null, 'dvije zone → dvosmisleno');
  assert.equal(t('Zagreb', 'Stan u Trnju'), 'Trnje');
  // bez traženih cijena nema zona uopće
  assert.equal(nadjiKvartPoImenu('Zagreb', 'Središće'), null);
  assert.equal(kvartIzTeksta('Zagreb', 'Stan u Središću'), null);
});

test('pouzdanost: grad → najviše srednja; bez reference → niska; kvart (tražene cijene) → visoka dopuštena', () => {
  const p = (pouzdanost) => ({ fer_vrijednost: { min_eur: 1, max_eur: 2, pouzdanost, obrazlozenje: 'x' }, najam: {} });
  const grad = odrediReferencu({ grad: 'Zagreb' }, '');
  const nista = odrediReferencu({}, '');
  const kvart = odrediReferencu({ grad: 'Zagreb', kvart: 'Trnje' }, '', bazaSTrazenim);
  assert.equal(ogranicitiPouzdanost(p('visoka'), grad).fer_vrijednost.pouzdanost, 'srednja');
  assert.equal(ogranicitiPouzdanost(p('srednja'), grad).fer_vrijednost.pouzdanost, 'srednja');
  assert.equal(ogranicitiPouzdanost(p('niska'), grad).fer_vrijednost.pouzdanost, 'niska');
  assert.equal(ogranicitiPouzdanost(p('visoka'), nista).fer_vrijednost.pouzdanost, 'niska');
  assert.equal(ogranicitiPouzdanost(p('srednja'), nista).fer_vrijednost.pouzdanost, 'niska');
  assert.equal(ogranicitiPouzdanost(p('visoka'), kvart).fer_vrijednost.pouzdanost, 'visoka');
  const ulaz = p('visoka');
  ogranicitiPouzdanost(ulaz, nista);
  assert.equal(ulaz.fer_vrijednost.pouzdanost, 'visoka', 'ulaz se ne mijenja');
});

test('najam: pouzdanost najviše srednja i nikad viša od pouzdanosti fer vrijednosti (postavlja kod)', () => {
  const p = (pouzdanost) => ({ fer_vrijednost: { pouzdanost }, najam: { dugorocni_mj_eur: 800, turisticki_godisnje_eur: null } });
  assert.deepEqual(ogranicitiNajam(p('visoka')).najam, { dugorocni_mj_eur: 800, turisticki_godisnje_eur: null, pouzdanost: 'srednja' });
  assert.equal(ogranicitiNajam(p('srednja')).najam.pouzdanost, 'srednja');
  assert.equal(ogranicitiNajam(p('niska')).najam.pouzdanost, 'niska');
});

test('referenca za klijenta: usklađena realizirana vrijednost, null bez reference', () => {
  assert.equal(referencaZaKlijenta(odrediReferencu({}, 'Stan')), null);
  assert.equal(referencaZaKlijenta(odrediReferencu({ grad: 'Pazin' }, '')), null);
  assert.deepEqual(referencaZaKlijenta(odrediReferencu({ grad: 'Zadar' }, '')), {
    razina: 'grad', naziv: 'Zadar', trazena: null,
    realizirana: { godina: 2025, medijan_eur_m2: 2874, broj_prodaja: 707, uskladeno_eur_m2: 3117, indeks_razdoblje: 'II. tromjesečje 2026.', privremeno: true },
  });
});
