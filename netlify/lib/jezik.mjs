// PropIQ — jezična obrada i provjera teksta koji vraća model (hrvatski standard): ćirilični znakovi koji
// izgledaju kao latinični, ponovljene riječi, strani pojmovi te provjere omjera ("1,6×", "dvostruko") i
// ciljane ponude (ne smije se zvati vrijednošću). Čiste funkcije; koristi ih netlify/lib/izvjestaj.mjs.

// Ćirilica → latinica za znakove koji izgledaju isto. "у" je namjerno "u", ne "y": hrvatski nema "y", a model
// ju je ubacivao usred riječi umjesto "u".
const ISTI_IZGLED = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'u', 'х': 'x', 'к': 'k', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'U', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
};
const CIRILICA = /[Ѐ-ӿ]/;
const LATINICA = /[A-Za-zÀ-ɏ]/;

// Riječ koja miješa latinicu i ćirilicu (ili je jedno ćirilično slovo među latinicom) dobiva latinične
// zamjene; cijele ćirilične riječi se ne diraju. Zamjene se dodaju u `log`.
export function ocistiCirilicu(tekst, polje = '', log = []) {
  if (typeof tekst !== 'string' || !CIRILICA.test(tekst)) return tekst;
  return tekst.replace(/[\p{L}\p{M}]+/gu, (rijec) => {
    if (!CIRILICA.test(rijec) || !(LATINICA.test(rijec) || [...rijec].length === 1)) return rijec;
    const nova = [...rijec].map((z) => ISTI_IZGLED[z] ?? z).join('');
    if (nova !== rijec) log.push({ vrsta: 'cirilica', polje, prije: rijec, poslije: nova });
    return nova;
  });
}

// "li li", "je je": ista riječ dvaput zaredom (samo slova, razmak između) svodi se na jedno pojavljivanje.
export function ukloniPonovljeneRijeci(tekst, polje = '', log = []) {
  if (typeof tekst !== 'string') return tekst;
  const re = /(?<![\p{L}\p{N}])([\p{L}]+)([ \t]+)\1(?![\p{L}\p{N}])/giu;
  let t = tekst;
  for (let i = 0; i < 4; i++) {
    const nova = t.replace(re, (m, r) => { log.push({ vrsta: 'ponovljena_rijec', polje, prije: m, poslije: r }); return r; });
    if (nova === t) break;
    t = nova;
  }
  return t;
}

// Strani pojmovi koje kod mijenja (ostatak je u pojmovniku u promptu). "HOA" → "pričuva".
const STRANI_POJMOVI = [
  [/(?<![\p{L}\p{N}])HOA(?:[ -](?:fee|naknad\p{L}*))?(?![\p{L}\p{N}])/gu, 'pričuva'],
];
export function zamijeniStranePojmove(tekst, polje = '', log = []) {
  if (typeof tekst !== 'string') return tekst;
  let t = tekst;
  for (const [re, zamjena] of STRANI_POJMOVI) {
    t = t.replace(re, (m) => { log.push({ vrsta: 'strani_pojam', polje, prije: m, poslije: zamjena }); return zamjena; });
  }
  return t;
}

// Cijela obrada jednog teksta. `log` prima zapise o svakoj promjeni.
export function obradiTekst(tekst, polje = '', log = []) {
  if (typeof tekst !== 'string') return tekst;
  return ukloniPonovljeneRijeci(zamijeniStranePojmove(ocistiCirilicu(tekst, polje, log), polje, log), polje, log);
}

// Hrvatski pojmovnik za prompt: što pisati umjesto stranih izraza.
export const POJMOVNIK = [
  ['HOA', 'pričuva'], ['fee', 'naknada'], ['cash flow', 'novčani tok'], ['ROI', 'povrat ulaganja'], ['yield', 'prinos'],
  ['closing costs', 'troškovi kupnje'], ['listing', 'oglas'], ['asking price', 'tražena cijena'], ['due diligence', 'provjera dokumentacije'],
  ['buyer / seller', 'kupac / prodavatelj'], ['deal', 'ponuda ili prilika'],
];
export const POJMOVNIK_TEKST = POJMOVNIK.map(([s, h]) => `"${s}" → "${h}"`).join(', ');

// ── rečenice ──
const KRATICE = new Set(['tj', 'npr', 'itd', 'god', 'br', 'ul', 'sv', 'tzv', 'cca', 'ca', 'mj', 'tis', 'mil', 'str', 'vl', 'dr', 'ko']);
export function recenice(tekst) {
  const dijelovi = [];
  let pocetak = 0;
  const re = /([.!?])\s+(?=[A-ZŠĐČĆŽ0-9„"'(])/gu;
  for (const m of tekst.matchAll(re)) {
    const prije = tekst.slice(pocetak, m.index).match(/([\p{L}]+)$/u);
    if (m[1] === '.' && prije && (KRATICE.has(prije[1].toLowerCase()) || prije[1].length === 1)) continue;
    dijelovi.push(tekst.slice(pocetak, m.index + 1));
    pocetak = m.index + m[0].length;
  }
  dijelovi.push(tekst.slice(pocetak));
  return dijelovi.map((r) => r.trim()).filter(Boolean);
}

// ── omjeri ("1,6×", "dvostruko", "3 puta veća") ──
const RIJEC_MNOZITELJ = [
  [/dvostruk\p{L}*|dvaput|udvostru\p{L}*|dupl\p{L}*|dva\s+puta/iu, 2],
  [/trostruk\p{L}*|triput|utrostru\p{L}*|tri\s+puta/iu, 3],
  [/[čc]etverostruk\p{L}*|[čc]etiriput|[čc]etiri\s+puta/iu, 4],
  [/peterostruk\p{L}*|pet\s+puta/iu, 5],
];
// Riječ za usporedbu unutar dvije riječi iza višekratnika ("dva puta veća", "3 puta skuplje od").
const USPOREDBA_IZVOR = String.raw`\s+(?:\p{L}+\s+){0,2}(?:vi[šs]\p{L}*|ve[ćc]\p{L}*|skuplj\p{L}*|jeftinij\p{L}*|manj\p{L}*|ni[žz]\p{L}*|od|iznad|ispod)(?![\p{L}])`;
const USPOREDBA = `(?=${USPOREDBA_IZVOR})`;
const RE_BROJ_PUTA = new RegExp(String.raw`(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)\s*puta(?![\p{L}])${USPOREDBA}`, 'giu');
const RE_BROJ_KRAT = /(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)\s*×/gu;
const TOL_BROJ = 0.051; // omjer je zaokružen na jednu decimalu
const TOL_RIJEC = 0.15; // "dvostruko" uz omjer 1,9 još prolazi, uz 1,6 ne

// Svaka tvrdnja o višekratniku mora odgovarati omjeru tražene cijene i sredine fer raspona (iz koda).
// omjer = null: tvrdnje o višekratniku nisu dopuštene. Vraća razlog odbijanja ili null.
export function provjeriOmjere(tekst, omjer, polje = 'sazetak') {
  const ima = typeof omjer === 'number' && Number.isFinite(omjer);
  const kriv = (navod) => `${polje}: tvrdnja o omjeru "${navod.trim()}" ne odgovara izračunu${ima ? ` (${String(omjer).replace('.', ',')}×)` : ' (omjer nije izračunat)'}`;
  for (const re of [RE_BROJ_PUTA, RE_BROJ_KRAT]) {
    for (const m of String(tekst).matchAll(re)) {
      const x = Number(m[1].replace(',', '.'));
      if (!ima || !(Math.abs(x - omjer) <= TOL_BROJ)) return kriv(m[0]);
    }
  }
  for (const [re, n] of RIJEC_MNOZITELJ) {
    const g = new RegExp(String.raw`(?<![\p{L}])(?:${re.source})(?![\p{L}])`, 'giu');
    for (const m of String(tekst).matchAll(g)) {
      if (/puta$/i.test(m[0])) {
        // "dva puta" samo uz usporedbu (inače je npr. "tri puta godišnje")
        const nakon = String(tekst).slice(m.index + m[0].length);
        if (!new RegExp(`^${USPOREDBA_IZVOR}`, 'iu').test(nakon)) continue;
      }
      // "trostruko IZO staklo" nije tvrdnja o cijeni: riječ je tvrdnja o omjeru samo ako rečenica govori o cijeni/vrijednosti.
      if (!cjenovniKontekst(String(tekst), m.index)) continue;
      if (!ima || !(Math.abs(n - omjer) <= TOL_RIJEC)) return kriv(m[0]);
    }
  }
  return null;
}
const RE_CIJENA_KONTEKST = /cijen|skup|jeftin|vrijed|€|\beur|ponud|raspon|plati|kosta|tra[žz]/iu;
function cjenovniKontekst(tekst, indeks) {
  const od = Math.max(tekst.lastIndexOf('. ', indeks), tekst.lastIndexOf('! ', indeks), tekst.lastIndexOf('? ', indeks)) + 1;
  const doKraja = tekst.slice(indeks).search(/[.!?](\s|$)/);
  return RE_CIJENA_KONTEKST.test(tekst.slice(od, doKraja < 0 ? tekst.length : indeks + doKraja));
}

// ── ciljana ponuda nije vrijednost ──
const VRIJEDNOST = String.raw`(?:realn|fer|stvarn|prav|tržišn|trzisn)\p{L}*\s+vrijednost\p{L}*`;
const POVEZNICA = String.raw`(?:je|jest|iznosi|odgovara|predstavlja|=|:)`;
const RAZMAK_BROJA = String.raw`[.,'’  ]?`;

function regexIznosa(eur) {
  const s = String(Math.round(eur));
  const grupe = [];
  for (let i = s.length; i > 0; i -= 3) grupe.unshift(s.slice(Math.max(0, i - 3), i));
  return grupe.join(RAZMAK_BROJA);
}

// Ciljana ponuda je prijedlog cijene, ne vrijednost: odbija "ponuda je realna/fer vrijednost" i
// "realna vrijednost je <iznos ponude>". `izuzeto`: iznosi koji nisu samo ponuda (tražena cijena, granice raspona).
export function provjeriPonudu(tekst, ponudaEur, izuzeto = [], polje = 'sazetak') {
  const iznosJeSamoPonuda = typeof ponudaEur === 'number' && ponudaEur > 0 && !izuzeto.some((v) => typeof v === 'number' && Math.abs(v - ponudaEur) <= 1);
  const a = new RegExp(String.raw`(?<![\p{L}])ponud\p{L}*(?:[^.!?]|(?<=\d)\.(?=\d)){0,40}?(?<![\p{L}])${POVEZNICA}\s+(?:(?:oko|otprilike|pribli[žz]no|upravo|ujedno|ta[čc]no)\s+)?${VRIJEDNOST}`, 'iu');
  const b = iznosJeSamoPonuda
    ? new RegExp(String.raw`${VRIJEDNOST}\s*(?:${POVEZNICA}|bi\s+bil[ao])?\s*(?:oko|otprilike|pribli[žz]no)?\s*${regexIznosa(ponudaEur)}(?!\d)`, 'iu')
    : null;
  for (const r of recenice(String(tekst))) {
    if (a.test(r) || (b && b.test(r))) return `${polje}: ciljana ponuda ne smije se nazivati vrijednošću ("${r.slice(0, 80)}")`;
  }
  return null;
}
