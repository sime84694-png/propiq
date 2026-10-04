// PropIQ — proxy prema Claude API za analizu nekretnina.
// Poziva se s POST-om iz rezultat.html; vraća { analiza: "...markdown..." }.
// API ključ NIKAD nije u kodu — čita se iz Netlify env varijable ANTHROPIC_API_KEY.

const crypto = require('node:crypto');
const { connectLambda, getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Plan (Standard/Pro) se određuje isključivo prema aktivnoj Stripe pretplati za upisani email.
const { activePlanForEmail } = require('../lib/stripe-plan');

const SYSTEM_PROMPT = `Ti si PropIQ — AI investicijski savjetnik za hrvatsko tržište nekretnina.
Na temelju teksta oglasa izradi KONCIZNU analizu na hrvatskom: maksimalno 400–500 riječi, strukturirano ali sažeto.

Koristi Markdown naslove i kratke liste, obavezno ove 4 cjeline:
1. **Procjena vrijednosti** — realan raspon i je li tražena cijena precijenjena, poštena ili prilika.
2. **Tržišni kontekst** — lokacija, tip nekretnine, pozicioniranje na hrvatskom tržištu.
3. **Investicijska preporuka** — isplativost, potencijalni ROI/najam ako je primjenjivo, ključni rizici.
4. **Preporuke** — 3–5 konkretnih idućih koraka.

Pravila:
- Piši isključivo na hrvatskom, profesionalno i jasno. Bez uvodnih fraza ("Evo analize"), bez ponavljanja.
- Kratke rečenice, natuknice gdje god ide. Cilj je brz, čitljiv sažetak, ne esej.
- Ako nedostaju ključni podaci (cijena, kvadratura), kratko naznači pretpostavku.
- Ne izmišljaj precizne brojke kao činjenice — koristi raspone i naznači da je procjena.`;

// Brojač uspješnih analiza po mjesecu/izvoru/planu: stats/YYYY-MM/{source}/{plan}.
// Ne smije nikad srušiti analizu — greške se samo logiraju.
// (Read-modify-write nije atomičan; kod istovremenih zahtjeva može izgubiti pokoji +1.)
async function incrementStats(event, source, plan) {
  try {
    connectLambda(event);
    const stats = getStore('propiq-stats');
    const key = `stats/${new Date().toISOString().slice(0, 7)}/${source}/${plan}`;
    const n = parseInt((await stats.get(key)) || '0', 10) || 0;
    await stats.set(key, String(n + 1));
  } catch (err) {
    console.error('Statistika nije zapisana:', err);
  }
}

// Isti zahtjev (request_id iz index.html) ponovljen zbog F5 dok analiza traje broji se u limitu
// samo jednom. Zapis po emailu + request_id čuva samo hash teksta oglasa, vrijeme i broj ponavljanja
// (bez same analize). Ponavljanje vrijedi samo za isti tekst, unutar 10 min i najviše 2 puta,
// da se isti request_id ne može koristiti za besplatne analize.
const PONAVLJANJE_PROZOR_MS = 10 * 60 * 1000;
const PONAVLJANJE_MAX = 2;

async function procitajZahtjev(store, key) {
  try {
    return JSON.parse((await store.get(key)) || 'null');
  } catch {
    return null;
  }
}

function jePonavljanje(zapis, tekstHash) {
  return !!zapis && zapis.h === tekstHash &&
    Date.now() - zapis.t < PONAVLJANJE_PROZOR_MS && (zapis.d || 0) < PONAVLJANJE_MAX;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Dozvoljen je samo POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Konfiguracija poslužitelja nije potpuna (nedostaje API ključ).' });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Neispravan JSON u zahtjevu.' });
  }

  const ime = (data.ime || '').toString().trim();
  const agencija = (data.agencija || '').toString().trim();
  const oglasTekst = (data.oglas_tekst || '').toString().trim();
  const email = (data.email || '').toString().trim().toLowerCase();
  // Izvor posjeta (?src= / referrer) — samo za statistiku, nikad ne utječe na analizu.
  const source =
    (data.source || '').toString().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) ||
    'unknown';

  if (!oglasTekst) {
    return json(400, { error: 'Nedostaje tekst oglasa za analizu.' });
  }

  if (!email) {
    return json(400, { error: 'Nedostaje email adresa.' });
  }

  // Plan se NE čita iz URL-a (?plan=, session_id) — samo iz aktivne pretplate na Stripeu
  // za upisani email. Ako Stripe nije dostupan, korisnik se privremeno tretira kao besplatni.
  let verificiraniPlan = null;
  let stripeNedostupan = false;
  try {
    verificiraniPlan = await activePlanForEmail(email, stripeSecretKey);
  } catch (err) {
    stripeNedostupan = true;
    console.error('Provjera pretplate na Stripeu nije uspjela:', err.message);
  }

  // Free: max 3 analize ukupno po emailu. Standard: max 10 mjesečno (reset svaki mjesec).
  // Pro: neograničeno, bez brojača.
  const jePro = verificiraniPlan === 'pro';
  const jeStandard = verificiraniPlan === 'standard';
  let store;
  let trenutnoIskoristeno = 0;
  let quotaKey = '';

  const requestId = String(data.request_id || '');
  const tekstHash = crypto.createHash('sha256').update(oglasTekst).digest('hex');
  let zahtjevi = null;
  let zahtjevKey = '';
  let ponovljeno = false;
  if (/^[A-Za-z0-9-]{8,64}$/.test(requestId)) {
    connectLambda(event);
    zahtjevi = getStore('propiq-zahtjevi');
    zahtjevKey = `${email}:${requestId}`;
    const zapis = await procitajZahtjev(zahtjevi, zahtjevKey);
    if (jePonavljanje(zapis, tekstHash)) {
      ponovljeno = true;
      await zahtjevi.set(zahtjevKey, JSON.stringify({ ...zapis, d: (zapis.d || 0) + 1 }));
    }
  }

  if (jeStandard) {
    connectLambda(event);
    store = getStore('propiq-standard-quota');
    const mjesec = new Date().toISOString().slice(0, 7); // npr. "2026-09"
    quotaKey = `${email}:${mjesec}`;
    trenutnoIskoristeno = parseInt((await store.get(quotaKey)) || '0', 10);
    if (!ponovljeno && trenutnoIskoristeno >= 10) {
      return json(403, {
        error: 'Iskoristili ste svih 10 analiza za ovaj mjesec u Standard planu. Nadogradite na Pro za neograničene analize, ili pričekajte sljedeći obračunski ciklus.',
      });
    }
  } else if (!jePro) {
    connectLambda(event);
    store = getStore('propiq-free-quota');
    quotaKey = email;
    trenutnoIskoristeno = parseInt((await store.get(quotaKey)) || '0', 10);
    if (!ponovljeno && trenutnoIskoristeno >= 3) {
      if (stripeNedostupan) {
        return json(503, {
          error: 'Trenutno ne možemo provjeriti vašu pretplatu. Pokušajte ponovo za minutu ili nas kontaktirajte na sime.zubcic23@gmail.com.',
        });
      }
      return json(403, {
        error: 'Iskoristili ste sve 3 besplatne analize. Ako ste platili Standard ili Pro, upišite email s kojim ste platili. Inače nadogradite plan za daljnje analize.',
      });
    }
  }

  const userMessage =
    `Podnositelj: ${ime || 'nepoznato'}` +
    (agencija ? ` (agencija: ${agencija})` : '') +
    `\n\nTekst oglasa nekretnine:\n"""\n${oglasTekst}\n"""`;

  // Prekini poziv prema Anthropicu na 55 s da funkcija stigne vratiti
  // jasnu poruku unutar Netlify 60 s limita, umjesto da bude "ubijena".
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic API greška:', res.status, detail);
      return json(502, { error: 'Analiza trenutno nije dostupna. Pokušajte ponovo za koji trenutak.' });
    }

    const payload = await res.json();
    const analiza = (payload.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!analiza) {
      return json(502, { error: 'Analiza je vraćena prazna. Pokušajte ponovo.' });
    }

    // Paralelni poziv istog zahtjeva (F5 dok je prvi još trajao) koji je već izbrojan
    // također se ne broji ponovo.
    let izbrojati = !ponovljeno;
    if (izbrojati && zahtjevi) {
      const zapis = await procitajZahtjev(zahtjevi, zahtjevKey);
      if (jePonavljanje(zapis, tekstHash)) {
        izbrojati = false;
        await zahtjevi.set(zahtjevKey, JSON.stringify({ ...zapis, d: (zapis.d || 0) + 1 }));
      } else {
        await zahtjevi.set(zahtjevKey, JSON.stringify({ h: tekstHash, t: Date.now(), d: 0 }));
      }
    }

    if (izbrojati) {
      if (!jePro && store) {
        await store.set(quotaKey, String(trenutnoIskoristeno + 1));
      }
      await incrementStats(event, source, verificiraniPlan || 'free');
    }

    return json(200, { analiza });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error('Anthropic API timeout (55 s).');
      return json(504, { error: 'Analiza traje predugo. Pokušajte ponovo s kraćim tekstom oglasa.' });
    }
    console.error('Neočekivana greška pri pozivu Anthropic API-ja:', err);
    return json(500, { error: 'Došlo je do greške pri dohvaćanju analize. Pokušajte ponovo.' });
  } finally {
    clearTimeout(timeout);
  }
};
