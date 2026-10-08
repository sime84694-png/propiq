// PropIQ — sažetak izvještaja: brojke (razlika, postotak, omjer) i prvu rečenicu računa kod, model ih samo
// prepisuje; ovdje je i provjera brojki u sažetku. Koristi ga netlify/lib/izvjestaj.mjs.

import izracuni from '../../public/assets/js/izracuni.js';

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

// Omjer tražene cijene i sredine fer raspona, zaokružen na jednu decimalu (npr. 1,6). null ako nema cijene ili raspona.
export function omjerCijene(cijena, fer) {
  if (!(typeof cijena === 'number' && cijena > 0) || !fer || !(fer.min_eur > 0) || !(fer.max_eur > 0)) return null;
  return Math.round((cijena / ((fer.min_eur + fer.max_eur) / 2)) * 10) / 10;
}
const omjerHr = (o) => o.toFixed(1).replace('.', ',');

// Prva rečenica sažetka (cijena, raspon, razlika, %, omjer) slaže se u kodu, gramatički ispravno; model dodaje
// najviše jednu rečenicu obrazloženja. null ako nema cijene ili raspona.
export function prvaRecenicaSazetka(cijena, fer) {
  const c = cinjeniceSazetka(cijena, fer);
  if (!c) return null;
  const pocetak = `Tražena cijena od ${eurHr(cijena)} € nalazi se`;
  const raspon = `fer raspona od ${eurHr(fer.min_eur)} do ${eurHr(fer.max_eur)} €`;
  if (c.polozaj === 'unutar') return `${pocetak} unutar ${raspon}.`;
  const o = omjerCijene(cijena, fer);
  return `${pocetak} ${eurHr(c.razlika_eur)} € (${postoHr(c.posto)} %) ${c.polozaj === 'iznad' ? 'iznad gornje' : 'ispod donje'} granice ${raspon}` +
    `${o !== null && o !== 1 ? `, što je ${omjerHr(o)}× sredina raspona` : ''}.`;
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
  const pravilo = 'Sažetak: ne računaj postotke ni razlike u eurima; navedi isključivo brojke iz ovog bloka (prepiši ih točno) i nikakve druge postotke ni iznose. Ciljana ponuda je prijedlog cijene, nikad "realna" ni "fer" vrijednost.';
  const c = cijenaZnana ? cinjeniceSazetka(cijena, fer) : null;
  if (!c) return `Gotovi brojevi za sažetak:\n- Razlika cijene i raspona nije izračunata: u sažetku NE navodi postotke ni razlike u eurima prema rasponu, ni omjere ("dvostruko", "N puta"), samo opisno (ispod/unutar/iznad raspona).\n${pravilo}`;
  const o = omjerCijene(cijena, fer);
  const cilj = izracuni.izracunajPonudu(cijena, fer.min_eur, fer.max_eur);
  const razlika = c.polozaj === 'unutar' ? 'cijena je unutar raspona, nema razlike (ne navodi postotak ni razliku u eurima)'
    : `${eurHr(c.razlika_eur)} € (${postoHr(c.posto)} % ${c.polozaj === 'iznad' ? 'iznad gornje' : 'ispod donje'} granice raspona)`;
  return `Gotovi brojevi za sažetak (izračunao sustav):\n- Tražena cijena ${eurHr(cijena)} €, fer raspon ${eurHr(fer.min_eur)}–${eurHr(fer.max_eur)} €.\n- Položaj: ${c.polozaj} raspona.\n- Razlika: ${razlika}.\n` +
    `- Omjer tražene cijene i sredine fer raspona: ${omjerHr(o)}× (ne tvrdi "dvostruko", "triput" ni slično; omjer smiješ navesti samo ovako).\n${ponudaRedak(cilj)}` +
    `- Prvu rečenicu sažetka (cijena, raspon, razlika, postotak) slaže sustav i stavlja je ispred tvog teksta: ti napiši SAMO JEDNU rečenicu obrazloženja koja ne ponavlja te brojke.\n${pravilo}`;
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
