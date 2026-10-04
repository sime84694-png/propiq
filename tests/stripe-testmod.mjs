// Provjera pristupa na PRAVOM Stripe test modu (opcija A).
// Radi isključivo s test ključem; s live ključem odbija pokretanje.
//
//   STRIPE_SECRET_KEY=sk_test_... node tests/stripe-testmod.mjs
//
// Što radi: napravi testni proizvod s cijenama Standard (24 €/mj) i Pro (49 €/mj),
// kupca s testnom karticom (pm_card_visa = 4242 4242 4242 4242), i prolazi scenarije:
// aktivna Standard → Pro → otkaz na kraju razdoblja (i dalje Pro) → trenutni otkaz (nema pristupa).
// Na kraju briše kupca i arhivira proizvod. Ništa ne dira live podatke.
import { createRequire } from 'node:module';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Treba STRIPE_SECRET_KEY u test modu (sk_test_…). Live ključ se ne koristi.');
  process.exit(1);
}

const auth = { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64') };
async function stripe(method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${body.error && body.error.message}`);
  return body;
}

const product = await stripe('POST', 'products', { name: 'PropIQ TEST (automatski test)' });
const std = await stripe('POST', 'prices', { product: product.id, currency: 'eur', unit_amount: '2400', 'recurring[interval]': 'month' });
const pro = await stripe('POST', 'prices', { product: product.id, currency: 'eur', unit_amount: '4900', 'recurring[interval]': 'month' });
process.env.STRIPE_PRICE_STANDARD = std.id;
process.env.STRIPE_PRICE_PRO = pro.id;
const { activePlanForEmail } = createRequire(import.meta.url)('../netlify/lib/stripe-plan.js');

const email = `propiq-test-${Date.now()}@example.com`;
const customer = await stripe('POST', 'customers', {
  // Mala slova: Stripeov Search (koji pokriva "Ana@Mail.hr") indeksira nove kupce s kašnjenjem
  // do ~1 min, pa bi test s velikim slovima ovisio o sreći. Taj slučaj pokriva tests/pretplata.test.js.
  email,
  payment_method: 'pm_card_visa',
  'invoice_settings[default_payment_method]': 'pm_card_visa',
});

const rezultati = [];
async function provjeri(opis, ocekivano) {
  const plan = await activePlanForEmail(email, key);
  const ok = plan === ocekivano;
  rezultati.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${opis}: plan=${plan ?? 'nema'} (očekivano ${ocekivano ?? 'nema'})`);
}

try {
  await provjeri('kupac bez pretplate', null);
  const sub = await stripe('POST', 'subscriptions', { customer: customer.id, 'items[0][price]': std.id });
  console.log(`  pretplata ${sub.id}: status ${sub.status}`);
  await provjeri('aktivna Standard', 'standard');
  await stripe('POST', `subscriptions/${sub.id}`, { 'items[0][id]': sub.items.data[0].id, 'items[0][price]': pro.id });
  await provjeri('nadogradnja na Pro', 'pro');
  await stripe('POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'true' });
  await provjeri('otkazano na kraju razdoblja (plaćeno razdoblje još traje)', 'pro');
  await stripe('DELETE', `subscriptions/${sub.id}`);
  await provjeri('otkazano odmah (canceled)', null);
} finally {
  await stripe('DELETE', `customers/${customer.id}`).catch(() => {});
  await stripe('POST', `products/${product.id}`, { active: 'false' }).catch(() => {});
}

const prosli = rezultati.filter(Boolean).length;
console.log(`\n${prosli}/${rezultati.length} scenarija prošlo.`);
process.exit(prosli === rezultati.length ? 0 : 1);
