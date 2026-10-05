# PropIQ

Statična stranica (Netlify) s funkcijama u `netlify/functions/`.

## Testovi

Testovi su u `tests/`.

```bash
npm install
node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'
```

`tests/pretplata.test.mjs` provjerava pristup plaćenom planu (aktivna Stripe pretplata po emailu) i stream analize.
Stripe, Anthropic i Netlify Blobs su lažirani, pa ne trebaju ključevi i ništa se ne troši.

Provjera na pravom Stripe **test** modu (s live ključem odbija pokretanje):

```bash
STRIPE_SECRET_KEY=sk_test_... node tests/stripe-testmod.mjs
```

Napravi testni proizvod i kupca, prođe scenarije pretplate i na kraju sve počisti.
