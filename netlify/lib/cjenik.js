// PropIQ — cjenik na jednom mjestu: Stripe Price ID-jevi, linkovi za plaćanje i ograničenja planova.
// Cijene na stranici (public/index.html) i u uvjetima moraju odgovarati ovome; tests/statika.test.mjs to provjerava.
// U test modu postavi env STRIPE_PRICE_PAKET / STRIPE_PRICE_STANDARD / STRIPE_PRICE_PRO na test cijene.

const PRICE_PAKET = process.env.STRIPE_PRICE_PAKET || 'price_1UONNHLx6rQfmJyZv7s1iuSn';
const PRICE_STANDARD = process.env.STRIPE_PRICE_STANDARD || 'price_1UONK9Lx6rQfmJyZGArrzyS3';
const PRICE_PRO = process.env.STRIPE_PRICE_PRO || 'price_1UONKuLx6rQfmJyZuNHrB4Fa';
// Stari Price ID-jevi: i dalje vrijede za postojeće pretplatnike.
const PRICE_STANDARD_STARI = 'price_1UBFCYLx6rQfmJyZJR0AiqCR';
const PRICE_PRO_STARI = 'price_1UBFDaLx6rQfmJyZEJFQLicR';

// Pretplate (daju plan dok su aktivne).
const PLAN_BY_PRICE = {
  [PRICE_STANDARD]: 'standard',
  [PRICE_STANDARD_STARI]: 'standard',
  [PRICE_PRO]: 'pro',
  [PRICE_PRO_STARI]: 'pro',
};
// Jednokratna kupnja: i ona se mjeri kao plan 'paket' (purchase-status), ali daje kredit, ne pretplatu.
const PLAN_BY_PRICE_SVE = { ...PLAN_BY_PRICE, [PRICE_PAKET]: 'paket' };

const LINKOVI = {
  paket: 'https://buy.stripe.com/6oU6oI5WtgLFf9aaQqbwk02',
  standard: 'https://buy.stripe.com/8x27sMfx38f9f9a2jUbwk03',
  pro: 'https://buy.stripe.com/fZueVe0C9gLFf9af6Gbwk04',
};

const LIMITI = {
  FREE_UKUPNO: 3,
  PAKET_ANALIZA: 5,
  PAKET_DANA: 90,
  STANDARD_MJESECNO: 10,
};

module.exports = { PRICE_PAKET, PRICE_STANDARD, PRICE_PRO, PRICE_STANDARD_STARI, PRICE_PRO_STARI, PLAN_BY_PRICE, PLAN_BY_PRICE_SVE, LINKOVI, LIMITI };
