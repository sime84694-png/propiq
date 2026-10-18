// PropIQ — zaštita od zloupotrebe: CORS, IP klijenta, rate limit po IP-u i atomično ažuriranje zapisa u Blobsu.
// Netlify code-based rate limiting (config.rateLimit) ne može izraziti satni limit: prozor je najviše 180 s,
// traži `path` u konfiguraciji, a limite funkcija nije moguće postaviti u netlify.toml. Zato se satni limit
// broji u Blobsu po hashu IP adrese (hash izračunava pozivatelj, ovdje se čuva samo on).

import { getStore } from '@netlify/blobs';

// ── CORS ──
const DOZVOLJENI_ORIGINI = new Set(['https://propiq-hr.netlify.app', 'http://localhost:8888']);
const DEPLOY_PREVIEW = /^https:\/\/deploy-preview-\d+--propiq-hr\.netlify\.app$/;

export const dopustenOrigin = (origin) => !!origin && (DOZVOLJENI_ORIGINI.has(origin) || DEPLOY_PREVIEW.test(origin));

// Zaglavlja CORS-a samo za dopušteni origin; za ostale (i za zahtjeve bez Origina) nema Allow-Origin.
export function corsZaglavlja(origin) {
  const h = { Vary: 'Origin' };
  if (dopustenOrigin(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return h;
}

// ── IP klijenta ──
// Samo ono što postavlja Netlify (context.ip, x-nf-client-connection-ip); X-Forwarded-For šalje klijent pa mu se ne vjeruje.
export function ipKlijenta(req, context) {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || '';
  return String(ip).trim() || 'nepoznat';
}

// ── Blobs: jaka konzistentnost i atomično ažuriranje ──
export const jakiStore = (name) => getStore({ name, consistency: 'strong' });

const pauza = () => new Promise((r) => setTimeout(r, 5 + Math.random() * 20));

// Čita zapis, daje ga funkciji `izmijeni(trenutni | null)` i upisuje rezultat samo ako se zapis u međuvremenu nije promijenio
// (ETag; za novi zapis onlyIfNew). Kod sukoba ponavlja. `izmijeni` vraća { nova, rezultat } ili undefined (odbij, bez upisa).
export async function azurirajCas(store, key, izmijeni) {
  for (let pokusaj = 0; pokusaj < 10; pokusaj++) {
    const trenutni = await store.getWithMetadata(key);
    const odluka = izmijeni(trenutni ? trenutni.data : null);
    if (odluka === undefined) return { ok: false };
    const uvjet = trenutni ? { onlyIfMatch: trenutni.etag } : { onlyIfNew: true };
    const upis = await store.set(key, odluka.nova, uvjet);
    if (upis && upis.modified === false) { await pauza(); continue; }
    return { ok: true, rezultat: odluka.rezultat };
  }
  throw new Error(`Istovremeni upisi: zapis ${key} nije ažuriran.`);
}

// Brojač (cijeli broj kao tekst) do `max`: povećaj ako je ispod granice. Vraća true ako je mjesto rezervirano.
export async function rezervirajBrojac(store, key, max) {
  const r = await azurirajCas(store, key, (v) => {
    const n = parseInt(v || '0', 10) || 0;
    return n >= max ? undefined : { nova: String(n + 1), rezultat: true };
  });
  return r.ok;
}

// Vraća jedno rezervirano mjesto (nikad ispod nule).
export async function vratiBrojac(store, key) {
  await azurirajCas(store, key, (v) => {
    const n = parseInt(v || '0', 10) || 0;
    return n > 0 ? { nova: String(n - 1), rezultat: true } : undefined;
  });
}

// ── Rate limit po IP-u (fiksni satni prozor) ──
// start: pokretanja analize (korak procjena); koraci: svi zahtjevi prema funkciji; paket: aktivacije paketa.
// Koraci: 10 analiza × (procjena + rizici + cijena) × najviše 2 pokušaja = 60.
export const SATNI_LIMITI = { start: 10, koraci: 60, paket: 10 };
const SAT_MS = 60 * 60 * 1000;

// Troši jedan zahtjev iz limita. Vraća { ok: true } ili { ok: false, ponovnoZaS }.
// Odbijeni zahtjev ništa ne upisuje. Baca grešku ako Blobs nije dostupan (pozivatelj odbija zahtjev).
export async function potrosiLimitIp(ipHash, vrsta, max = SATNI_LIMITI[vrsta], sada = Date.now()) {
  const store = jakiStore('propiq-ratelimit');
  const prozor = Math.floor(sada / SAT_MS);
  const key = `${ipHash}:${vrsta}:${prozor}`;
  const r = await azurirajCas(store, key, (v) => {
    const n = parseInt(v || '0', 10) || 0;
    return n >= max ? undefined : { nova: String(n + 1), rezultat: n + 1 };
  });
  if (!r.ok) return { ok: false, ponovnoZaS: Math.max(1, Math.ceil(((prozor + 1) * SAT_MS - sada) / 1000)) };
  if (r.rezultat === 1) {
    // Prvi zahtjev u novom prozoru: obriši prozore iste IP adrese i vrste koji su prošli (ne smije srušiti zahtjev).
    try {
      const { blobs } = await store.list({ prefix: `${ipHash}:${vrsta}:` });
      await Promise.all(blobs.filter((b) => b.key !== key).map((b) => store.delete(b.key)));
    } catch (err) {
      console.error('Čišćenje starih rate limit zapisa nije uspjelo:', err);
    }
  }
  return { ok: true };
}

export const porukaRateLimita = (ponovnoZaS) =>
  `Previše zahtjeva s tvoje adrese. Pokušaj ponovo za ${Math.ceil(ponovnoZaS / 60)} min.`;
