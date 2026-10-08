// PropIQ — zajednički izračuni izvještaja. Isti kod koristi poslužitelj (netlify/lib/izvjestaj.mjs)
// i preglednik (rezultat.html, ručni unos cijene), pa se formule nikad ne dupliciraju.
// Namjerno klasična skripta (UMD): u pregledniku postavlja window.PropIQIzracuni, a u Nodeu je CommonJS.
(function (root, tvornica) {
  if (typeof module === 'object' && module.exports) module.exports = tvornica();
  else root.PropIQIzracuni = tvornica();
})(typeof self !== 'undefined' ? self : this, function () {
  // Pretpostavke neto prinosa. Vraćaju se klijentu u izracuni.pretpostavke.
  const TROSKOVI_NAJMA = 0.10;
  const POREZ_NA_NAJAM = 0.10;
  const POREZ_NA_PROMET = 0.03;
  const MAX_CIJENA = 1e9;

  // ── fer vrijednost: sva matematika je ovdje, model samo predlaže korekcije u postocima ──
  // Središnja €/m² = usklađeni medijan × (1 + zbroj korekcija / 100); raspon = središnja ± širina po pouzdanosti.
  const FER = {
    MAX_KOREKCIJA: 15,            // svaka pojedina korekcija: −15…+15 (%)
    MAX_STAVKI: 6,                // najviše korekcija po procjeni
    MAX_ZBROJ: 30,                // zbroj korekcija: −30…+30 (%)
    MAX_RAZLOG: 40,               // znakova po razlogu korekcije
    SIRINA_POSTO: { visoka: 5, srednja: 7, niska: 10 }, // ± oko središnje €/m², po pouzdanosti
    ZAOKRUZENJE_EUR: 5000,        // ukupni € zaokružen na ovaj korak
  };

  // ── ciljana ponuda: računa je kod iz tražene cijene i fer raspona, model je ne vraća ──
  const PONUDA = {
    UDIO_RASPONA: 0.25,           // cijena unutar raspona: donja granica + ovaj udio širine raspona (ne iznad tražene)
    ZAOKRUZENJE_EUR: 5000,        // ponuda zaokružena na ovaj korak
    NAPOMENA_ISPOD: 'cijena je već ispod fer raspona',
  };

  const pozitivan = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const zaokruzi = (v, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

  // Ručno upisana cijena: "180000", "180.000", "180 000 €", "180.000,50". Vraća broj ili null.
  function parsirajCijenu(tekst) {
    if (typeof tekst !== 'string') return null;
    let s = tekst.replace(/[\s€ ]/g, '');
    if (!/^[\d.,]+$/.test(s)) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const v = Number(s);
    return pozitivan(v) && v <= MAX_CIJENA ? v : null;
  }

  // ── neobavezna strukturirana polja forme (validacija se koristi i u pregledniku i na poslužitelju) ──
  const GRANICE = {
    cijena_eur: [1000, MAX_CIJENA],
    povrsina_m2: [5, 10000],
    kat: [-3, 100],
    godina_gradnje: [1600, 2100],
  };
  const MAX_TEKST_POLJA = 80;
  const LIFT = ['da', 'ne'];
  const PARKING = ['da', 'ne', 'javni'];

  // Broj iz teksta ili broja: "58,5" i "58.5" vrijede; sve drugo je null.
  function parsirajBroj(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\s ]/g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  }

  const prazno = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  // Vraća { ok: true, podaci } (samo upisana polja, očišćena) ili { ok: false, razlog }.
  function validirajPodatke(ulaz) {
    if (prazno(ulaz)) return { ok: true, podaci: {} };
    if (typeof ulaz !== 'object' || Array.isArray(ulaz)) return { ok: false, razlog: 'Ključni podaci nisu u ispravnom obliku.' };
    const podaci = {};
    const greska = (razlog) => ({ ok: false, razlog });
    const raspon = (kljuc, naziv, jedinica, cijeli) => {
      const sirovo = ulaz[kljuc];
      if (prazno(sirovo)) return null;
      const v = kljuc === 'cijena_eur' && typeof sirovo === 'string' ? parsirajCijenu(sirovo) : parsirajBroj(sirovo);
      const [min, max] = GRANICE[kljuc];
      if (v === null || v < min || v > max || (cijeli && !Number.isInteger(v))) {
        return greska(`${naziv}: upišite ${cijeli ? 'cijeli ' : ''}broj između ${min} i ${max}${jedinica}.`);
      }
      podaci[kljuc] = v;
      return null;
    };
    for (const g of [
      raspon('cijena_eur', 'Cijena', ' €', false),
      raspon('povrsina_m2', 'Površina', ' m²', false),
      raspon('kat', 'Kat', '', true),
      raspon('godina_gradnje', 'Godina gradnje', '', true),
    ]) if (g) return g;
    for (const [kljuc, naziv] of [['grad', 'Grad'], ['kvart', 'Kvart']]) {
      if (prazno(ulaz[kljuc])) continue;
      if (typeof ulaz[kljuc] !== 'string' || ulaz[kljuc].trim().length > MAX_TEKST_POLJA) {
        return greska(`${naziv}: najviše ${MAX_TEKST_POLJA} znakova.`);
      }
      if (/[<>\u0000-\u001f]/.test(ulaz[kljuc])) return greska(`${naziv}: sadrži nedopuštene znakove.`);
      podaci[kljuc] = ulaz[kljuc].trim();
    }
    for (const [kljuc, naziv, dopusteno] of [['lift', 'Lift', LIFT], ['parking', 'Parking', PARKING]]) {
      if (prazno(ulaz[kljuc])) continue;
      if (!dopusteno.includes(ulaz[kljuc])) return greska(`${naziv}: dopuštene vrijednosti su ${dopusteno.join(' / ')}.`);
      podaci[kljuc] = ulaz[kljuc];
    }
    return { ok: true, podaci };
  }

  // Analiza se može pokrenuti s tekstom oglasa ILI s cijenom + površinom + gradom.
  function mozeAnaliza(oglasTekst, podaci) {
    if (typeof oglasTekst === 'string' && oglasTekst.trim()) return true;
    return !!podaci && pozitivan(podaci.cijena_eur) && pozitivan(podaci.povrsina_m2) && !!podaci.grad;
  }

  // Korisnikovi podaci imaju prednost pred onim što je izvukao AI (cijena, površina, grad, kvart).
  function primijeniPodatke(analiza, podaci) {
    if (!analiza || typeof analiza !== 'object' || !podaci) return analiza;
    const kopija = { ...analiza, lokacija: { ...(analiza.lokacija || {}) } };
    if ('cijena_eur' in podaci) kopija.cijena_eur = podaci.cijena_eur;
    if ('povrsina_m2' in podaci) kopija.povrsina_m2 = podaci.povrsina_m2;
    if ('grad' in podaci) kopija.lokacija.grad = podaci.grad;
    if ('kvart' in podaci) kopija.lokacija.kvart = podaci.kvart;
    return kopija;
  }

  const stezi = (v, min, max) => Math.min(max, Math.max(min, v));

  // Očisti popis korekcija koji je predložio model: najviše MAX_STAVKI, postotak zaokružen na cijeli broj i
  // ograničen na ±MAX_KOREKCIJA, razlog skraćen. Vraća null ako oblik nije valjan (nije popis, stavka bez
  // razloga ili bez konačnog broja). Isti ulaz uvijek daje isti izlaz (idempotentno).
  // Skrati razlog na najviše `max` znakova na granici riječi, bez viseće interpunkcije na kraju. Ako nema
  // razmaka u dosegu (jedna dulja riječ), reže tvrdo.
  function skratiRazlog(tekst, max) {
    let t = tekst.trim();
    if (t.length > max) {
      const razmak = t.lastIndexOf(' ', max);
      t = t.slice(0, razmak > 0 ? razmak : max);
    }
    return t.replace(/[\s,;:\-–—(/]+$/, '');
  }

  function ocistiKorekcije(sirove) {
    if (!Array.isArray(sirove)) return null;
    const izlaz = [];
    for (const k of sirove.slice(0, FER.MAX_STAVKI)) {
      if (!k || typeof k !== 'object' || typeof k.razlog !== 'string' || !k.razlog.trim()) return null;
      if (typeof k.postotak !== 'number' || !Number.isFinite(k.postotak)) return null;
      izlaz.push({
        razlog: skratiRazlog(k.razlog, FER.MAX_RAZLOG),
        postotak: stezi(Math.round(k.postotak), -FER.MAX_KOREKCIJA, FER.MAX_KOREKCIJA) || 0,
      });
    }
    return izlaz;
  }

  // Izračun fer vrijednosti iz usklađenog medijana, korekcija, pouzdanosti i površine (površina smije biti null:
  // tada nema ukupnih iznosa). Vraća null ako medijan ili pouzdanost nisu valjani.
  function izracunajFer({ medijan_eur_m2, korekcije, pouzdanost, povrsina_m2 = null, naziv = null, napomena = null }) {
    const sirina = FER.SIRINA_POSTO[pouzdanost];
    const popis = ocistiKorekcije(korekcije);
    if (!pozitivan(medijan_eur_m2) || sirina === undefined || popis === null) return null;
    const polaziste = Math.round(medijan_eur_m2);
    const zbroj = popis.reduce((z, k) => z + k.postotak, 0);
    const zbrojPrimijenjen = stezi(zbroj, -FER.MAX_ZBROJ, FER.MAX_ZBROJ);
    const sredina = Math.round(polaziste * (1 + zbrojPrimijenjen / 100));
    const minM2 = Math.round(sredina * (1 - sirina / 100));
    const maxM2 = Math.round(sredina * (1 + sirina / 100));
    let minEur = null;
    let maxEur = null;
    if (pozitivan(povrsina_m2)) {
      const korak = FER.ZAOKRUZENJE_EUR;
      minEur = Math.max(korak, Math.round((minM2 * povrsina_m2) / korak) * korak);
      maxEur = Math.round((maxM2 * povrsina_m2) / korak) * korak;
      if (maxEur <= minEur) maxEur = minEur + korak; // min < max uvijek (i za sasvim male iznose)
    }
    return {
      min_eur: minEur,
      max_eur: maxEur,
      izracun: {
        naziv, napomena: typeof napomena === 'string' && napomena.trim() ? napomena.trim().slice(0, 120) : null,
        polaziste_m2: polaziste, korekcije: popis,
        zbroj_posto: zbroj, zbroj_primijenjen_posto: zbrojPrimijenjen,
        sredina_m2: sredina, sirina_posto: sirina, raspon_m2: { min: minM2, max: maxM2 },
        povrsina_m2: pozitivan(povrsina_m2) ? povrsina_m2 : null,
      },
    };
  }

  // Ciljana ponuda iz tražene cijene i fer raspona. Vraća { ponuda_eur, napomena } ili null (nema cijene ili raspona).
  //   cijena > max → sredina raspona; min ≤ cijena ≤ max → min + UDIO_RASPONA širine (najviše do cijene);
  //   cijena < min → nema pregovora: ponuda je tražena cijena uz napomenu.
  function izracunajPonudu(cijena, min, max) {
    if (!pozitivan(cijena) || !pozitivan(min) || !pozitivan(max) || min > max) return null;
    if (cijena < min) return { ponuda_eur: cijena, napomena: PONUDA.NAPOMENA_ISPOD };
    const korak = PONUDA.ZAOKRUZENJE_EUR;
    const sirovo = cijena > max ? (min + max) / 2 : Math.min(min + PONUDA.UDIO_RASPONA * (max - min), cijena);
    let ponuda = Math.round(sirovo / korak) * korak;
    if (ponuda > cijena) ponuda -= korak; // zaokruživanje nikad ne smije prijeći traženu cijenu
    return { ponuda_eur: ponuda, napomena: null };
  }

  const cijeliHr = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const predznak = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);

  // Tekst obrazloženja slaže se isključivo iz izračuna: polazište → korekcije → zbroj → raspon.
  function obrazlozenjeFer(iz) {
    const kor = iz.korekcije.length
      ? iz.korekcije.map((k) => `${predznak(k.postotak)}% ${k.razlog}`).join(', ')
      : 'bez korekcija';
    const ogranicen = iz.zbroj_posto !== iz.zbroj_primijenjen_posto
      ? ` (ograničen s ${predznak(iz.zbroj_posto)}% na ${predznak(iz.zbroj_primijenjen_posto)}%)` : '';
    // k.o.: "Polazište: medijan k.o. X …"; inače (grad) "Polazište: usklađeni medijan X …"; napomena = zašto nije k.o.
    const polaziste = iz.naziv && /^k\.o\. /.test(iz.naziv)
      ? `Polazište: medijan ${iz.naziv} (usklađen DZS indeksom) ${cijeliHr(iz.polaziste_m2)} €/m².`
      : `Polazište: usklađeni medijan${iz.naziv ? ` ${iz.naziv}` : ''} ${cijeliHr(iz.polaziste_m2)} €/m².${iz.napomena ? ` ${iz.napomena}` : ''}`;
    return `${polaziste} ` +
      `Korekcije: ${kor}; zbroj ${predznak(iz.zbroj_primijenjen_posto)}%${ogranicen}. ` +
      `Središnja ${cijeliHr(iz.sredina_m2)} €/m², raspon ±${iz.sirina_posto}%: ` +
      `${cijeliHr(iz.raspon_m2.min)}–${cijeliHr(iz.raspon_m2.max)} €/m².`;
  }

  // Zašto se pojedini izračun ne može napraviti (samo za ključeve koji su null). Prazno = nema razloga.
  function razloziIzracuna(a) {
    const cijena = pozitivan(a.cijena_eur);
    const m2 = pozitivan(a.povrsina_m2);
    const najam = pozitivan(a.najam.dugorocni_mj_eur);
    const turisticki = pozitivan(a.najam.turisticki_godisnje_eur);
    const fer = pozitivan(a.fer_vrijednost.min_eur) && pozitivan(a.fer_vrijednost.max_eur);
    const ponuda = izracunajPonudu(a.cijena_eur, a.fer_vrijednost.min_eur, a.fer_vrijednost.max_eur) !== null;
    const spoji = (nedostaje) => (nedostaje.length ? `nedostaje ${nedostaje.join(' i ')}` : null);
    const cijenaM2 = spoji([!cijena && 'cijena', !m2 && 'površina'].filter(Boolean));
    const prinos = !cijena ? 'nedostaje cijena' : !najam ? 'nema procjene najma' : null;
    return {
      cijena_po_m2: cijenaM2,
      fer_po_m2: !fer ? 'nema procjene fer vrijednosti' : !m2 ? 'nedostaje površina' : null,
      porez_na_promet: !cijena ? 'nedostaje cijena' : null,
      bruto_prinos: prinos,
      neto_prinos: prinos,
      godine_povrata: prinos,
      bruto_prinos_turisticki: !cijena ? 'nedostaje cijena' : !turisticki ? 'nema procjene turističkog najma' : null,
      usteda: !cijena ? 'nedostaje cijena' : !ponuda ? 'nema procjene fer vrijednosti' : null,
      traka: !cijena ? 'nedostaje cijena' : !fer ? 'nema procjene fer vrijednosti' : null,
    };
  }

  function izracunaj(a) {
    const cijena = pozitivan(a.cijena_eur) ? a.cijena_eur : null;
    const m2 = pozitivan(a.povrsina_m2) ? a.povrsina_m2 : null;
    const dug = pozitivan(a.najam.dugorocni_mj_eur) ? a.najam.dugorocni_mj_eur : null;
    const tur = pozitivan(a.najam.turisticki_godisnje_eur) ? a.najam.turisticki_godisnje_eur : null;
    const izFer = a.fer_vrijednost.izracun || null;
    const fMin = a.fer_vrijednost.min_eur;
    const fMax = a.fer_vrijednost.max_eur;
    const cilj = izracunajPonudu(cijena, fMin, fMax);
    const ponuda = cilj ? cilj.ponuda_eur : null;

    const najamGod = dug === null ? null : dug * 12;
    const netoGod = najamGod === null ? null : najamGod * (1 - TROSKOVI_NAJMA) * (1 - POREZ_NA_NAJAM);

    const usteda = cijena !== null && ponuda !== null && ponuda < cijena ? cijena - ponuda : null;

    // Traka s pozicijom tražene cijene: prikazuje se raspon [fer min − pola raspona, fer max + pola raspona].
    let traka = null;
    if (cijena !== null && fMin !== null && fMax !== null) {
      const pola = Math.max((fMax - fMin) / 2, fMax * 0.05);
      const od = Math.max(0, fMin - pola);
      const do_ = fMax + pola;
      const posto = (v) => Math.min(100, Math.max(0, ((v - od) / (do_ - od)) * 100));
      traka = {
        od_eur: zaokruzi(od),
        do_eur: zaokruzi(do_),
        fer_od_posto: zaokruzi(posto(fMin), 1),
        fer_do_posto: zaokruzi(posto(fMax), 1),
        cijena_posto: zaokruzi(posto(cijena), 1),
        polozaj: cijena < fMin ? 'ispod' : cijena > fMax ? 'iznad' : 'unutar',
      };
    }

    return {
      cijena_po_m2: cijena !== null && m2 !== null ? zaokruzi(cijena / m2) : null,
      // Kad je raspon izračunat iz korekcija, €/m² je onaj iz tog izračuna (isti brojevi kao u obrazloženju).
      fer_po_m2: izFer && fMin !== null && fMax !== null
        ? { min: izFer.raspon_m2.min, max: izFer.raspon_m2.max }
        : {
          min: fMin !== null && m2 !== null ? zaokruzi(fMin / m2) : null,
          max: fMax !== null && m2 !== null ? zaokruzi(fMax / m2) : null,
        },
      porez_na_promet: cijena !== null ? zaokruzi(cijena * POREZ_NA_PROMET) : null,
      najam_godisnje: zaokruzi(najamGod),
      bruto_prinos: cijena !== null && najamGod !== null ? zaokruzi((najamGod / cijena) * 100, 1) : null,
      neto_najam_godisnje: zaokruzi(netoGod),
      neto_prinos: cijena !== null && netoGod !== null ? zaokruzi((netoGod / cijena) * 100, 1) : null,
      godine_povrata: cijena !== null && netoGod !== null ? zaokruzi(cijena / netoGod, 1) : null,
      bruto_prinos_turisticki: cijena !== null && tur !== null ? zaokruzi((tur / cijena) * 100, 1) : null,
      ciljana_ponuda_eur: ponuda,
      ciljana_ponuda_napomena: cilj ? cilj.napomena : null,
      usteda_eur: zaokruzi(usteda),
      usteda_posto: usteda !== null ? zaokruzi((usteda / cijena) * 100, 1) : null,
      traka,
      razlozi: razloziIzracuna(a),
      pretpostavke: [
        `Neto prinos: najam umanjen za ${TROSKOVI_NAJMA * 100} % troškova (održavanje, pričuva, upravljanje) i ${POREZ_NA_NAJAM * 100} % poreza na najam.`,
        'Bruto prinos: dugoročni najam × 12 podijeljen s traženom cijenom; bez prazne najamnine i troškova kupnje.',
        'Godine povrata: tražena cijena podijeljena s neto godišnjim najmom, bez rasta cijena i najamnina.',
        `Porez na promet: ${POREZ_NA_PROMET * 100} % tražene cijene; ne plaća se na novogradnju na koju se obračunava PDV.`,
      ],
    };
  }

  return {
    TROSKOVI_NAJMA, POREZ_NA_NAJAM, POREZ_NA_PROMET, FER, PONUDA, GRANICE, izracunajPonudu, ocistiKorekcije, izracunajFer, obrazlozenjeFer, MAX_TEKST_POLJA,
    izracunaj, razloziIzracuna, parsirajCijenu, parsirajBroj, validirajPodatke, mozeAnaliza, primijeniPodatke,
  };
});
