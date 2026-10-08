// PropIQ — strukturirani izvještaj analize: shema (tool use), validacija odgovora modela
// i izračuni koji se rade u kodu (nikad u modelu). Koristi ga netlify/functions/analiza.mjs.

import izracuni from '../../public/assets/js/izracuni.js';

const PREPORUKE = ['povoljno', 'pregovaraj', 'oprez'];
const POUZDANOSTI = ['niska', 'srednja', 'visoka'];
const RAZINE = ['nizak', 'srednji', 'visok'];

// Ocjena mora odgovarati preporuci (cijele ocjene 1–10).
export const OCJENE_PO_PREPORUCI = { povoljno: [7, 10], pregovaraj: [4, 6], oprez: [1, 3] };

// Pretpostavke neto prinosa. Vraćaju se klijentu u izracuni.pretpostavke.
export const { TROSKOVI_NAJMA, POREZ_NA_NAJAM, POREZ_NA_PROMET } = izracuni;

// Tvrdo ograničenje obrazloženja procjene: dulji tekst kod skraćuje (vidi skratiObrazlozenje).
export const MAX_OBRAZLOZENJE = 350;

const brojIliNull = { type: ['number', 'null'] };
const tekst = { type: 'string' };
const popis = (max, opis) => ({ type: 'array', items: tekst, maxItems: max, ...(opis ? { description: opis } : {}) });

export const TOOL_NAME = 'izvjestaj';
export const TOOL_PROCJENA_NAME = 'procjena';

const FER_SHEMA = {
  type: 'object', additionalProperties: false,
  required: ['min_eur', 'max_eur', 'pouzdanost', 'obrazlozenje'],
  properties: {
    min_eur: { type: ['number', 'null'], description: 'Donja granica UKUPNE vrijednosti nekretnine u eurima (ne €/m²).' },
    max_eur: { type: ['number', 'null'], description: 'Gornja granica UKUPNE vrijednosti nekretnine u eurima (ne €/m²).' },
    pouzdanost: { type: 'string', enum: POUZDANOSTI },
    obrazlozenje: { type: 'string', maxLength: MAX_OBRAZLOZENJE, description: `Najviše 2 kratke rečenice (do ${MAX_OBRAZLOZENJE} znakova): referentni €/m² i primijenjene korekcije.` },
  },
};
const NAJAM_SHEMA = {
  type: 'object', additionalProperties: false, required: ['dugorocni_mj_eur', 'turisticki_godisnje_eur'],
  properties: { dugorocni_mj_eur: brojIliNull, turisticki_godisnje_eur: brojIliNull },
};

// Poziv 1 (slijepa procjena) kad POSTOJI usklađeni medijan: model vraća samo korekcije u postocima i pouzdanost;
// raspon (€/m² i ukupni €) i tekst obrazloženja računa kod (izracunajFer). Model NE vraća min_eur/max_eur.
export const { FER } = izracuni;
export const TOOL_PROCJENA = {
  name: TOOL_PROCJENA_NAME,
  description: 'Korekcije usklađenog medijana za ovu nekretninu, pouzdanost i najam. Raspon vrijednosti računa sustav.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['korekcije', 'pouzdanost', 'povrsina_m2', 'najam'],
    properties: {
      korekcije: {
        type: 'array', maxItems: FER.MAX_STAVKI,
        description: `Najviše ${FER.MAX_STAVKI} korekcija usklađenog medijana (€/m²) za ovu nekretninu; svaka je zaseban čimbenik.`,
        items: {
          type: 'object', additionalProperties: false, required: ['razlog', 'postotak'],
          properties: {
            razlog: { type: 'string', maxLength: FER.MAX_RAZLOG, description: `Kratko (do ${FER.MAX_RAZLOG} znakova), npr. "renovirano", "bez lifta", "parking".` },
            postotak: { type: 'integer', minimum: -FER.MAX_KOREKCIJA, maximum: FER.MAX_KOREKCIJA, description: `Cijeli broj postotaka, −${FER.MAX_KOREKCIJA}…+${FER.MAX_KOREKCIJA}; negativan snižava, pozitivan povećava €/m².` },
          },
        },
      },
      pouzdanost: { type: 'string', enum: POUZDANOSTI },
      povrsina_m2: { type: ['number', 'null'], description: 'Stambena površina u m² prepisana iz oglasa/podataka; null ako nije navedena. Ne računaj ništa.' },
      najam: NAJAM_SHEMA,
    },
  },
};

// Poziv 1 kad NEMA medijana za grad: ostaje raniji oblik (model sam daje ukupni raspon u eurima), jasno označen
// zastavicom bez_reference u rezultatu.
export const TOOL_PROCJENA_BEZ_REFERENCE = {
  name: TOOL_PROCJENA_NAME,
  description: 'Procjena tržišne vrijednosti i najma nekretnine isključivo iz njezinih karakteristika i lokacije.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['fer_vrijednost', 'najam'],
    properties: { fer_vrijednost: FER_SHEMA, najam: NAJAM_SHEMA },
  },
};

export const TOOL = {
  name: TOOL_NAME,
  description: 'Strukturirani izvještaj analize oglasa za nekretninu. Jedini dopušteni oblik odgovora.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['naslov', 'lokacija', 'povrsina_m2', 'cijena_eur', 'preporuka', 'ocjena', 'sazetak',
      'prednosti', 'rizici', 'pregovaranje', 'nedostajuci_podaci'],
    properties: {
      naslov: { type: 'string', maxLength: 90, description: 'Kratak opis (tip, mjesto, površina), do 90 znakova.' },
      lokacija: {
        type: 'object', additionalProperties: false, required: ['grad', 'kvart'],
        properties: { grad: { type: ['string', 'null'] }, kvart: { type: ['string', 'null'] } },
      },
      povrsina_m2: brojIliNull,
      cijena_eur: brojIliNull,
      // null samo kad cijena_eur nedostaje (bez tražene cijene nema investicijske ocjene)
      preporuka: { type: ['string', 'null'], enum: [...PREPORUKE, null] },
      ocjena: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
      sazetak: { type: 'string', description: 'Najviše 2 rečenice (do ~250 znakova).' },
      prednosti: popis(4, 'Do 4 stavke, svaka kratka fraza (do ~80 znakova).'),
      rizici: {
        type: 'array', maxItems: 4,
        items: {
          type: 'object', additionalProperties: false, required: ['naslov', 'opis', 'razina'],
          properties: {
            naslov: { type: 'string', description: 'Do ~6 riječi.' },
            opis: { type: 'string', description: 'Najviše 2 kratke rečenice (do ~200 znakova).' },
            razina: { type: 'string', enum: RAZINE },
          },
        },
      },
      pregovaranje: {
        type: 'object', additionalProperties: false, required: ['aduti', 'pitanja_prodavatelju'],
        properties: {
          aduti: popis(3, 'Do 3 argumenta, svaki jedna kratka rečenica (do ~100 znakova).'),
          pitanja_prodavatelju: popis(4, 'Do 4 pitanja, svako kratko (do ~100 znakova).'),
        },
      },
      nedostajuci_podaci: popis(5, 'Do 5 stavki, svaka kratka fraza (do ~60 znakova).'),
    },
  },
};

// ── datum i starost (u kodu, ne u modelu: model misli da je još 2025.) ──

// Današnji datum u Europe/Zagreb kao { godina, datum: 'YYYY-MM-DD' }.
export function danasZagreb(sada = new Date()) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).format(sada);
  return { godina: Number(d.slice(0, 4)), datum: d };
}

const prije = (n) => {
  if (n === 0) return 'ove godine';
  const z = n % 10, st = n % 100;
  return `prije ${n} ${z === 1 && st !== 11 ? 'godinu' : z >= 2 && z <= 4 && (st < 12 || st > 14) ? 'godine' : 'godina'}`;
};

// Godina renovacije iz teksta oglasa ("renovirano 2015.", "adaptiran 2019. godine"). Samo izričiti navodi uz
// ključnu riječ; ako ih ima više, uzima se najnovija. Nema pogađanja — bez navoda vraća null.
export function godinaRenovacije(oglas, trenutnaGodina) {
  if (typeof oglas !== 'string') return null;
  const re = /(?:renovir|obnovljen|adaptir|preuređen|sanir|rekonstru)\w*[^.\d\n]{0,40}?((?:19|20)\d{2})\b/gi;
  let najnovija = null;
  for (const m of oglas.matchAll(re)) {
    const g = Number(m[1]);
    if (g <= trenutnaGodina && (najnovija === null || g > najnovija)) najnovija = g;
  }
  return najnovija;
}

// Činjenice o vremenu za prompt: datum i gotovi brojevi (starost zgrade, vrijeme od renovacije).
// godinaGradnje: iz forme (potvrđeno) ili null; oglas: tekst za izričit navod o renovaciji.
export function vremenskeCinjenice({ godinaGradnje = null, oglas = '', sada = new Date() } = {}) {
  const { godina, datum } = danasZagreb(sada);
  const redovi = [`Današnji datum: ${datum} (godina ${godina}). Sve starosti računaj od ove godine.`];
  if (Number.isInteger(godinaGradnje) && godinaGradnje <= godina) {
    redovi.push(`Starost zgrade: ${godina - godinaGradnje} godina (izgrađena ${godinaGradnje}.).`);
  }
  const reno = godinaRenovacije(oglas, godina);
  if (reno !== null) redovi.push(`Renovacija prema oglasu: ${reno}. (${prije(godina - reno)}).`);
  return redovi.join('\n');
}

// ── sažetak: postotke i razlike u eurima računa kod, model ih samo prepisuje ──

const eurHr = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const postoHr = (p) => String(p).replace('.', ',');

// Položaj tražene cijene prema fer rasponu: razlika je do najbliže granice raspona (u € i u % te granice).
// null ako nema cijene ili raspona.
export function cinjeniceSazetka(cijena, fer) {
  if (!(typeof cijena === 'number' && cijena > 0) || !fer || typeof fer.min_eur !== 'number' || typeof fer.max_eur !== 'number') return null;
  if (cijena > fer.max_eur) return { polozaj: 'iznad', razlika_eur: Math.round(cijena - fer.max_eur), posto: Math.round(((cijena - fer.max_eur) / fer.max_eur) * 1000) / 10 };
  if (cijena < fer.min_eur) return { polozaj: 'ispod', razlika_eur: Math.round(fer.min_eur - cijena), posto: Math.round(((fer.min_eur - cijena) / fer.min_eur) * 1000) / 10 };
  return { polozaj: 'unutar', razlika_eur: 0, posto: 0 };
}

function ponudaRedak(cilj) {
  if (!cilj) return '';
  return cilj.napomena
    ? `- Ciljana ponuda: nema pregovora, ${cilj.napomena} (tražena cijena ${eurHr(cilj.ponuda_eur)} €); ne predlaži nižu ponudu.\n`
    : `- Ciljana ponuda (izračunao sustav): ${eurHr(cilj.ponuda_eur)} €; smiješ je navesti u sažetku i adutima, ali samo ovaj iznos.\n`;
}

// Blok za poruku modela: gotovi brojevi za sažetak. cijenaZnana: cijena je potvrđena kodom (upisana u formu);
// inače je model tek izvlači iz oglasa, pa brojke razlike ne dobiva i ne smije ih navoditi.
export function tekstCinjenicaSazetka(cijena, fer, cijenaZnana) {
  const pravilo = 'Sažetak: ne računaj postotke ni razlike u eurima; navedi isključivo brojke iz ovog bloka (prepiši ih točno) i nikakve druge postotke ni iznose.';
  const c = cijenaZnana ? cinjeniceSazetka(cijena, fer) : null;
  if (!c) return `Gotovi brojevi za sažetak:\n- Razlika cijene i raspona nije izračunata: u sažetku NE navodi postotke ni razlike u eurima prema rasponu, samo opisno (ispod/unutar/iznad raspona).\n${pravilo}`;
  const cilj = izracuni.izracunajPonudu(cijena, fer.min_eur, fer.max_eur);
  const razlika = c.polozaj === 'unutar' ? 'cijena je unutar raspona, nema razlike (ne navodi postotak ni razliku u eurima)'
    : `${eurHr(c.razlika_eur)} € (${postoHr(c.posto)} % ${c.polozaj === 'iznad' ? 'iznad gornje' : 'ispod donje'} granice raspona)`;
  return `Gotovi brojevi za sažetak (izračunao sustav):\n- Tražena cijena ${eurHr(cijena)} €, fer raspon ${eurHr(fer.min_eur)}–${eurHr(fer.max_eur)} €.\n- Položaj: ${c.polozaj} raspona.\n- Razlika: ${razlika}.\n${ponudaRedak(cilj)}${pravilo}`;
}

const BROJ_U_TEKSTU = String.raw`\d{1,3}(?:[.  ]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;
// broj + (tisuća)? + jedinica: % / posto, ili € / eur(a|o) koji NIJE €/m², €/mj, €/god
const RE_BROJ_JEDINICA = new RegExp(`(${BROJ_U_TEKSTU})\\s*(tisu[ćc]a|tis\\.)?\\s*(%|posto(?![\\p{L}])|€(?!\\s*/)|eur(?:a|o)?(?![\\p{L}/]))`, 'giu');

function brojIzTeksta(t) {
  const s = t.replace(/[  ]/g, '');
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.'));
  return /^\d{1,3}(\.\d{3})+$/.test(s) ? Number(s.replace(/\./g, '')) : Number(s);
}

// Svaki postotak u sažetku mora biti izračunati postotak razlike, a svaki iznos u eurima (osim €/m², €/mj, €/god)
// cijena, granica raspona ili izračunata razlika. Vraća razlog odbijanja ili null.
export function provjeriSazetak(sazetak, cijena, fer) {
  const c = cinjeniceSazetka(cijena, fer);
  const cilj = fer ? izracuni.izracunajPonudu(cijena, fer.min_eur, fer.max_eur) : null;
  const dopustenoEur = [cijena, fer && fer.min_eur, fer && fer.max_eur, c && c.razlika_eur > 0 ? c.razlika_eur : null, cilj && cilj.ponuda_eur].filter((v) => typeof v === 'number');
  for (const m of String(sazetak).matchAll(RE_BROJ_JEDINICA)) {
    const x = brojIzTeksta(m[1]) * (m[2] ? 1000 : 1);
    if (!Number.isFinite(x)) continue;
    if (/^(%|posto)/i.test(m[3])) {
      const ok = c && c.posto > 0 && (Math.abs(x - c.posto) <= 0.051 || (Number.isInteger(x) && x === Math.round(c.posto)));
      if (!ok) return `sazetak: postotak "${m[0].trim()}" ne odgovara izračunu${c && c.posto > 0 ? ` (${postoHr(c.posto)} %)` : ' (nema razlike prema rasponu)'}`;
    } else if (!dopustenoEur.some((a) => Math.abs(x - a) <= 1)) {
      return `sazetak: iznos "${m[0].trim()}" ne odgovara izračunu`;
    }
  }
  return null;
}

// ── validacija ──

const jeObjekt = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nepraznaStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

class NevaljanOdgovor extends Error {}
const ne = (poruka) => { throw new NevaljanOdgovor(poruka); };
// Vrsta vrijednosti za poruke o greški (jeObjekt razlikuje null/popis/tekst, a typeof ne).
const vrsta = (v) => (v === null ? 'null' : Array.isArray(v) ? 'popis' : typeof v);

function broj(v, ime, { min = 0, max = 1e9, strogoPozitivan = false } = {}) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) ne(`${ime}: nije broj`);
  if (strogoPozitivan ? v <= 0 : v < min) ne(`${ime}: nedopuštena vrijednost`);
  if (v > max) ne(`${ime}: nerealno velika vrijednost`);
  return v;
}

function strNull(v, ime, max = 120) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > max) ne(`${ime}: nije tekst`);
  return v.trim() || null;
}

function popisStr(v, ime, maxStavki, maxDulj = 400) {
  if (!Array.isArray(v) || v.length > maxStavki) ne(`${ime}: nije popis (najviše ${maxStavki})`);
  return v.map((s, i) => {
    if (!nepraznaStr(s, maxDulj)) ne(`${ime}[${i}]: nije tekst`);
    return s.trim();
  });
}

// Model ponekad ugniježđeni objekt vrati kao JSON-kodiran tekst ("{\"min_eur\":...}"). To je samo krivi oblik
// istog sadržaja: raspakira se, a svaka pravila ispod vrijede nepromijenjena. Sve ostalo (tekst koji nije objekt) pada.
function raspakiraj(v) {
  if (typeof v !== 'string') return v;
  try {
    const o = JSON.parse(v);
    return jeObjekt(o) ? o : v;
  } catch {
    return v;
  }
}

// Obrazloženje je tvrdo ograničeno na MAX_OBRAZLOZENJE znakova: dulje se skraćuje (ne odbija, da se ne troši
// ponovni poziv) — na kraju zadnje cijele rečenice koja stane, a ako je nema, na granici riječi uz "…".
export function skratiObrazlozenje(t, max = MAX_OBRAZLOZENJE) {
  t = t.trim();
  if (t.length <= max) return t;
  const prozor = t.slice(0, max);
  const kraj = Math.max(prozor.lastIndexOf('. '), prozor.lastIndexOf('! '), prozor.lastIndexOf('? '));
  if (kraj >= max * 0.4) return prozor.slice(0, kraj + 1);
  const razmak = prozor.lastIndexOf(' ', max - 1);
  return `${prozor.slice(0, razmak > 0 ? razmak : max - 1).replace(/[\s,;:–-]+$/, '')}…`;
}

function validirajFer(f) {
  f = raspakiraj(f);
  if (!jeObjekt(f)) ne(`fer_vrijednost: očekivan objekt, stigao ${vrsta(f)}`);
  if (!POUZDANOSTI.includes(f.pouzdanost)) ne(`fer_vrijednost.pouzdanost: nedopuštena vrijednost (${vrsta(f.pouzdanost)})`);
  // Raspon izračunat iz korekcija: sve se ponovno računa iz ulaza (medijan, korekcije, pouzdanost, površina),
  // pa min_eur/max_eur/obrazloženje uvijek odgovaraju izračunu, što god je u objektu pisalo.
  if (f.izracun !== undefined && f.izracun !== null) {
    const iz = f.izracun;
    if (!jeObjekt(iz)) ne('fer_vrijednost.izracun: očekivan objekt');
    const r = izracuni.izracunajFer({ medijan_eur_m2: iz.polaziste_m2, korekcije: iz.korekcije, pouzdanost: f.pouzdanost, povrsina_m2: iz.povrsina_m2, naziv: typeof iz.naziv === 'string' ? iz.naziv : null, napomena: iz.napomena });
    if (!r) ne('fer_vrijednost.izracun: neispravni ulazi');
    return { min_eur: r.min_eur, max_eur: r.max_eur, pouzdanost: f.pouzdanost, obrazlozenje: izracuni.obrazlozenjeFer(r.izracun), izracun: r.izracun };
  }
  if (!nepraznaStr(f.obrazlozenje, 900)) ne(`fer_vrijednost.obrazlozenje: mora biti neprazan tekst do 900 znakova (${vrsta(f.obrazlozenje)}${typeof f.obrazlozenje === 'string' ? `, ${f.obrazlozenje.length} znakova` : ''})`);
  const min = broj(f.min_eur, 'fer_vrijednost.min_eur', { strogoPozitivan: true, max: 1e8 });
  const max = broj(f.max_eur, 'fer_vrijednost.max_eur', { strogoPozitivan: true, max: 1e8 });
  if ((min === null) !== (max === null)) ne('fer_vrijednost: raspon mora imati oba kraja ili nijedan');
  if (min !== null && min > max) ne('fer_vrijednost: min > max');
  return { min_eur: min, max_eur: max, pouzdanost: f.pouzdanost, obrazlozenje: skratiObrazlozenje(f.obrazlozenje), ...(f.bez_reference === true ? { bez_reference: true } : {}) };
}

function validirajNajam(n) {
  n = raspakiraj(n);
  if (!jeObjekt(n)) ne(`najam: očekivan objekt, stigao ${vrsta(n)}`);
  const najam = {
    dugorocni_mj_eur: broj(n.dugorocni_mj_eur, 'najam.dugorocni_mj_eur', { strogoPozitivan: true, max: 1e6 }),
    turisticki_godisnje_eur: broj(n.turisticki_godisnje_eur, 'najam.turisticki_godisnje_eur', { strogoPozitivan: true, max: 1e7 }),
  };
  // Pouzdanost najma ne traži se od modela (nije u shemi): postavlja je kod (netlify/lib/trziste.mjs) i ovdje samo prolazi.
  if (POUZDANOSTI.includes(n.pouzdanost)) najam.pouzdanost = n.pouzdanost;
  return najam;
}

// Vraća { ok: true, analiza } (očišćena kopija) ili { ok: false, razlog }.
export function validirajAnalizu(ulaz) {
  try {
    if (!jeObjekt(ulaz)) ne('korijen nije objekt');
    const u = ulaz;

    if (!nepraznaStr(u.naslov, 160)) ne('naslov');
    if (!jeObjekt(u.lokacija)) ne('lokacija');
    const cijena = broj(u.cijena_eur, 'cijena_eur', { strogoPozitivan: true, max: 1e9 });
    // Bez cijene nema investicijske ocjene: preporuka i ocjena su null (što god model vratio).
    // S cijenom su obje obavezne i međusobno konzistentne.
    let preporuka = null;
    let ocjena = null;
    if (cijena !== null) {
      if (!PREPORUKE.includes(u.preporuka)) ne('preporuka');
      if (!Number.isInteger(u.ocjena) || u.ocjena < 1 || u.ocjena > 10) ne('ocjena');
      const [oMin, oMax] = OCJENE_PO_PREPORUCI[u.preporuka];
      if (u.ocjena < oMin || u.ocjena > oMax) ne(`ocjena ${u.ocjena} nije konzistentna s preporukom ${u.preporuka}`);
      preporuka = u.preporuka;
      ocjena = u.ocjena;
    }
    if (!nepraznaStr(u.sazetak, 900)) ne('sazetak');

    const fer = validirajFer(u.fer_vrijednost);
    const krivSazetak = provjeriSazetak(u.sazetak, cijena, fer);
    if (krivSazetak) ne(krivSazetak);

    const najam = validirajNajam(u.najam);
    if (!jeObjekt(u.pregovaranje)) ne('pregovaranje');
    if (!Array.isArray(u.rizici) || u.rizici.length > 6) ne('rizici');

    const analiza = {
      naslov: u.naslov.trim(),
      lokacija: { grad: strNull(u.lokacija.grad, 'lokacija.grad'), kvart: strNull(u.lokacija.kvart, 'lokacija.kvart') },
      povrsina_m2: broj(u.povrsina_m2, 'povrsina_m2', { strogoPozitivan: true, max: 100000 }),
      cijena_eur: cijena,
      preporuka,
      ocjena,
      sazetak: u.sazetak.trim(),
      fer_vrijednost: fer,
      najam,
      prednosti: popisStr(u.prednosti, 'prednosti', 6),
      rizici: u.rizici.map((r, i) => {
        if (!jeObjekt(r) || !nepraznaStr(r.naslov, 160) || !nepraznaStr(r.opis, 600) || !RAZINE.includes(r.razina)) ne(`rizici[${i}]`);
        return { naslov: r.naslov.trim(), opis: r.opis.trim(), razina: r.razina };
      }),
      pregovaranje: {
        aduti: popisStr(u.pregovaranje.aduti, 'pregovaranje.aduti', 5),
        pitanja_prodavatelju: popisStr(u.pregovaranje.pitanja_prodavatelju, 'pregovaranje.pitanja_prodavatelju', 6),
      },
      nedostajuci_podaci: popisStr(u.nedostajuci_podaci, 'nedostajuci_podaci', 8),
    };
    return { ok: true, analiza };
  } catch (err) {
    if (err instanceof NevaljanOdgovor) return { ok: false, razlog: err.message };
    throw err;
  }
}

// Rezultat poziva 1 (slijepa procjena): { ok: true, procjena: { fer_vrijednost, najam } } ili { ok: false, razlog }.
// kontekst.medijan_eur_m2 (usklađeni medijan grada): ako postoji, model je vratio korekcije i raspon računa kod;
// ako ne, model je sam dao ukupni raspon (raniji oblik) i rezultat se označava bez_reference.
// kontekst.povrsina_m2: površina iz forme (ima prednost pred onom koju je model prepisao iz oglasa).
// kontekst.najvisaPouzdanost: gornja granica pouzdanosti prema referenci (utječe na širinu raspona).
// kontekst.bezLokacije (polazište je medijan k.o.): korekcije za lokaciju/kvart odbacuju se u kodu (rezultat.odbaceno);
// kontekst.lokacijaRijeci: imena kvarta/k.o./grada čije spominjanje u razlogu znači korekciju lokacije.
// kontekst.napomena: zašto nije korišten medijan k.o. (ulazi u obrazloženje).
export function parsirajIValidirajProcjenu(jsonTekst, kontekst = {}) {
  let obj;
  try {
    obj = JSON.parse(jsonTekst);
  } catch {
    return { ok: false, razlog: 'JSON nije valjan (moguće odrezan)' };
  }
  try {
    if (!jeObjekt(obj)) ne('korijen nije objekt');
    const najam = validirajNajam(obj.najam);
    if (!(kontekst.medijan_eur_m2 > 0)) {
      return { ok: true, procjena: { fer_vrijednost: { ...validirajFer(obj.fer_vrijednost), bez_reference: true }, najam } };
    }
    const odbaceno = [];
    const fer = izracunajIzKorekcija(obj, kontekst, odbaceno);
    return { ok: true, procjena: { fer_vrijednost: fer, najam }, ...(odbaceno.length ? { odbaceno } : {}) };
  } catch (err) {
    // sirovo: što je model stvarno vratio (za dijagnostiku u logu, nikad klijentu).
    if (err instanceof NevaljanOdgovor) return { ok: false, razlog: err.message, sirovo: jeObjekt(obj) ? (obj.korekcije ?? obj.fer_vrijednost) : obj };
    throw err;
  }
}

// ── korekcija za lokaciju kad je polazište medijan k.o. (lokacija je već u njemu) ──
const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
// Opći izrazi lokacije: dijelovi riječi (kvart, lokacij…, mikrolokacij…) i cijele riječi (centar, zona, blizina…).
const LOKACIJA_DIO = /(kvart|lokacij|cetvrt|naselj|susjedstv|okolin|okolis|udaljen)/;
const LOKACIJA_RIJEC = /(^| )(centar|centra|centru|centrom|zona|zone|zoni|blizina|blizini|adresa|adresi|grad|gradu)( |$)/;
// razlog koji spominje lokaciju: opći izraz, ili ime kvarta/k.o./grada koje je korisnik upisao (rijeci, normalizirano).
export function jeKorekcijaLokacije(razlog, rijeci = []) {
  const n = norm(razlog);
  if (LOKACIJA_DIO.test(n) || LOKACIJA_RIJEC.test(n)) return true;
  const rijeciRazloga = n.split(' ');
  // ime lokacije: cijela riječ (ili fraza); za duža imena i padežni nastavak ("Središća", "Središću")
  return rijeci.map(norm).filter(Boolean).some((r) => (r.includes(' ')
    ? ` ${n} `.includes(` ${r} `)
    : rijeciRazloga.some((w) => w === r || (r.length >= 5 && w.startsWith(r.slice(0, -1))))));
}

function izracunajIzKorekcija(obj, { medijan_eur_m2, povrsina_m2 = null, najvisaPouzdanost = null, naziv = null, napomena = null, bezLokacije = false, lokacijaRijeci = [] }, odbaceno = []) {
  if (!POUZDANOSTI.includes(obj.pouzdanost)) ne(`pouzdanost: nedopuštena vrijednost (${vrsta(obj.pouzdanost)})`);
  let kor = obj.korekcije;
  if (typeof kor === 'string') { try { kor = JSON.parse(kor); } catch { /* ostaje tekst: pada ispod */ } }
  if (!Array.isArray(kor)) ne(`korekcije: očekivan popis, stigao ${vrsta(kor)}`);
  let ociscene = izracuni.ocistiKorekcije(kor);
  if (ociscene === null) ne('korekcije: svaka stavka mora imati razlog (tekst) i postotak (broj)');
  if (bezLokacije) {
    odbaceno.push(...ociscene.filter((k) => jeKorekcijaLokacije(k.razlog, lokacijaRijeci)));
    ociscene = ociscene.filter((k) => !jeKorekcijaLokacije(k.razlog, lokacijaRijeci));
  }
  const modelPovrsina = broj(obj.povrsina_m2 ?? null, 'povrsina_m2', { strogoPozitivan: true, max: 100000 });
  // Pouzdanost ograničena prema referenci prije računanja (širina raspona ovisi o njoj).
  const idx = (p) => POUZDANOSTI.indexOf(p);
  const pouzdanost = najvisaPouzdanost && idx(obj.pouzdanost) > idx(najvisaPouzdanost) ? najvisaPouzdanost : obj.pouzdanost;
  const r = izracuni.izracunajFer({ medijan_eur_m2, korekcije: ociscene, pouzdanost, povrsina_m2: povrsina_m2 ?? modelPovrsina, naziv, napomena });
  if (!r) ne('fer_vrijednost: izračun nije moguć');
  return { min_eur: r.min_eur, max_eur: r.max_eur, pouzdanost, obrazlozenje: izracuni.obrazlozenjeFer(r.izracun), izracun: r.izracun };
}

// Preporuku određuje kod, ne model: cijena < min → povoljno; min ≤ cijena ≤ max → pregovaraj; cijena > max → oprez.
// Ocjena ostaje od modela, ali se steže na granicu raspona te preporuke. Vrijedi samo kad postoje
// i cijena i fer raspon; inače se objekt vraća neizmijenjen (preporuka i ocjena idu kroz običnu validaciju).
export function preporukaIzRaspona(cijena, min, max) {
  return cijena < min ? 'povoljno' : cijena > max ? 'oprez' : 'pregovaraj';
}

export function primijeniPreporuku(obj) {
  const f = obj && obj.fer_vrijednost;
  const cijena = obj && obj.cijena_eur;
  if (!jeObjekt(f) || !(typeof cijena === 'number' && cijena > 0) || typeof f.min_eur !== 'number' || typeof f.max_eur !== 'number') return obj;
  const preporuka = preporukaIzRaspona(cijena, f.min_eur, f.max_eur);
  const [oMin, oMax] = OCJENE_PO_PREPORUCI[preporuka];
  const ocjena = Number.isInteger(obj.ocjena) ? Math.min(oMax, Math.max(oMin, obj.ocjena)) : obj.ocjena;
  return { ...obj, preporuka, ocjena };
}

// Parsira JSON koji je model složio (tool input) i validira ga.
// podaci: što je korisnik upisao u formu — ti podaci imaju prednost pred onim što je izvukao model.
// procjena: rezultat poziva 1; ako je zadan, fer_vrijednost i najam uvijek su iz njega (što god da je model
// vratio), a preporuka se određuje iz odnosa cijene i tog raspona.
export function parsirajIValidiraj(jsonTekst, podaci, procjena) {
  let obj;
  try {
    obj = JSON.parse(jsonTekst);
  } catch {
    return { ok: false, razlog: 'JSON nije valjan (moguće odrezan)' };
  }
  if (podaci) obj = primijeniPodatke(obj, podaci);
  if (procjena && jeObjekt(obj)) {
    obj = primijeniPreporuku({ ...obj, fer_vrijednost: procjena.fer_vrijednost, najam: procjena.najam });
  }
  return validirajAnalizu(obj);
}

// ── izračuni (u kodu, ne u modelu) ──
// Formule su u zajedničkom modulu koji koristi i preglednik (ručni unos cijene u rezultat.html).
export const { izracunaj, razloziIzracuna, parsirajCijenu, validirajPodatke, mozeAnaliza, primijeniPodatke } = izracuni;
