// PropIQ — proxy prema Claude API za analizu nekretnina (Netlify Functions API v2).
// Poziva se s POST-om iz rezultat.html. Greške prije početka analize (podaci, limit, Anthropic
// nedostupan) vraća kao JSON { error } s HTTP statusom. Samu analizu streama kao SSE
// (text/event-stream), jedan JSON po događaju:
//   data: {"tekst":"..."}                 — dio Markdowna, čim stigne od Claudea
//   data: {"kraj":true,"skraceno":false}  — uspješan kraj; limit i statistika su tada zapisani
//   data: {"greska":"..."}                — prekid usred analize; limit se ne troši
// API ključ NIKAD nije u kodu — čita se iz Netlify env varijable ANTHROPIC_API_KEY.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
// Plan (Standard/Pro) se određuje isključivo prema aktivnoj Stripe pretplati za upisani email.
import stripePlan from '../lib/stripe-plan.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SYSTEM_PROMPT = `Ti si PropIQ — AI investicijski savjetnik za hrvatsko tržište nekretnina.
Na temelju teksta oglasa izradi KONCIZNU analizu na hrvatskom: maksimalno 400–500 riječi, strukturirano ali sažeto.

Prvi redak izvještaja uvijek je točna lokacija u obliku:
**Lokacija:** grad/općina – kvart/naselje (županija)

Određivanje lokacije:
- Lokaciju odredi iz CIJELOG oglasa (naslov, lokacija, opis), ne samo iz naziva naselja.
- Mnoga hrvatska mjesta i kvartovi dijele isto ime (npr. Blato u Zagrebu i Blato na Korčuli, Brod, Sveti Petar, Gornji i Donji Grad). Ako se u oglasu spominje grad, županija ili okolni kvartovi, oni određuju koje je mjesto — nikad ne pretpostavljaj poznatije mjesto istog imena.
- Ako lokacija nije jednoznačna, napiši najvjerojatniju i u istom retku dodaj "(pretpostavka — provjerite lokaciju)".
- Cijela analiza (cijene po m², najam, potražnja) mora se odnositi na tu lokaciju.

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
async function incrementStats(source, plan) {
  try {
    const stats = getStore('propiq-stats');
    const key = `stats/${new Date().toISOString().slice(0, 7)}/${source}/${plan}`;
    const n = parseInt((await stats.get(key)) || '0', 10) || 0;
    await stats.set(key, String(n + 1));
  } catch (err) {
    console.error('Statistika nije zapisana:', err);
  }
}

// Isti zahtjev (request_id iz index.html) ponovljen zbog F5 dok analiza traje broji se u limitu
// samo jednom. Zapis čuva samo hash emaila, hash teksta oglasa, vrijeme i broj ponavljanja
// (bez emaila i bez same analize). Ponavljanje vrijedi samo za isti tekst, unutar 10 min i
// najviše 2 puta, da se isti request_id ne može koristiti za besplatne analize.
// Ključ: {hashEmaila}:{request_id}:{vrijeme nastanka}; zapisi stariji od 24 h brišu se pri svakom upisu.
const PONAVLJANJE_PROZOR_MS = 10 * 60 * 1000;
const PONAVLJANJE_MAX = 2;
const ZAHTJEVI_CUVANJE_MS = 24 * 60 * 60 * 1000;

// Sol: ZAHTJEVI_SALT, a bez nje ANTHROPIC_API_KEY (funkcija bez njega ionako ne radi).
function hashEmaila(email) {
  const sol = process.env.ZAHTJEVI_SALT || process.env.ANTHROPIC_API_KEY || '';
  return crypto.createHmac('sha256', sol).update(email).digest('hex');
}

const vrijemeKljuca = (key) => parseInt(key.slice(key.lastIndexOf(':') + 1), 10) || 0;

async function procitajZahtjev(store, prefix) {
  try {
    const { blobs } = await store.list({ prefix });
    const key = blobs.map((b) => b.key).sort((a, b) => vrijemeKljuca(b) - vrijemeKljuca(a))[0];
    if (!key) return null;
    return { ...JSON.parse((await store.get(key)) || '{}'), key, t: vrijemeKljuca(key) };
  } catch {
    return null;
  }
}

async function zapisiZahtjev(store, key, zapis) {
  await store.set(key, JSON.stringify({ h: zapis.h, d: zapis.d }));
  try {
    const granica = Date.now() - ZAHTJEVI_CUVANJE_MS;
    const { blobs } = await store.list();
    await Promise.all(blobs.filter((b) => vrijemeKljuca(b.key) < granica).map((b) => store.delete(b.key)));
  } catch (err) {
    console.error('Brisanje starih zapisa zahtjeva nije uspjelo:', err);
  }
}

function jePonavljanje(zapis, tekstHash) {
  return !!zapis && zapis.h === tekstHash &&
    Date.now() - zapis.t < PONAVLJANJE_PROZOR_MS && (zapis.d || 0) < PONAVLJANJE_MAX;
}

// Čita Anthropicov SSE stream; svaki komad teksta odmah predaje naTekst.
// Vraća cijeli tekst i stop_reason. Baca grešku ako stream pukne ili stigne bez message_stop.
async function procitajClaudeStream(body, naTekst) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let tekst = '';
  let stopReason = null;
  let zavrseno = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const podaci = buf.slice(0, i).split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      buf = buf.slice(i + 2);
      if (!podaci) continue;
      const ev = JSON.parse(podaci);
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        tekst += ev.delta.text;
        naTekst(ev.delta.text);
      } else if (ev.type === 'message_delta') {
        stopReason = (ev.delta && ev.delta.stop_reason) || stopReason;
      } else if (ev.type === 'message_stop') {
        zavrseno = true;
      } else if (ev.type === 'error') {
        throw new Error(`Anthropic stream greška: ${JSON.stringify(ev.error)}`);
      }
    }
  }
  if (!zavrseno) throw new Error('Anthropic stream je prekinut prije message_stop.');
  return { tekst, stopReason };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'Dozvoljen je samo POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Konfiguracija poslužitelja nije potpuna (nedostaje API ključ).' });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  let data;
  try {
    data = JSON.parse((await req.text()) || '{}');
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
    verificiraniPlan = await stripePlan.activePlanForEmail(email, stripeSecretKey);
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
  let zahtjevPrefix = '';
  let ponovljeno = false;
  if (/^[A-Za-z0-9-]{8,64}$/.test(requestId)) {
    zahtjevi = getStore('propiq-zahtjevi');
    zahtjevPrefix = `${hashEmaila(email)}:${requestId}:`;
    const zapis = await procitajZahtjev(zahtjevi, zahtjevPrefix);
    if (jePonavljanje(zapis, tekstHash)) {
      ponovljeno = true;
      await zapisiZahtjev(zahtjevi, zapis.key, { h: zapis.h, d: (zapis.d || 0) + 1 });
    }
  }

  if (jeStandard) {
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

  // Broji analizu u limit i statistiku — poziva se tek kad je stream uspješno završio.
  async function zabiljeziUspjeh() {
    // Paralelni poziv istog zahtjeva (F5 dok je prvi još trajao) koji je već izbrojan
    // također se ne broji ponovo.
    let izbrojati = !ponovljeno;
    if (izbrojati && zahtjevi) {
      const zapis = await procitajZahtjev(zahtjevi, zahtjevPrefix);
      if (jePonavljanje(zapis, tekstHash)) {
        izbrojati = false;
        await zapisiZahtjev(zahtjevi, zapis.key, { h: zapis.h, d: (zapis.d || 0) + 1 });
      } else {
        await zapisiZahtjev(zahtjevi, zahtjevPrefix + Date.now(), { h: tekstHash, d: 0 });
      }
    }

    if (izbrojati) {
      if (!jePro && store) {
        await store.set(quotaKey, String(trenutnoIskoristeno + 1));
      }
      await incrementStats(source, verificiraniPlan || 'free');
    }
  }

  const userMessage =
    `Podnositelj: ${ime || 'nepoznato'}` +
    (agencija ? ` (agencija: ${agencija})` : '') +
    `\n\nTekst oglasa nekretnine:\n"""\n${oglasTekst}\n"""`;

  // Prekini poziv prema Anthropicu (zajedno sa streamom) na 55 s da funkcija stigne
  // javiti jasnu poruku unutar Netlify 60 s limita, umjesto da bude "ubijena".
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1600,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err && err.name === 'AbortError') {
      console.error('Anthropic API timeout (55 s).');
      return json(504, { error: 'Analiza traje predugo. Pokušajte ponovo s kraćim tekstom oglasa.' });
    }
    console.error('Neočekivana greška pri pozivu Anthropic API-ja:', err);
    return json(500, { error: 'Došlo je do greške pri dohvaćanju analize. Pokušajte ponovo.' });
  }

  if (!res.ok) {
    clearTimeout(timeout);
    const detail = await res.text().catch(() => '');
    console.error('Anthropic API greška:', res.status, detail);
    return json(502, { error: 'Analiza trenutno nije dostupna. Pokušajte ponovo za koji trenutak.' });
  }

  const encoder = new TextEncoder();
  let preglednikOtisao = false;

  async function prenesi(ctrl) {
    const posalji = (dogadjaj) => {
      if (!preglednikOtisao) ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(dogadjaj)}\n\n`));
    };
    try {
      const { tekst, stopReason } = await procitajClaudeStream(res.body, (dio) => posalji({ tekst: dio }));
      if (!tekst.trim()) {
        posalji({ greska: 'Analiza je vraćena prazna. Pokušajte ponovo — ova analiza vam se ne broji u limit.' });
        return;
      }
      await zabiljeziUspjeh();
      posalji({ kraj: true, skraceno: stopReason === 'max_tokens' });
    } catch (err) {
      if (preglednikOtisao) return; // preglednik je zatvorio vezu (npr. F5) — ništa se ne broji
      const isteklo = err && err.name === 'AbortError';
      console.error(isteklo ? 'Anthropic API timeout (55 s).' : 'Stream analize je prekinut:', isteklo ? '' : err);
      posalji({
        greska: isteklo
          ? 'Analiza traje predugo. Pokušajte ponovo s kraćim tekstom oglasa — ova analiza vam se ne broji u limit.'
          : 'Veza je prekinuta prije kraja analize. Pokušajte ponovo — ova analiza vam se ne broji u limit.',
      });
    } finally {
      clearTimeout(timeout);
      try { ctrl.close(); } catch {}
    }
  }

  const body = new ReadableStream({
    start(ctrl) {
      prenesi(ctrl); // ne čeka se: Response se vraća odmah, a događaji teku kako stižu
    },
    cancel() {
      preglednikOtisao = true;
      controller.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
};
