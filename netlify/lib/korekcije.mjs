// PropIQ — deterministične korekcije polazišta (medijana). Model iz oglasa samo izvlači ČINJENICE (lift, kat, parking...),
// a postotak korekcije za svaku činjenicu određuje kod iz fiksne tablice ispod: isti ulaz = isti rezultat.
//
// VAŽNO: postoci u TABLICA su PRAVILA PropIQ-a za kalibraciju, NE tržišni podatak (ne potječu iz MPGI-ja ni DZS-a).
// Mijenjaju se samo svjesno i uz kalibraciju na stvarnim oglasima; izvještaj ih tako i naziva ("pravila PropIQ-a").
//
// Prednost izvora činjenice: polje forme > jednoznačan podatak koji kod nađe u tekstu (lift, kat, godina gradnje) >
// činjenica koju je model izvukao UZ doslovni citat iz oglasa. Činjenica bez provjerljivog izvora je "nepoznato" i uvijek
// znači 0 %; ako se oglas sam sebi protivi ili podatak samo naslućuje ("mogućnost ugradnje lifta"), također je nepoznata.
// Za kvart/lokaciju nema činjenica ni pravila: lokacija je već u medijanu.

export const NEPOZNATO = 'nepoznato';
const KONFLIKT = Symbol('konflikt'); // oglas je dvosmislen ili protivrječan: ni kod ni model ne smiju birati

// ── tablica pravila (postotak na €/m² medijana) ──
export const TABLICA = {
  // Lift i kat (jedna stavka): bez lifta je važnije što je kat viši; lift vrijedi malo jer medijan miješa stanove s liftom i bez.
  lift_ne: { kat_4_plus: -6, kat_3: -3, kat_do_2: 0, kat_nepoznat: -2 },
  lift_da: { kat_3_plus: 2 },
  prizemlje: -3, // koristi se samo kad pravilo lifta daje 0
  // Parking: vlastito mjesto / garaža; javni ili nenaveden parking ne vrijedi ništa.
  parking: { vlastito: 3, garaza: 5 },
  // Starost zgrade: samo bonusi za novu gradnju. Starija gradnja se NE kažnjava (stare zgrade u centrima često su skuplje);
  // starost se spušta samo kroz stanje "za renovaciju".
  starost: [{ do: 5, posto: 8 }, { do: 15, posto: 3 }],
  // Stanje: ako nije 0, prebrisuje starost (obnova zamjenjuje stavku starosti).
  stanje: { obnova_do_10_god: 5, obnova_bez_godine: 2, obnova_starija: 0, djelomicno: 2, za_renovaciju: -6, useljivo: 0 },
  energetski: { povoljan: 2, nepovoljan: -2 }, // A+/A/B povoljan, E/F/G nepovoljan, C/D 0; samo uz izričit navod
  // Veličina (m²): < 30 → +5; 30–39,99 → +2; 40–80 → 0; 80,01–120 → −2; > 120 → −4.
  povrsina: [{ ispod: 30, posto: 5 }, { ispod: 40, posto: 2 }, { do: 80, posto: 0 }, { do: 120, posto: -2 }, { posto: -4 }],
  // Pogled na more samo uz izričit navod u oglasu; blizina mora bez pogleda je 0 %.
  pogled_na_more: 8,
};

// ── činjenice koje model vraća (alat "procjena"): svaka ima vrijednost i doslovni citat iz oglasa ──
const VRIJEDNOSTI = {
  lift: ['da', 'ne', NEPOZNATO],
  parking: ['vlastito', 'garaza', 'javno', NEPOZNATO],
  stanje: ['renovirano', 'djelomicno', 'useljivo', 'za_renovaciju', NEPOZNATO],
  energetski_razred: ['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G', NEPOZNATO],
  pogled_na_more: ['da', NEPOZNATO],
};
const MAX_CITAT = 80;
const cinjenicaShema = (vrijednost, opis) => ({
  type: 'object', additionalProperties: false, required: ['vrijednost', 'citat'],
  properties: {
    vrijednost: Array.isArray(vrijednost) ? { type: 'string', enum: vrijednost, description: opis } : { type: ['integer', 'null'], description: opis },
    citat: { type: 'string', maxLength: MAX_CITAT, description: `DOSLOVNI kratki citat iz teksta oglasa (do ${MAX_CITAT} znakova) koji izričito navodi tu činjenicu; prazan tekst ako je ne navodi.` },
  },
});
export const CINJENICE_SHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lift', 'kat', 'godina_gradnje', 'parking', 'stanje', 'energetski_razred', 'pogled_na_more'],
  description: 'Činjenice IZRIČITO navedene u tekstu oglasa. Što oglas ne navodi: "nepoznato" (ili null za brojeve) i prazan citat. Postotke korekcija računa sustav, ne ti.',
  properties: {
    lift: cinjenicaShema(VRIJEDNOSTI.lift, '"da"/"ne" samo ako oglas izričito kaže da zgrada ima/nema lift; inače "nepoznato".'),
    kat: cinjenicaShema(null, 'Kat stana kao broj (prizemlje = 0, "2. kat" = 2); null ako nije izričito naveden.'),
    godina_gradnje: cinjenicaShema(null, 'Godina izgradnje zgrade; null ako nije izričito navedena.'),
    parking: cinjenicaShema(VRIJEDNOSTI.parking, '"vlastito" = parkirno mjesto koje pripada stanu; "garaza" = garaža ili garažno mjesto; "javno" = javni parking ili parking u blizini; "nepoznato" ako oglas ne navodi.'),
    stanje: cinjenicaShema(VRIJEDNOSTI.stanje, '"renovirano" = cjelokupna obnova stana; "djelomicno" = obnovljen samo dio (stolarija, kupaonica, kuhinja, podovi...); "useljivo" = namješten/opremljen/useljiv (to NIJE renovirano); "za_renovaciju" = oglas kaže da treba obnovu; inače "nepoznato". Ako je godina obnove u oglasu, uključi je u citat.'),
    energetski_razred: cinjenicaShema(VRIJEDNOSTI.energetski_razred, 'Energetski razred samo ako je izričito naveden; inače "nepoznato".'),
    pogled_na_more: cinjenicaShema(VRIJEDNOSTI.pogled_na_more, '"da" samo ako oglas izričito navodi pogled na more (ne samo blizinu mora); inače "nepoznato".'),
  },
};

// ── normalizacija i provjera citata ──
// Mala slova bez dijakritika; interpunkcija se zamjenjuje razmakom ("+" ostaje zbog "A+").
export const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9+]+/g, ' ').trim();
const bezDijakritika = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

// Citat je izvor samo ako doslovno (do na velika slova, dijakritike i interpunkciju) stoji u tekstu oglasa.
export function citatUOglasu(citat, oglas) {
  const c = norm(citat);
  return c.length >= 3 && ` ${norm(oglas)} `.includes(` ${c} `);
}

// ── predekstrakcija u kodu: lift, kat, godina gradnje ──
// Vraća vrijednost kad je podatak jednoznačan, KONFLIKT kad je oglas dvosmislen/protivrječan, a undefined kad ništa
// pouzdano ne prepoznaje (tada smije odlučiti model uz citat).
const DIJELOVI = /[.!?;,\n]+/;
const ZAZIRANJE = /moguc|predvid|planir|ugradnj|izgradnj|buduc|eventualn|u pripremi|uz dogovor/;

export function izvuciLift(oglas) {
  const nadjeno = new Set();
  let neprepoznato = false;
  for (const dio of String(oglas ?? '').split(DIJELOVI)) {
    const n = norm(dio);
    if (!/\b(lift|dizal)/.test(n)) continue;
    if (ZAZIRANJE.test(n)) return KONFLIKT;
    if (/\b(bez|nema|nemaju|nije)\s+(?:\w+\s+)?(lift|dizal)/.test(n) || /\b(lift|dizal)\w*\s+(ne|nema)$/.test(n)) nadjeno.add('ne');
    else if (/\b(s|sa|uz|ima|imaju)\s+(?:\w+\s+)?(lift|dizal)/.test(n) || /\b(lift|dizal)\w*\s+(da|u zgradi)$/.test(n)) nadjeno.add('da');
    else neprepoznato = true;
  }
  if (nadjeno.size > 1 || (nadjeno.size === 1 && neprepoznato)) return KONFLIKT;
  return nadjeno.size === 1 ? [...nadjeno][0] : undefined;
}

const REDNI = { prv: 1, drug: 2, trec: 3, cetvrt: 4, pet: 5, sest: 6, sedm: 7, osm: 8, devet: 9, deset: 10 };
export function izvuciKat(oglas) {
  const n = norm(oglas);
  const kat = new Set();
  const dodaj = (v) => kat.add(v);
  // "2. kat" (točku uklanja normalizacija), "na 2. katu", "kat: 2", "kat 2/4"; "5 katova" i "4 kata" (visina zgrade) ne ulaze
  for (const m of n.matchAll(/\b(\d{1,2})\s+kat\b/g)) dodaj(Number(m[1]));
  for (const m of n.matchAll(/\bna\s+(\d{1,2})\s+katu\b/g)) dodaj(Number(m[1]));
  for (const m of n.matchAll(/\bkat\s+(\d{1,2})\b(?!\s+(?:m2|kvadrat))/g)) dodaj(Number(m[1]));
  for (const m of n.matchAll(/\b(prv|drug|trec|cetvrt|pet|sest|sedm|osm|devet|deset)\w*\s+kat(?:u|om)?\b/g)) dodaj(REDNI[m[1]]);
  if (/\bvisok\w*\s+prizemlj/.test(n)) return KONFLIKT; // visoko prizemlje nije ni prizemlje ni kat
  if (/\bprizemlj/.test(n)) dodaj(0);
  return kat.size === 1 ? [...kat][0] : kat.size > 1 ? KONFLIKT : undefined;
}

export function izvuciGodinuGradnje(oglas, trenutnaGodina) {
  const t = bezDijakritika(oglas);
  const godine = new Set();
  // iza godine ne smije slijediti raspon ("1960.-1970.", "1960. do 1970.")
  const NIJE_RASPON = '(?!\\.?\\s*(?:[-–]|do\\b|i\\b)\\s*(?:19|20)\\d{2})';
  for (const m of t.matchAll(new RegExp(`\\b(?:izgra\\w*|sagra\\w*|gradnj\\w*)[\\s:]+(?:\\w+\\s+){0,2}?((?:19|20)\\d{2})\\b${NIJE_RASPON}`, 'g'))) godine.add(Number(m[1]));
  for (const m of t.matchAll(new RegExp(`\\b((?:19|20)\\d{2})\\b${NIJE_RASPON}\\.?\\s+(?:godine\\s+)?(?:izgra\\w*|sagra\\w*)`, 'g'))) godine.add(Number(m[1]));
  if (/\b(?:izgra\w*|sagra\w*|gradnj\w*)\s+(?:\w+\s+){0,3}?(?:19|20)\d{2}\.?\s*(?:[-–]|do\b)\s*(?:19|20)\d{2}/.test(t)) return KONFLIKT;
  const v = [...godine];
  if (v.length > 1) return KONFLIKT;
  return v.length === 1 && v[0] >= 1800 && v[0] <= trenutnaGodina ? v[0] : undefined;
}

// Godina obnove iz oglasa: samo ako je jedina navedena (više različitih godina = ne znamo koja je kojeg opsega).
export function izvuciGodinuObnove(oglas, trenutnaGodina) {
  const godine = new Set();
  for (const m of bezDijakritika(oglas).matchAll(/(?:renovir|obnovljen|adaptir|preuredj?en|sanir|rekonstru)\w*[^.\d\n]{0,40}?((?:19|20)\d{2})\b/g)) {
    if (Number(m[1]) <= trenutnaGodina) godine.add(Number(m[1]));
  }
  return godine.size === 1 ? [...godine][0] : null;
}

// ── provjera činjenica koje je izvukao model: vrijednost mora odgovarati citatu (citat je već normaliziran) ──
// Blizina mora ("100 m do mora", "blizu plaže") bez pogleda ne ulazi.
const POGLED_NA_MORE = /pogled\w*\W+(?:\w+\W+){0,3}(more|mora|moru|morem|jadran\w*)\b|\b(more|morski|morsk\w+)\W+(?:\w+\W+)?pogled|\bsea view\b/;
const NEGACIJA = /\b(bez|nema|nemaju|nije)\b/;
const JAVNO = /javn|u blizini|ispred zgrade|u okolici|u ulici/;
const PROVJERE = {
  lift: (v, c) => (v === 'ne' ? /\b(bez|nema|nemaju|nije)\b.*\b(lift|dizal)|\b(lift|dizal)\w*\s+(ne|nema)$/.test(c)
    : /\b(s|sa|uz|ima|imaju)\b.*\b(lift|dizal)|\b(lift|dizal)\w*\s+(da|u zgradi)$/.test(c) && !NEGACIJA.test(c)),
  parking: (v, c) => {
    if (NEGACIJA.test(c)) return false;
    if (v === 'garaza') return /garaz/.test(c) && !/javn/.test(c);
    if (v === 'javno') return /parking|parkir|parkiral/.test(c) && JAVNO.test(c);
    return /parking|parkir|\bpm\b/.test(c) && /vlastit|u cijeni|uz stan|pripada|zasebn|ukljucen|\bpm\b|rezerv|osiguran/.test(c) && !JAVNO.test(c);
  },
  energetski_razred: (v, c) => new RegExp(`energet\\w*\\W+(?:\\w+\\W+){0,2}${v.toLowerCase().replace('+', '\\+')}(?![\\w+])`).test(c),
  pogled_na_more: (v, c) => POGLED_NA_MORE.test(c) && !NEGACIJA.test(c),
};
const DIO_STANJA = /stolarij|prozor|vrata|kupaon|wc|kuhinj|parket|podov|instalacij|elektro|vodovod|fasad|krov|djelomic|dijelom|dio stana|nekoliko prostor/;
const OBNOVA = /renov|obnov|adapt|preured|sanir|rekonstru|novoured/;
const ZA_OBNOVU = /\b(za|treba|potreb\w+|zahtijeva)\s+(\w+\s+)?(renovacij|adaptacij|obnov|ulaganj|preure)|neured\w*|derutn|trosn|dotrajal|za uredj?enj\w*/;
const USELJIVO = /useljiv|namjesten|opremljen|uredj?en/;

// Stanje koje kod stvarno vidi u citatu; neslaganje s onim što je model tvrdio → odlučuje kod (model samo nudi citat).
export function klasificirajStanje(citat) {
  const c = norm(citat);
  if (ZA_OBNOVU.test(c) && !NEGACIJA.test(c)) return 'za_renovaciju';
  if (OBNOVA.test(c)) return DIO_STANJA.test(c) ? 'djelomicno' : 'renovirano';
  if (DIO_STANJA.test(c) && /\b(nov\w*|zamijenjen\w*|promijenjen\w*|(?:19|20)\d{2})\b/.test(c)) return 'djelomicno';
  if (USELJIVO.test(c)) return 'useljivo';
  return NEPOZNATO;
}

// Broj uz "m2"/"m²" u oglasu ("58 m2", "58,5 m²", "58.5m2") jednak je zadanoj površini.
export function povrsinaUOglasu(oglas, vrijednost) {
  for (const m of String(oglas ?? '').matchAll(/(\d+(?:[.,]\d+)?)\s*(?:m\s*2|m²|m\^2)/gi)) {
    if (Number(m[1].replace(',', '.')) === vrijednost) return true;
  }
  return false;
}

// Skupi konačne činjenice. Ulaz: model (činjenice iz alata), oglas (tekst bez cijena), podaci (polja forme), godina (tekuća),
// povrsinaModel (površina koju je model prepisao). Izlaz: { cinjenice, odbaceno } — svaka činjenica nosi `izvor`.
export function skupiCinjenice({ model = {}, oglas = '', podaci = {}, godina, povrsinaModel = null }) {
  const odbaceno = [];
  const ima = (v) => v !== undefined && v !== null && v !== NEPOZNATO && v !== '';
  // Činjenica koju je model izvukao vrijedi samo uz citat koji doista stoji u oglasu.
  const odModela = (k) => {
    const o = model && typeof model[k] === 'object' && model[k] !== null ? model[k] : {};
    if (!ima(o.vrijednost)) return null;
    if (!citatUOglasu(o.citat, oglas)) { odbaceno.push({ cinjenica: k, vrijednost: o.vrijednost, uzrok: 'citat nije u oglasu' }); return null; }
    return { vrijednost: o.vrijednost, citat: norm(o.citat) };
  };
  const slaze = (k, o, provjera) => {
    if (!o) return null;
    if (!provjera(o)) { odbaceno.push({ cinjenica: k, vrijednost: o.vrijednost, uzrok: 'citat ne odgovara vrijednosti' }); return null; }
    return o;
  };
  const c = {};

  // lift: forma > kod > model
  const liftKod = izvuciLift(oglas);
  if (podaci.lift === 'da' || podaci.lift === 'ne') c.lift = { vrijednost: podaci.lift, izvor: 'forma' };
  else if (typeof liftKod === 'string') c.lift = { vrijednost: liftKod, izvor: 'kod' };
  else {
    const m = liftKod === KONFLIKT ? null : slaze('lift', odModela('lift'), (o) => VRIJEDNOSTI.lift.includes(o.vrijednost) && PROVJERE.lift(o.vrijednost, o.citat));
    c.lift = m ? { vrijednost: m.vrijednost, izvor: 'model' } : { vrijednost: NEPOZNATO, izvor: null };
  }

  // kat: forma > kod > model
  const katKod = izvuciKat(oglas);
  if (Number.isInteger(podaci.kat)) c.kat = { vrijednost: podaci.kat, izvor: 'forma' };
  else if (Number.isInteger(katKod)) c.kat = { vrijednost: katKod, izvor: 'kod' };
  else {
    const m = katKod === KONFLIKT ? null : slaze('kat', odModela('kat'), (o) => {
      const v = o.vrijednost;
      if (!Number.isInteger(v) || v < 0 || v > 40 || /visok\w*\s+prizemlj/.test(o.citat)) return false;
      if (v === 0) return /prizemlj/.test(o.citat);
      const redni = Object.keys(REDNI).find((r) => REDNI[r] === v);
      return /\bkat/.test(o.citat) && o.citat.split(' ').some((w) => w === String(v) || (redni && w.startsWith(redni)));
    });
    c.kat = m ? { vrijednost: m.vrijednost, izvor: 'model' } : { vrijednost: null, izvor: null };
  }

  // godina gradnje: forma > kod > model
  const godKod = izvuciGodinuGradnje(oglas, godina);
  if (Number.isInteger(podaci.godina_gradnje)) c.godina_gradnje = { vrijednost: podaci.godina_gradnje, izvor: 'forma' };
  else if (Number.isInteger(godKod)) c.godina_gradnje = { vrijednost: godKod, izvor: 'kod' };
  else {
    const m = godKod === KONFLIKT ? null : slaze('godina_gradnje', odModela('godina_gradnje'), (o) => Number.isInteger(o.vrijednost) && o.vrijednost >= 1800 && o.vrijednost <= godina
      && o.citat.split(' ').includes(String(o.vrijednost)) && /gradn|gradj|izgra|sagra/.test(o.citat));
    c.godina_gradnje = m ? { vrijednost: m.vrijednost, izvor: 'model' } : { vrijednost: null, izvor: null };
  }

  // parking: forma "javni"/"ne" odlučuju; forma "da" znači najmanje vlastito mjesto (garažu smije potvrditi oglas)
  const park = slaze('parking', odModela('parking'), (o) => VRIJEDNOSTI.parking.includes(o.vrijednost) && PROVJERE.parking(o.vrijednost, o.citat));
  const parkOglas = park ? park.vrijednost : NEPOZNATO;
  if (podaci.parking === 'javni') c.parking = { vrijednost: 'javno', izvor: 'forma' };
  else if (podaci.parking === 'ne') c.parking = { vrijednost: NEPOZNATO, izvor: 'forma' };
  else if (podaci.parking === 'da') c.parking = { vrijednost: parkOglas === 'garaza' ? 'garaza' : 'vlastito', izvor: 'forma' };
  else c.parking = { vrijednost: parkOglas, izvor: park ? 'model' : null };

  // stanje: stanje određuje kod iz citata (model nudi citat i prijedlog). Godina obnove: iz citata ili jedina godina obnove u oglasu.
  const st = odModela('stanje');
  let stanje = NEPOZNATO;
  let godinaObnove = null;
  if (st) {
    stanje = klasificirajStanje(st.citat);
    if (stanje !== st.vrijednost) odbaceno.push({ cinjenica: 'stanje', vrijednost: st.vrijednost, uzrok: `citat odgovara stanju "${stanje}"` });
    if (stanje === 'renovirano') {
      const izCitata = [...st.citat.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1])).filter((g) => g <= godina);
      godinaObnove = izCitata.length === 1 ? izCitata[0] : izCitata.length === 0 ? izvuciGodinuObnove(oglas, godina) : null;
    }
  }
  c.stanje = { vrijednost: stanje, izvor: stanje === NEPOZNATO ? null : 'model' };
  c.godina_obnove = { vrijednost: godinaObnove, izvor: godinaObnove === null ? null : 'oglas' };

  const ener = slaze('energetski_razred', odModela('energetski_razred'), (o) => VRIJEDNOSTI.energetski_razred.includes(o.vrijednost) && PROVJERE.energetski_razred(o.vrijednost, o.citat));
  c.energetski_razred = ener ? { vrijednost: ener.vrijednost, izvor: 'model' } : { vrijednost: NEPOZNATO, izvor: null };

  const more = slaze('pogled_na_more', odModela('pogled_na_more'), (o) => o.vrijednost === 'da' && PROVJERE.pogled_na_more(o.vrijednost, o.citat));
  c.pogled_na_more = more ? { vrijednost: 'da', izvor: 'model' } : { vrijednost: NEPOZNATO, izvor: null };

  // površina za pravilo veličine: forma, ili broj koji je model prepisao samo ako doista stoji u oglasu uz "m2"
  if (typeof podaci.povrsina_m2 === 'number' && podaci.povrsina_m2 > 0) c.povrsina_m2 = { vrijednost: podaci.povrsina_m2, izvor: 'forma' };
  else if (typeof povrsinaModel === 'number' && povrsinaModel > 0 && povrsinaUOglasu(oglas, povrsinaModel)) c.povrsina_m2 = { vrijednost: povrsinaModel, izvor: 'model' };
  else c.povrsina_m2 = { vrijednost: null, izvor: null };

  return { cinjenice: c, odbaceno };
}

// ── pravila: činjenice → popis { razlog, postotak } (najviše jedna stavka po skupini, pa najviše 6 stavki) ──
export function korekcijeIzCinjenica(c, { godina }) {
  const stavke = [];
  const dodaj = (razlog, postotak) => { if (postotak !== 0) stavke.push({ razlog, postotak }); };
  const kat = c.kat.vrijednost;

  // skupina lift/kat
  let lift = 0;
  let liftRazlog = '';
  if (c.lift.vrijednost === 'ne') {
    const t = TABLICA.lift_ne;
    lift = kat === null ? t.kat_nepoznat : kat >= 4 ? t.kat_4_plus : kat === 3 ? t.kat_3 : t.kat_do_2;
    liftRazlog = kat === null ? 'bez lifta' : `bez lifta, ${kat}. kat`;
  } else if (c.lift.vrijednost === 'da' && kat !== null && kat >= 3) {
    lift = TABLICA.lift_da.kat_3_plus;
    liftRazlog = `lift, ${kat}. kat`;
  }
  if (lift !== 0) dodaj(liftRazlog, lift);
  else if (kat === 0) dodaj('prizemlje', TABLICA.prizemlje);

  // skupina parking
  if (c.parking.vrijednost === 'vlastito') dodaj('vlastito parkirno mjesto', TABLICA.parking.vlastito);
  else if (c.parking.vrijednost === 'garaza') dodaj('garaža', TABLICA.parking.garaza);

  // skupina starost/stanje: stanje (ako nije 0) prebrisuje starost
  const S = TABLICA.stanje;
  const obnova = c.godina_obnove.vrijednost;
  let stanjePosto = 0;
  let stanjeRazlog = '';
  if (c.stanje.vrijednost === 'renovirano') {
    if (obnova === null) { stanjePosto = S.obnova_bez_godine; stanjeRazlog = 'obnova (godina nije navedena)'; }
    else if (godina - obnova <= 10) { stanjePosto = S.obnova_do_10_god; stanjeRazlog = `obnova ${obnova}.`; }
    else stanjePosto = S.obnova_starija;
  } else if (c.stanje.vrijednost === 'djelomicno') { stanjePosto = S.djelomicno; stanjeRazlog = 'djelomična obnova'; }
  else if (c.stanje.vrijednost === 'za_renovaciju') { stanjePosto = S.za_renovaciju; stanjeRazlog = 'za renovaciju'; }
  if (stanjePosto !== 0) dodaj(stanjeRazlog, stanjePosto);
  else if (c.godina_gradnje.vrijednost !== null) {
    const starost = godina - c.godina_gradnje.vrijednost;
    const pravilo = starost >= 0 ? TABLICA.starost.find((r) => starost <= r.do) : null;
    if (pravilo) dodaj(`gradnja ${c.godina_gradnje.vrijednost}.`, pravilo.posto);
  }

  // energetski razred
  const e = c.energetski_razred.vrijednost;
  if (['A+', 'A', 'B'].includes(e)) dodaj(`energetski razred ${e}`, TABLICA.energetski.povoljan);
  else if (['E', 'F', 'G'].includes(e)) dodaj(`energetski razred ${e}`, TABLICA.energetski.nepovoljan);

  // veličina
  const a = c.povrsina_m2.vrijednost;
  if (a !== null) {
    const r = TABLICA.povrsina.find((x) => (x.ispod !== undefined ? a < x.ispod : x.do !== undefined ? a <= x.do : true));
    dodaj(`površina ${String(a).replace('.', ',')} m²`, r.posto);
  }

  // pogled na more
  if (c.pogled_na_more.vrijednost === 'da') dodaj('pogled na more', TABLICA.pogled_na_more);

  return stavke;
}
