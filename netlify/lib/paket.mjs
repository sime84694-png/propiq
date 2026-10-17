// PropIQ — Paket (jednokratna kupnja): 5 analiza, vrijedi 90 dana od kupnje.
// Kupnja se potvrđuje na poslužitelju preko Stripe Checkout sessiona (klijentu se ne vjeruje), a kredit
// se piše u Netlify Blobs po hashu emaila: ključ {hashEmaila}:{session_id}, vrijednost {kupljeno, istek, preostalo}.
// Isti session_id uvijek daje isti ključ pa se može iskoristiti samo jednom (i kad je kredit već potrošen).
// Više paketa = više zapisa; troši se onaj koji prvi istječe.

import { getStore } from '@netlify/blobs';
import cjenik from './cjenik.js';
import stripePlan from './stripe-plan.js';

const { PRICE_PAKET, LIMITI } = cjenik;
const DAN_MS = 24 * 60 * 60 * 1000;
export const SESSION_ID_FORMAT = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

const store = () => getStore('propiq-paketi');

// Aktivni krediti emaila (preostalo > 0 i nisu istekli), prvo onaj koji prvi istječe.
// `ikadaKupljen`: email ima barem jedan zapis o paketu (i potrošen ili istekao) — za jasniju poruku.
export async function krediti(hashEmaila) {
  const s = store();
  const { blobs } = await s.list({ prefix: `${hashEmaila}:` });
  const svi = [];
  for (const b of blobs) {
    try {
      const z = JSON.parse((await s.get(b.key)) || '{}');
      if (typeof z.istek === 'number') svi.push({ key: b.key, istek: z.istek, preostalo: z.preostalo || 0 });
    } catch { /* oštećen zapis se preskače */ }
  }
  const aktivni = svi.filter((k) => k.preostalo > 0 && k.istek > Date.now()).sort((a, b) => a.istek - b.istek);
  return { aktivni, ikadaKupljen: svi.length > 0 };
}

// Oduzima jednu analizu od zadanog kredita (poziva se tek nakon uspješnog koraka B).
export async function potrosiKredit(key) {
  const s = store();
  const z = JSON.parse((await s.get(key)) || '{}');
  if (!(z.preostalo > 0)) return;
  await s.set(key, JSON.stringify({ ...z, preostalo: z.preostalo - 1 }));
}

const maskiraj = (email) => email.replace(/^(.).*(@.*)$/, '$1***$2');

// Aktivira paket iz plaćene Checkout sesije. Vraća { status, body } (HTTP status i JSON za klijenta).
export async function aktivirajPaket(sessionId, stripeSecretKey, hashEmaila) {
  if (!SESSION_ID_FORMAT.test(sessionId)) return { status: 400, body: { error: 'Neispravan ID plaćanja.' } };
  if (!stripeSecretKey) return { status: 500, body: { error: 'Konfiguracija poslužitelja nije potpuna.' } };

  let sesija;
  try {
    sesija = await stripePlan.stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, stripeSecretKey);
  } catch (err) {
    if (err.status === 404 || err.status === 400) return { status: 404, body: { error: 'Plaćanje nije pronađeno.' } };
    console.error('Aktivacija paketa: Stripe nedostupan:', err.message);
    return { status: 503, body: { error: 'Trenutno ne možemo provjeriti plaćanje. Pokušajte ponovo za minutu ili nas kontaktirajte.' } };
  }

  const stavke = (sesija.line_items && sesija.line_items.data) || [];
  const paket = stavke.find((i) => i.price && i.price.id === PRICE_PAKET);
  if (sesija.mode !== 'payment' || !paket) return { status: 400, body: { error: 'Ovo plaćanje nije kupnja paketa.' } };
  if (sesija.payment_status !== 'paid') return { status: 402, body: { error: 'Plaćanje nije dovršeno.' } };

  const email = String((sesija.customer_details && sesija.customer_details.email) || sesija.customer_email || '').trim().toLowerCase();
  if (!email) return { status: 422, body: { error: 'Uz plaćanje nema email adrese. Javite nam se na kontakt email.' } };

  const kupljeno = (Number(sesija.created) || 0) * 1000;
  const istek = kupljeno + LIMITI.PAKET_DANA * DAN_MS;
  if (!kupljeno || istek <= Date.now()) return { status: 410, body: { error: `Paket je istekao (vrijedi ${LIMITI.PAKET_DANA} dana od kupnje).` } };

  const key = `${hashEmaila(email)}:${sessionId}`;
  const s = store();
  if (await s.get(key)) {
    return { status: 409, body: { error: 'Ovaj paket je već aktiviran.', email_maskiran: maskiraj(email) } };
  }
  const preostalo = LIMITI.PAKET_ANALIZA * Math.max(1, Number(paket.quantity) || 1);
  await s.set(key, JSON.stringify({ kupljeno, istek, preostalo }));
  return { status: 200, body: { ok: true, email, preostalo, istek: new Date(istek).toISOString() } };
}
