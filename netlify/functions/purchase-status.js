// PropIQ — samo za mjerenje: je li Stripe Checkout sesija plaćena i koliko.
// GET /.netlify/functions/purchase-status?session_id=cs_...
// Vraća { paid: true, value, currency, plan } ili { paid: false }.
// Samo ČITA sesiju sa Stripea; ne mijenja ništa u plaćanju ni pristupu (pristup daje aktivna pretplata, vidi netlify/lib/stripe-plan.js).

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const { stripeGet, PLAN_BY_PRICE } = require('../lib/stripe-plan');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Dozvoljen je samo GET.' });
  }

  const sessionId = ((event.queryStringParameters || {}).session_id || '').trim();
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) {
    return json(400, { paid: false });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return json(500, { paid: false });
  }

  try {
    let s;
    try {
      s = await stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, stripeSecretKey);
    } catch (err) {
      return json(404, { paid: false });
    }
    if (s.payment_status !== 'paid') {
      return json(200, { paid: false });
    }
    const priceId = s.line_items && s.line_items.data && s.line_items.data[0] ? s.line_items.data[0].price.id : null;
    return json(200, {
      paid: true,
      value: (s.amount_total || 0) / 100,
      currency: (s.currency || 'eur').toUpperCase(),
      plan: PLAN_BY_PRICE[priceId] || 'unknown',
    });
  } catch (err) {
    console.error('purchase-status: greška pri čitanju Stripe sesije:', err);
    return json(500, { paid: false });
  }
};
