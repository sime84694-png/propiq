// PropIQ — redakcija cijena iz teksta oglasa za "slijepu" procjenu fer vrijednosti.
// Poziv 1 (procjena) nikad ne smije vidjeti traženu cijenu, inače se procjena prilagodi njoj
// ("anchoring"). Zato se iz teksta uklanjaju iznosi u eurima/kunama, €/m², retci s oznakom cijene
// i svi zapisi cijene koju je korisnik upisao u formu. Koristi ga netlify/functions/analiza.mjs.

export const OZNAKA = '[cijena uklonjena]';

const NIJE_SLOVO_BROJ = String.raw`(?![\p{L}\d])`;
const PRIJE_BROJA = String.raw`(?<![\p{L}\d])(?<!\d[.,])`;

// Hrvatski i uobičajeni zapisi: 694.896 | 694.896,00 | 694 896 | 694'896 | 694896 | 1,2 | 320.5
const BROJ = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:[   ]\d{3})+(?:[.,]\d{1,2})?|\d{1,3}(?:['’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)(?!\d)`;
const RASPON = String.raw`(?:${BROJ}[  ]*(?:[-–—]|do)[  ]*)?`;

const TIS = String.raw`tis(?:uć\p{L}*|uc\p{L}*)?(?![\p{L}])\.?`;
const MIL = String.raw`(?:mil(?:ijun\p{L}*)?|mln)(?![\p{L}])\.?`;
const MNOZITELJ = String.raw`(?:k${NIJE_SLOVO_BROJ}|${TIS}|${MIL})`;
const VALUTA = String.raw`(?:€|(?:eur(?:a|o|i)?|evr(?:a|o)|kn|kun[ae]|hrk)${NIJE_SLOVO_BROJ})`;
const PO_M2 = String.raw`(?:[  ]*(?:\/|po[  ])[  ]*(?:m[²2]|m\^2|kvadrat\p{L}*)${NIJE_SLOVO_BROJ})?`;

const re = (izvor) => new RegExp(izvor, 'giu');

const OPCE = [
  // 694.896 € | 694 896,00 EUR | 320k eura | 320 tis. € | 300.000 – 320.000 € | 2.500 €/m² | 3000 eur po m2
  re(String.raw`${PRIJE_BROJA}${RASPON}${BROJ}[  ]*${MNOZITELJ}?[  ]*${VALUTA}${PO_M2}`),
  // €320k | EUR 320.000 | € 2.500/m²
  re(String.raw`(?:€|(?<![\p{L}\d])eur(?![\p{L}])\.?)[  ]*${RASPON}${BROJ}[  ]*${MNOZITELJ}?${PO_M2}`),
  // iznosi bez valute: "320 tis.", "1,2 milijuna", "320k", "694.896,00"
  re(String.raw`${PRIJE_BROJA}${BROJ}[  ]*(?:${TIS}|${MIL})`),
  re(String.raw`${PRIJE_BROJA}\d{2,4}(?:[.,]\d)?[  ]?k${NIJE_SLOVO_BROJ}`),
  re(String.raw`${PRIJE_BROJA}\d{1,3}(?:\.\d{3})+,\d{2}(?!\d)`),
  // "tristo tisuća eura", "sto dvadeset tisuća €"
  re(String.raw`(?<![\p{L}])(?:(?:jedan|jedna|jedno|dva|dvije|tri|[čc]etiri|pet|[šs]est|sedam|osam|devet|deset|jedanaest|dvanaest|trinaest|[čc]etrnaest|petnaest|[šs]esnaest|sedamnaest|osamnaest|devetnaest|dvadeset|trideset|[čc]etrdeset|pedeset|[šs]ezdeset|sedamdeset|osamdeset|devedeset|sto|stotin\p{L}*|dvjesto|tristo|[čc]etiristo|petsto|[šs]esto|sedamsto|osamsto|devetsto|i)[  ]+){0,8}(?:tisu[ćc]\p{L}*|milijun\p{L}*)(?:[  ]+(?:[a-zčćđšž]+))*?[  ]+${VALUTA}`),
];

// Ispred riječi koja označava cijenu: briše se oznaka i ostatak rečenice/retka.
const OSTATAK = String.raw`[^\n]*?(?:(?<=\S)[.!?](?=\s|$)|(?=\n)|$)`;
const OZNAKE_CIJENE = [
  re(String.raw`(?<![\p{L}])(?:tra[žz]en\p{L}*|prodajn\p{L}*|ukupn\p{L}*|po[čc]etn\p{L}*|kona[čc]n\p{L}*|oglašavan\p{L}*)[  ]+cijen\p{L}*${OSTATAK}`),
  re(String.raw`(?<![\p{L}])cijen\p{L}*[  ]+po[  ]+(?:m[²2]|kvadrat\p{L}*)${OSTATAK}`),
  re(String.raw`(?<![\p{L}])cijen\p{L}*[  ]*(?::|=)${OSTATAK}`),
  re(String.raw`(?<![\p{L}])cijen\p{L}*[  ]*[-–—][  ]*(?=[\d€\[])${OSTATAK}`),
  re(String.raw`(?<![\p{L}])cijen\p{L}*[  ]+(?=\d|€|\[cijena uklonjena\])${OSTATAK}`),
];

const SEPARATOR = String.raw`[.,'   ’]`;

function grupirano(cijeli) {
  const s = String(cijeli);
  const grupe = [];
  for (let i = s.length; i > 0; i -= 3) grupe.unshift(s.slice(Math.max(0, i - 3), i));
  return grupe.join(`${SEPARATOR}?`);
}

const uRegex = (broj) => String(broj).replace('.', '[.,]');

// Sve varijante zapisa cijene koju je korisnik upisao: 320000, 320.000, 320 000, 320.000,00, 320k, 320 tisuća, 1,2 mil.
function regexiZaCijenu(cijena) {
  if (typeof cijena !== 'number' || !Number.isFinite(cijena) || cijena <= 0) return [];
  const cijeli = Math.floor(cijena);
  const frac = Math.round((cijena - cijeli) * 100);
  const decimale = frac === 0 ? String.raw`(?:[.,]0{1,2})?`
    : String.raw`[.,]${String(frac).padStart(2, '0').replace(/0$/, '')}0?`;
  const lista = [re(String.raw`${PRIJE_BROJA}${grupirano(cijeli)}${decimale}(?![.,]?\d)`)];
  if (Number.isInteger(cijena) && cijena % 1000 === 0) {
    lista.push(re(String.raw`${PRIJE_BROJA}${uRegex(cijena / 1000)}(?:[.,]0+)?[  ]*(?:k${NIJE_SLOVO_BROJ}|${TIS})`));
  }
  if (Number.isInteger(cijena) && cijena >= 1e6 && cijena % 1e4 === 0) {
    lista.push(re(String.raw`${PRIJE_BROJA}${uRegex(cijena / 1e6)}(?:[.,]0+)?[  ]*${MIL}`));
  }
  return lista;
}

// Vraća tekst bez cijena. korisnickaCijena (neobavezno): broj koji je korisnik upisao u formu.
export function ukloniCijene(tekst, korisnickaCijena) {
  if (typeof tekst !== 'string' || !tekst) return '';
  let t = tekst;
  for (const r of OPCE) t = t.replace(r, OZNAKA);
  for (const r of regexiZaCijenu(korisnickaCijena)) t = t.replace(r, OZNAKA);
  for (const r of OZNAKE_CIJENE) t = t.replace(r, OZNAKA);
  // uzastopne oznake ("[cijena uklonjena] - [cijena uklonjena]") spoji u jednu
  const dupla = new RegExp(String.raw`(?:\[cijena uklonjena\](?:[  ]*(?:[-–—,;/]|i|do)[  ]*)?){2,}`, 'giu');
  return t.replace(dupla, OZNAKA);
}
