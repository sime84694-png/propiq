// PropIQ — samo za mjerenje: je li Stripe Checkout sesija plaćena i koliko.
// GET /.netlify/functions/purchase-status?session_id=cs_...
// Vraća { paid: true, value, currency, plan } ili { paid: false }.
// Samo ČITA sesiju sa Stripea (isti poziv kao u analiza.js); ne mijenja ništa u plaćanju ni pristupu.

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// Isti Price ID-jevi kao u analiza.js.
const PLANS = {
  price_1UBFCYLx6rQfmJyZJR0AiqCR: 'standard',
  price_1UBFDaLx6rQfmJyZEJFQLicR: 'pro',
};

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
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${stripeSecretKey}:`).toString('base64') } }
    );
    if (!res.ok) {
      return json(404, { paid: false });
    }
    const s = await res.json();
    if (s.payment_status !== 'paid') {
      return json(200, { paid: false });
    }
    const priceId = s.line_items && s.line_items.data && s.line_items.data[0] ? s.line_items.data[0].price.id : null;
    return json(200, {
      paid: true,
      value: (s.amount_total || 0) / 100,
      currency: (s.currency || 'eur').toUpperCase(),
      plan: PLANS[priceId] || 'unknown',
    });
  } catch (err) {
    console.error('purchase-status: greška pri čitanju Stripe sesije:', err);
    return json(500, { paid: false });
  }
};
