// PropIQ — referentni tržišni podaci (data/trziste.json) za slijepu procjenu (poziv 1).
// Model ima zastarjele cijene, pa kod prepozna grad (iz polja forme ili iz teksta oglasa), nađe medijan
// STVARNO PLAĆENIH cijena stanova (MPGI/EIZ, 2025.) i uskladi ga DZS indeksom cijena stambenih objekata na
// zadnje objavljeno tromjesečje. Taj usklađeni medijan je polazište procjene. Isti podatak kontrolira
// najvišu dopuštenu pouzdanost. Za Zagreb se, kad je kvart pouzdano mapiran na katastarsku općinu s dovoljno prodaja,
// umjesto gradskog koristi medijan te k.o. (isto usklađen DZS indeksom). Tražene (oglasne) cijene po gradu/kvartu čitaju se iz "trazena" (zasad prazno,
// čeka dozvolu izvora) i, kad postoje, dodaju se kao dodatna referenca. Koristi ga netlify/functions/analiza.mjs.

import TRZISTE from '../../data/trziste.json' with { type: 'json' };

export const IZVORI_NAZIV = 'Ministarstvo prostornoga uređenja, graditeljstva i državne imovine (Pregled tržišta nekretnina 2025.); Državni zavod za statistiku';

// Mala slova, bez dijakritika (đ se ne razlaže pa se mijenja ručno), sve što nije slovo/broj → razmak.
export function normaliziraj(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Oblici imena grada koji se traže u tekstu oglasa (nominativ i padeži koji se stvarno pišu: "u Splitu"),
// normalizirani i rastavljeni po riječima. velikoSlovo: riječ je i obična imenica (rijeka, split klima)
// pa se u tekstu traži samo velikim početnim slovom.
const GRADOVI_OBLICI = {
  Zagreb: { oblici: ['zagreb', 'zagreba', 'zagrebu', 'zagrebom'] },
  Rijeka: { oblici: ['rijeka', 'rijeke', 'rijeci', 'rijeku', 'rijekom'], velikoSlovo: true },
  Kaštela: { oblici: ['kastela', 'kastelima'] },
  Split: { oblici: ['split', 'splita', 'splitu', 'splitom'], velikoSlovo: true },
  Pazin: { oblici: ['pazin', 'pazina', 'pazinu', 'pazinom'] },
  Pula: { oblici: ['pula', 'pule', 'puli', 'pulu', 'pulom'], velikoSlovo: true },
  Koprivnica: { oblici: ['koprivnica', 'koprivnice', 'koprivnici', 'koprivnicu', 'koprivnicom'] },
  Bjelovar: { oblici: ['bjelovar', 'bjelovara', 'bjelovaru', 'bjelovarom'] },
  Osijek: { oblici: ['osijek', 'osijeka', 'osijeku', 'osijekom'] },
  Samobor: { oblici: ['samobor', 'samobora', 'samoboru', 'samoborom'] },
  'Velika Gorica': { oblici: ['velika gorica', 'velike gorice', 'velikoj gorici', 'veliku goricu', 'velikom goricom'] },
  Sisak: { oblici: ['sisak', 'siska', 'sisku', 'siskom'] },
  Varaždin: { oblici: ['varazdin', 'varazdina', 'varazdinu', 'varazdinom'] },
  Zadar: { oblici: ['zadar', 'zadra', 'zadru', 'zadrom'] },
  Čakovec: { oblici: ['cakovec', 'cakovca', 'cakovcu', 'cakovcem'] },
  Vukovar: { oblici: ['vukovar', 'vukovara', 'vukovaru', 'vukovarom'] },
  Vinkovci: { oblici: ['vinkovci', 'vinkovaca', 'vinkovcima'] },
  Virovitica: { oblici: ['virovitica', 'virovitice', 'virovitici', 'viroviticu', 'viroviticom'] },
  Karlovac: { oblici: ['karlovac', 'karlovca', 'karlovcu', 'karlovcem'] },
  'Slavonski Brod': { oblici: ['slavonski brod', 'slavonskog broda', 'slavonskom brodu', 'slavonskim brodom'] },
  Šibenik: { oblici: ['sibenik', 'sibenika', 'sibeniku', 'sibenikom'] },
  Krapina: { oblici: ['krapina', 'krapine', 'krapini', 'krapinu', 'krapinom'] },
  Dubrovnik: { oblici: ['dubrovnik', 'dubrovnika', 'dubrovniku', 'dubrovnikom'] },
  Požega: { oblici: ['pozega', 'pozege', 'pozegi', 'pozegu', 'pozegom'] },
  Gospić: { oblici: ['gospic', 'gospica', 'gospicu', 'gospicem'] },
};

// Naselje/kvart → zona (normalizirani naziv naselja → ključ zone). Zemljopisno preslikavanje, ne cijene.
// Koristi se samo uz tražene cijene po zonama ("trazena"); medijani realiziranih cijena su na razini grada.
const ALIASI_KVARTOVA = {
  Zagreb: {
    sredisce: 'Novi Zagreb - istok',
    slobostina: 'Novi Zagreb - istok',
    utrine: 'Novi Zagreb - istok',
    travno: 'Novi Zagreb - istok',
    dugave: 'Novi Zagreb - istok',
    zaprude: 'Novi Zagreb - istok',
    sopot: 'Novi Zagreb - istok',
    siget: 'Novi Zagreb - istok',
    'sveta klara': 'Novi Zagreb - zapad',
  },
};

// Zone koje su preopćenite da bi se prepoznale iz slobodnog teksta ("blizu centra"); iz forme se prihvaćaju.
const GENERICNI_U_TEKSTU = new Set(['centar']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Firule, Trstenik, Žnjan" → ['firule', 'trstenik', 'znjan']; "Štinjan i Industrijska zona" → dva dijela.
const dijeloviKljuca = (kljuc) => kljuc.split(/,| i /).map(normaliziraj).filter(Boolean);

// Prefiks za podudaranje padeža u tekstu ("Trnju", "Maksimiru"): skida zadnja 1–2 slova.
const korijen = (n) => (n.length >= 7 ? n.slice(0, -2) : n.length >= 5 ? n.slice(0, -1) : n);

const gradoviBaze = (baza) => Object.keys(baza.realizirane.gradovi);
const kvartoviTrazene = (baza, grad) => (((baza.trazena || {}).gradovi || {})[grad] || {}).kvartovi || {};

export function nadjiGradPoImenu(unos, baza = TRZISTE) {
  const n = normaliziraj(unos).replace(/^grad /, '');
  if (!n) return null;
  for (const grad of gradoviBaze(baza)) {
    const oblici = (GRADOVI_OBLICI[grad] || { oblici: [] }).oblici;
    if (normaliziraj(grad) === n || oblici.includes(n)) return grad;
  }
  return null;
}

// Grad iz teksta oglasa (riječi i višerječna imena). Ako se spominje više različitih poznatih gradova
// ("20 min od Zagreba"), nema jednoznačnog odgovora pa je rezultat null — bolje bez reference nego s pogrešnom.
export function gradIzTeksta(tekst, baza = TRZISTE) {
  const rijeci = String(tekst ?? '').split(/[^\p{L}\d]+/u).filter(Boolean).map((orig) => ({ orig, n: normaliziraj(orig) }));
  const nadjeni = new Set();
  for (const grad of gradoviBaze(baza)) {
    const cfg = GRADOVI_OBLICI[grad];
    if (!cfg) continue;
    for (const oblik of cfg.oblici) {
      const dijelovi = oblik.split(' ');
      for (let i = 0; i + dijelovi.length <= rijeci.length; i++) {
        if (!dijelovi.every((d, j) => rijeci[i + j].n === d)) continue;
        const prva = rijeci[i].orig;
        if (cfg.velikoSlovo && prva[0] === prva[0].toLowerCase()) continue;
        nadjeni.add(grad);
      }
    }
  }
  return nadjeni.size === 1 ? [...nadjeni][0] : null;
}

// Kvart iz polja forme (samo ako postoje tražene cijene po zonama): normalizirani unos mora biti naziv zone,
// jedan njezin dio ili alias; mora biti jednoznačan.
export function nadjiKvartPoImenu(grad, unos, baza = TRZISTE) {
  const kvartovi = kvartoviTrazene(baza, grad);
  const n = normaliziraj(unos);
  if (!n) return null;
  const alias = (ALIASI_KVARTOVA[grad] || {})[n];
  if (alias && kvartovi[alias]) return alias;
  const pogodci = Object.keys(kvartovi).filter((k) => normaliziraj(k) === n || dijeloviKljuca(k).includes(n));
  return pogodci.length === 1 ? pogodci[0] : null;
}

// Kvart iz teksta oglasa (samo unutar poznatog grada, samo uz tražene cijene po zonama): zona se prepoznaje
// po cijelom nazivu (ili dijelu naziva odvojenom zarezom), uz padežne nastavke. Više različitih zona → null.
export function kvartIzTeksta(grad, tekst, baza = TRZISTE) {
  const kvartovi = kvartoviTrazene(baza, grad);
  const n = ` ${normaliziraj(tekst)}`;
  const nadjeni = new Set();
  const trazi = (naziv, kljuc) => {
    if (GENERICNI_U_TEKSTU.has(naziv)) return;
    if (new RegExp(` ${esc(korijen(naziv))}`).test(n)) nadjeni.add(kljuc);
  };
  for (const kljuc of Object.keys(kvartovi)) dijeloviKljuca(kljuc).forEach((d) => trazi(d, kljuc));
  for (const [alias, kljuc] of Object.entries(ALIASI_KVARTOVA[grad] || {})) if (kvartovi[kljuc]) trazi(alias, kljuc);
  return nadjeni.size === 1 ? [...nadjeni][0] : null;
}

// ── Zagreb: medijan po katastarskim općinama (k.o.) umjesto gradskog medijana ──
// MPGI/EIZ objavljuje medijane po k.o. Kvart se na k.o. preslikava SAMO pouzdanim mapiranjem; inače se ne pogađa
// nego se koristi gradski medijan i to se označava. Prepoznavanje tolerira dijakritike, velika/mala slova i
// sitne tipfelere, ali nikad ne spaja dva različita naziva.
export const MIN_PRODAJA_KO = 30; // k.o. s manje prodaja nema dovoljno pouzdan medijan → gradski medijan

// Nazivi kvarta koji NISU jedna k.o. (isti naziv ima više k.o. ili kvart obuhvaća više njih): ne mapiraju se.
const KO_DVOSMISLENA = ['Centar', 'Klara', 'Trešnjevka', 'Stenjevec', 'Vrapče', 'Dubrava', 'Sesvete'];
// Kvart čiji se naziv razlikuje od k.o., a mapiranje je potvrđeno izvorom (normalizirani naziv → k.o.).
// Središće: službeni dokumenti Grada Zagreba navode čestice Središća u k.o. Zaprudski otok
// (web.zagreb.hr: zapisnik 47. sjednice VGČ Novi Zagreb - istok; projekt "Središće", k.č. 374/1, k.o. Zaprudski otok).
const KO_ALIASI = { Zagreb: { sredisce: 'Zaprudski Otok' } };

const razmakUnosa = (a, b) => {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
};

// Rječnik normalizirani naziv → k.o. (string) ili null (dvosmisleno). Samo za Zagreb.
export function rjecnikKo(grad, baza = TRZISTE) {
  const opcine = (baza.realizirane.zagreb_katastarske_opcine || {}).opcine || {};
  if (grad !== 'Zagreb') return new Map();
  const r = new Map();
  for (const ime of Object.keys(opcine)) r.set(normaliziraj(ime), KO_DVOSMISLENA.includes(ime) ? null : ime);
  for (const [alias, ko] of Object.entries(KO_ALIASI[grad] || {})) if (opcine[ko]) r.set(alias, ko);
  return r;
}

// Najveći dopušteni razmak (tipfeleri) po duljini naziva; kratki nazivi samo točno.
const dopustenRazmak = (n) => (n < 5 ? 0 : n < 10 ? 1 : 2);

// → { status: 'ko', ko } | { status: 'dvosmisleno' } | { status: 'nepoznat' } | null (kvart nije upisan)
export function nadjiKo(grad, unos, baza = TRZISTE) {
  const n = normaliziraj(unos);
  if (!n) return null;
  const rjecnik = rjecnikKo(grad, baza);
  let kljuc = rjecnik.has(n) ? n : null;
  if (kljuc === null) {
    // tipfeleri: točno jedan najbliži naziv unutar dopuštenog razmaka; izjednačenje dvaju naziva → nepoznat
    let najbolji = Infinity;
    let pogodci = [];
    for (const k of rjecnik.keys()) {
      const d = razmakUnosa(n, k);
      if (d > dopustenRazmak(Math.min(n.length, k.length))) continue;
      if (d < najbolji) { najbolji = d; pogodci = [k]; } else if (d === najbolji) pogodci.push(k);
    }
    if (pogodci.length === 1) kljuc = pogodci[0];
  }
  if (kljuc === null) return { status: 'nepoznat' };
  const ko = rjecnik.get(kljuc);
  return ko === null ? { status: 'dvosmisleno' } : { status: 'ko', ko };
}

// Svi normalizirani nazivi kojima se kvart mapira na istu k.o. (njezin naziv i aliasi): za prepoznavanje razloga korekcije lokacije.
export const imenaZaKo = (grad, ko, baza = TRZISTE) => [...rjecnikKo(grad, baza)].filter(([, v]) => v === ko).map(([k]) => k);

const kratkiUnos = (s) => String(s).trim().slice(0, 25);
// Napomena (kratka, ulazi u obrazloženje) kad se umjesto k.o. koristi gradski medijan.
export function napomenaKvarta(ref) {
  if (!ref || !ref.kvartStatus || ref.kvartStatus === 'ko') return null;
  const u = `„${kratkiUnos(ref.kvartUnos)}”`;
  if (ref.kvartStatus === 'dvosmisleno') return `Kvart ${u} obuhvaća više k.o.: gradski medijan.`;
  if (ref.kvartStatus === 'malo_prodaja') return `K.o. ${ref.kvartKo} ima manje od ${MIN_PRODAJA_KO} prodaja: gradski medijan.`;
  return `Kvart ${u} nije mapiran na k.o.: gradski medijan.`;
}

// Naziv polazišta za obrazloženje: "k.o. Zaprudski Otok" ili naziv grada.
export const nazivPolazista = (ref) => (ref && ref.ko ? `k.o. ${ref.ko}` : ref && ref.grad) || null;

// Usklađeni medijan = medijan 2025. × (indeks zadnjeg razdoblja / indeks prosjeka 2025.), po DZS regiji grada.
// Vraća null ako grad nema razvrstanu regiju ili nedostaje indeks (tada nema ni reference).
export function uskladiMedijan(medijan, regija, indeks) {
  const razdoblje = indeks && indeks.razdoblja && indeks.razdoblja[indeks.koristi];
  const zadnji = razdoblje && razdoblje.regije && razdoblje.regije[regija];
  const osnova = indeks && indeks.prosjek_2025 && indeks.prosjek_2025[regija];
  if (!regija || !(zadnji > 0) || !(osnova > 0) || !(medijan > 0)) return null;
  const faktor = zadnji / osnova;
  return { faktor, uskladeno_eur_m2: Math.round(medijan * faktor), razdoblje: razdoblje.naziv, privremeno: !!razdoblje.privremeno };
}

const trazenaZapis = (z) => (z && typeof z.prosjek_eur_m2 === 'number'
  ? { prosjek_eur_m2: z.prosjek_eur_m2, izvor: z.izvor, datum: z.datum } : null);

// Odredi lokaciju i referencu. Polja forme imaju prednost: ako je grad upisan, a nije u bazi, ne traži se u tekstu
// (korisnik je naveo drugi grad). Bez upisanog grada traži se u tekstu oglasa.
// Vraća { grad, kvart, razina: 'kvart' | 'ko' | 'grad' | null, realizirana, trazenaGrad, trazenaKvart, ko, kvartStatus, kvartKo, kvartUnos }.
// razina 'ko': realizirana je medijan k.o. (ko = naziv); kvartStatus objašnjava zašto je, ako je, korišten gradski medijan.
// razina 'kvart' postoji samo kad su dostupne tražene cijene za zonu; realizirani medijan je na razini k.o. (razina 'ko') ili grada.
export function odrediReferencu(podaci, oglasTekst, baza = TRZISTE) {
  const prazno = { grad: null, kvart: null, razina: null, realizirana: null, trazenaGrad: null, trazenaKvart: null, ko: null, kvartStatus: null, kvartKo: null, kvartUnos: null };
  const p = podaci || {};
  const grad = p.grad ? nadjiGradPoImenu(p.grad, baza) : gradIzTeksta(oglasTekst, baza);
  if (!grad) return prazno;

  const z = baza.realizirane.gradovi[grad];
  const uskGrad = uskladiMedijan(z.medijan_eur_m2, z.regija_dzs, baza.indeks);
  let realizirana = uskGrad
    ? { godina: baza.realizirane.godina, medijan_eur_m2: z.medijan_eur_m2, broj_prodaja: z.broj_prodaja, regija_dzs: z.regija_dzs, ...uskGrad }
    : null;

  // Kvart iz forme → k.o. (samo uz dovoljno prodaja); inače gradski medijan uz oznaku zašto.
  let ko = null;
  let kvartStatus = null;
  let kvartKo = null;
  const kvartUnos = p.kvart ? String(p.kvart) : null;
  const rKo = kvartUnos ? nadjiKo(grad, kvartUnos, baza) : null;
  if (rKo) {
    kvartStatus = rKo.status;
    if (rKo.status === 'ko') {
      kvartKo = rKo.ko;
      const o = baza.realizirane.zagreb_katastarske_opcine.opcine[rKo.ko];
      const uskKo = uskladiMedijan(o.medijan_eur_m2, z.regija_dzs, baza.indeks);
      if (o.broj_prodaja >= MIN_PRODAJA_KO && uskKo) {
        ko = rKo.ko;
        realizirana = { godina: baza.realizirane.godina, medijan_eur_m2: o.medijan_eur_m2, broj_prodaja: o.broj_prodaja, regija_dzs: z.regija_dzs, ...uskKo };
      } else {
        kvartStatus = 'malo_prodaja';
      }
    }
  }

  const tg = ((baza.trazena || {}).gradovi || {})[grad];
  const trazenaGrad = trazenaZapis(tg);
  const kvart = tg ? (p.kvart ? nadjiKvartPoImenu(grad, p.kvart, baza) : kvartIzTeksta(grad, oglasTekst, baza)) : null;
  const trazenaKvart = kvart ? trazenaZapis(tg.kvartovi[kvart]) : null;

  const razina = trazenaKvart ? 'kvart' : ko ? 'ko' : (realizirana || trazenaGrad) ? 'grad' : null;
  const oznake = { ko, kvartStatus, kvartKo, kvartUnos };
  return razina ? { grad, kvart: trazenaKvart ? kvart : null, razina, realizirana, trazenaGrad, trazenaKvart, ...oznake } : { ...prazno, grad, ...oznake };
}

const izvorNaziv = (url) => String(url).replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
const NF = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 4, useGrouping: false });

// Blok za poruku poziva 1. Cijena oglasa nikad nije u njemu — samo tržišni podaci.
export function tekstReference(ref) {
  if (!ref || !ref.razina) {
    return 'Referentni tržišni podaci: NEMA podataka za ovu lokaciju (grad nije prepoznat ili nije u bazi). ' +
      'Pouzdanost procjene mora biti "niska", a raspon širi.';
  }
  const dijelovi = ['Referentni tržišni podaci:'];
  const r = ref.realizirana;
  if (r && ref.ko) {
    dijelovi.push(
      `REALIZIRANE cijene (transakcijske, ne tražene) — katastarska općina ${ref.ko} (Grad ${ref.grad}), kvart "${ref.kvartUnos}": medijan stvarno plaćenih cijena stanova/apartmana u ${r.godina}. ` +
      `iznosi ${r.medijan_eur_m2} €/m² (${r.broj_prodaja} prodaja; svi stanovi svih starosti i stanja). ` +
      `Usklađen DZS indeksom cijena stambenih objekata (regija ${r.regija_dzs}, faktor ${NF.format(r.faktor)}) na ${r.razdoblje}${r.privremeno ? ' (privremeni podaci)' : ''}: ` +
      `${r.uskladeno_eur_m2} €/m². To je POLAZIŠTE i ono već sadrži učinak lokacije/kvarta. Izvori: ${IZVORI_NAZIV}.`);
  } else if (r) {
    dijelovi.push(
      `REALIZIRANE cijene (transakcijske, ne tražene) — Grad ${ref.grad}: medijan stvarno plaćenih cijena stanova/apartmana u ${r.godina}. ` +
      `iznosi ${r.medijan_eur_m2} €/m² (${r.broj_prodaja} prodaja; svi stanovi svih starosti i stanja, cijeli grad bez razlike po kvartovima). ` +
      `Usklađen DZS indeksom cijena stambenih objekata (regija ${r.regija_dzs}, faktor ${NF.format(r.faktor)}) na ${r.razdoblje}${r.privremeno ? ' (privremeni podaci)' : ''}: ` +
      `${r.uskladeno_eur_m2} €/m². Izvori: ${IZVORI_NAZIV}.`);
    const nap = napomenaKvarta(ref);
    if (nap) dijelovi.push(`Napomena: ${nap}`);
  }
  const tr = (naziv, t) => `- ${naziv}: prosjek tražene cijene ${t.prosjek_eur_m2} €/m² (${izvorNaziv(t.izvor)}, ${t.datum})`;
  if (ref.trazenaGrad || ref.trazenaKvart) {
    dijelovi.push('TRAŽENE (oglasne) cijene, ne transakcijske:');
    if (ref.trazenaKvart) dijelovi.push(tr(`Kvart ${ref.kvart} (${ref.grad})`, ref.trazenaKvart));
    if (ref.trazenaGrad) dijelovi.push(tr(`Grad ${ref.grad}`, ref.trazenaGrad));
  }
  return dijelovi.join('\n');
}

const REDOSLIJED = ['niska', 'srednja', 'visoka'];
const NAJVISE = { kvart: 'visoka', ko: 'srednja', grad: 'srednja' };

// "visoka" samo uz tražene cijene za kvart; k.o. ili grad → najviše "srednja" (medijan k.o. i dalje obuhvaća sve starosti i stanja); bez reference → "niska".
export const granicaPouzdanosti = (ref) => NAJVISE[ref && ref.razina] || 'niska';

export function ogranicitiPouzdanost(procjena, ref) {
  const granica = granicaPouzdanosti(ref);
  const f = procjena.fer_vrijednost;
  if (REDOSLIJED.indexOf(f.pouzdanost) <= REDOSLIJED.indexOf(granica)) return procjena;
  return { ...procjena, fer_vrijednost: { ...f, pouzdanost: granica } };
}

// Za najam nema dopuštenog izvora po m², pa je procjena najma uvijek AI procjena: pouzdanost najviše "srednja"
// i nikad viša od pouzdanosti fer vrijednosti. Postavlja je kod, ne model.
export function ogranicitiNajam(procjena) {
  const granica = REDOSLIJED[Math.min(REDOSLIJED.indexOf('srednja'), REDOSLIJED.indexOf(procjena.fer_vrijednost.pouzdanost))];
  return { ...procjena, najam: { ...procjena.najam, pouzdanost: granica } };
}

// Što se šalje pregledniku za napomenu pod fer vrijednošću; null ako reference nema.
export function referencaZaKlijenta(ref) {
  if (!ref || !ref.razina) return null;
  const r = ref.realizirana;
  const t = ref.trazenaKvart || ref.trazenaGrad;
  return {
    razina: ref.razina,
    naziv: ref.grad,
    ...(ref.ko ? { ko: ref.ko } : {}),
    ...(napomenaKvarta(ref) ? { napomena_kvart: napomenaKvarta(ref) } : {}),
    realizirana: r && {
      godina: r.godina, medijan_eur_m2: r.medijan_eur_m2, broj_prodaja: r.broj_prodaja,
      uskladeno_eur_m2: r.uskladeno_eur_m2, indeks_razdoblje: r.razdoblje, privremeno: r.privremeno,
    },
    trazena: t && { naziv: ref.trazenaKvart ? `${ref.kvart} (${ref.grad})` : ref.grad, prosjek_eur_m2: t.prosjek_eur_m2, izvor: t.izvor, datum: t.datum },
  };
}
