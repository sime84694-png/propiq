// PropIQ — koji plan ima email, prema AKTIVNIM pretplatama na Stripeu.
// Koriste ga netlify/functions/analiza.js (pristup) i purchase-status.js (mjerenje).
//
// Pristup daje samo pretplata u statusu "active" ili "trialing". Otkazana (canceled),
// istekla (incomplete_expired), neplaćena (past_due, unpaid), pauzirana (paused) i
// nedovršena (incomplete) pretplata NE daju pristup. Pretplata otkazana "na kraju razdoblja"
// ostaje "active" do kraja plaćenog razdoblja — korisnik je to razdoblje platio.
//
// TODO(prije skaliranja oglasa): opcija B — prijava linkom na email (magic link).
// Sada plan ovisi samo o upisanom emailu: tko zna email plaćenog korisnika, može
// koristiti njegov plan. Magic link potvrđuje da je osoba vlasnik emaila.

// Price ID-jevi; u test modu postavi env STRIPE_PRICE_STANDARD / STRIPE_PRICE_PRO na test cijene.
const PRICE_STANDARD = process.env.STRIPE_PRICE_STANDARD || 'price_1UBFCYLx6rQfmJyZJR0AiqCR';
const PRICE_PRO = process.env.STRIPE_PRICE_PRO || 'price_1UBFDaLx6rQfmJyZEJFQLicR';

const PLAN_BY_PRICE = { [PRICE_STANDARD]: 'standard', [PRICE_PRO]: 'pro' };
const RANK = { standard: 1, pro: 2 };
const ACTIVE = new Set(['active', 'trialing']);

async function stripeGet(path, secretKey) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64') },
  });
  if (!res.ok) {
    const err = new Error(`Stripe ${res.status} za ${path.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Vraća 'pro' | 'standard' | null. Baca grešku ako Stripe nije dostupan.
async function activePlanForEmail(email, secretKey) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !secretKey) return null;

  // Stripe filter po emailu razlikuje velika i mala slova, a kupac je na checkoutu
  // mogao upisati "Ana@Mail.hr". Zato i Search (ne razlikuje), uz kašnjenje do ~1 min
  // za tek kreirane kupce — tada pomaže prvi, točni upit.
  const customers = new Map();
  const listed = await stripeGet(`customers?email=${encodeURIComponent(e)}&limit=20`, secretKey);
  (listed.data || []).forEach((c) => customers.set(c.id, c));
  try {
    const q = encodeURIComponent(`email:'${e.replace(/'/g, "\\'")}'`);
    const found = await stripeGet(`customers/search?query=${q}&limit=20`, secretKey);
    (found.data || []).forEach((c) => customers.set(c.id, c));
  } catch (err) {
    console.warn('Stripe customer search nije uspio, koristim samo točni upit:', err.message);
  }

  let best = null;
  for (const id of customers.keys()) {
    const subs = await stripeGet(`subscriptions?customer=${encodeURIComponent(id)}&status=all&limit=100`, secretKey);
    for (const s of subs.data || []) {
      if (!ACTIVE.has(s.status)) continue;
      for (const item of (s.items && s.items.data) || []) {
        const plan = PLAN_BY_PRICE[item.price && item.price.id];
        if (plan && (!best || RANK[plan] > RANK[best])) best = plan;
      }
    }
  }
  return best;
}

module.exports = { activePlanForEmail, stripeGet, PLAN_BY_PRICE };
