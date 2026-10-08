// Provjere statičkih datoteka i netlify.toml: što je javno objavljeno (publish = "public"),
// sigurnosna zaglavlja/CSP te pinirani i sanitizirani vanjski skriptovi.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const javno = (...p) => path.join(root, 'public', ...p);

function datoteke(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? datoteke(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

// ── V8 ──
test('netlify.toml objavljuje samo public/, a funkcije ostaju u netlify/functions', () => {
  assert.match(toml, /\[build\][^[]*publish\s*=\s*"public"/);
  assert.match(toml, /\[functions\][^[]*directory\s*=\s*"netlify\/functions"/);
  assert.ok(fs.existsSync(path.join(root, 'netlify/functions/analiza.mjs')));
});

test('public/ sadrži stranice i resurse, ali ne kod, testove ni konfiguraciju', () => {
  for (const f of ['index.html', 'rezultat.html', 'thank-you.html', '404.html', 'robots.txt', 'sitemap.xml',
    'assets/js/consent.js', 'assets/js/tracking-config.js']) {
    assert.ok(fs.existsSync(javno(f)), `public/${f} postoji`);
  }
  const sve = datoteke(javno()).map((f) => path.relative(javno(), f));
  const zabranjeno = sve.filter((f) => /^(netlify|tests|node_modules)\//.test(f) ||
    /(^|\/)(CLAUDE\.md|package(-lock)?\.json|netlify\.toml|\.env.*)$/.test(f) || /\.mjs$/.test(f));
  assert.deepEqual(zabranjeno, []);
});

test('stranice ne ostaju u korijenu repozitorija (ne smiju se objaviti)', () => {
  for (const f of ['index.html', 'rezultat.html', 'thank-you.html', '404.html']) {
    assert.ok(!fs.existsSync(path.join(root, f)), `${f} nije u korijenu`);
  }
});

// ── V9 ──
const csp = (toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/) || [])[1] || '';
const direktiva = (ime) => ((csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${ime} `))) || '').split(/\s+/).slice(1);

test('netlify.toml postavlja sigurnosna zaglavlja za sve putanje', () => {
  assert.match(toml, /\[\[headers\]\][^[]*for\s*=\s*"\/\*"/);
  for (const h of ['Content-Security-Policy', 'X-Content-Type-Options = "nosniff"', 'Referrer-Policy']) {
    assert.ok(toml.includes(h), h);
  }
  assert.deepEqual(direktiva('frame-ancestors'), ["'none'"]);
  assert.deepEqual(direktiva('object-src'), ["'none'"]);
  assert.deepEqual(direktiva('base-uri'), ["'self'"]);
});

// Domena `host` je pokrivena popisom izvora ako je izravno navedena ili preko *.zadnja-dva-dijela.
function pokriveno(host, izvori) {
  return izvori.some((i) => {
    const h = i.replace(/^https:\/\//, '');
    return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)));
  });
}

test('CSP dopušta sve vanjske izvore koje stranice stvarno koriste', () => {
  const zahtjevi = [
    ['script-src', 'static.cloudflareinsights.com'],
    ['script-src', 'www.googletagmanager.com'],
    ['script-src', 'connect.facebook.net'],
    ['connect-src', 'formspree.io'],
    ['connect-src', 'cloudflareinsights.com'],
    ['connect-src', 'region1.google-analytics.com'],
    ['img-src', 'www.facebook.com'],
  ];
  for (const [dir, host] of zahtjevi) assert.ok(pokriveno(host, direktiva(dir)), `${dir} → ${host}`);
  assert.ok(direktiva('script-src').includes("'self'") && direktiva('script-src').includes("'unsafe-inline'"),
    'inline skripte na stranicama traže unsafe-inline');
  assert.ok(direktiva('style-src').includes("'unsafe-inline'"));
  assert.ok(direktiva('img-src').includes('data:'));
});

test('svaki <script src> i fetch() na stranicama ima domenu koju CSP dopušta', () => {
  const html = datoteke(javno()).filter((f) => /\.(html|js)$/.test(f));
  const kriva = [];
  for (const f of html) {
    const kod = fs.readFileSync(f, 'utf8');
    for (const m of kod.matchAll(/<script[^>]+src=['"](https:\/\/[^'"]+)['"]/g)) {
      if (!pokriveno(new URL(m[1]).hostname, direktiva('script-src'))) kriva.push(`${path.basename(f)}: ${m[1]}`);
    }
    for (const m of kod.matchAll(/\.src\s*=\s*['"](https:\/\/[^'"?]+)/g)) {
      if (!pokriveno(new URL(m[1]).hostname, direktiva('script-src'))) kriva.push(`${path.basename(f)}: ${m[1]}`);
    }
    for (const m of kod.matchAll(/fetch\(\s*['"](https:\/\/[^'"]+)['"]/g)) {
      if (!pokriveno(new URL(m[1]).hostname, direktiva('connect-src'))) kriva.push(`${path.basename(f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(kriva, []);
});

// ── K3 + K4 ──
// Izvještaj se gradi iz strukturiranih podataka kroz textContent, pa nepouzdan tekst modela
// ne može umetnuti HTML. Zato rezultat.html ne treba (i ne smije učitavati) vanjske skripte.
test('rezultat.html: izvještaj se gradi kroz textContent, bez innerHTML i bez vanjskih skripti', () => {
  const html = fs.readFileSync(javno('rezultat.html'), 'utf8');
  const skripta = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!/\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b|document\.write/.test(skripta));
  assert.ok(!/marked|DOMPurify/.test(skripta));
  const vanjske = [...html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/g)].map((m) => new URL(m[1]).hostname);
  assert.deepEqual(vanjske, ['static.cloudflareinsights.com'], 'samo Cloudflare Web Analytics');
});

// ── V2 (forma) ──
test('index.html: polja forme imaju maxlength jednak ograničenjima na poslužitelju', () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'netlify/functions/analiza.mjs'), 'utf8');
  const lim = (n) => Number(src.match(new RegExp(`const ${n} = (\\d+);`))[1]);
  const maxlength = (id) => Number(html.match(new RegExp(`id="${id}"[^>]*maxlength="(\\d+)"`))[1]);
  assert.ok(!/id="ime"|id="agencija"/.test(html), 'forma više ne traži ime ni agenciju');
  assert.equal(maxlength('email'), lim('MAX_EMAIL'));
  assert.equal(maxlength('oglas_tekst'), lim('MAX_OGLAS'));
});

// ── tvrdnje na stranici moraju odgovarati proizvodu ──
test('index.html: nema tvrdnji koje proizvod ne ispunjava (par sekundi, instant, integracija, brendiranje, trendovi)', () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  for (const zabranjeno of [/par sekundi/i, /instant/i, /Njuškalo integracija/, /poznaje hrvatsko tržište/i, /znanja AI modela/i, /[Bb]rendiran/, /tržišn\w+ prosjek/, /kupi, pregovaraj ili preskoči/, /ROI kalkulator/]) {
    assert.ok(!zabranjeno.test(html), `index.html ne smije sadržavati ${zabranjeno}`);
  }
  assert.match(html, /oko pola minute/);
  assert.match(html, /stvarno plaćenih cijena/);
});

// ── cjenik na stranici = cjenik u kodu; samo istina ──
test('index.html: četiri kartice (Free / Paket / Standard / Pro) s cijenama i Stripe linkovima iz netlify/lib/cjenik.js', async () => {
  const { default: cjenik } = await import('../netlify/lib/cjenik.js');
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  const kartice = [...html.matchAll(/<div class="plan-tier">(\w+)<\/div>\s*<div class="plan-price-wrap">\s*<div class="plan-price">([\d,]+)<sup>€<\/sup>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(kartice, [['Free', '0'], ['Paket', '12'], ['Standard', '24,99'], ['Pro', '49,99']]);
  for (const [plan, link] of Object.entries(cjenik.LINKOVI)) assert.ok(html.includes(`href="${link}"`), `link za ${plan}`);
  assert.ok(!/buy\.stripe\.com\/(9B69AU4Sp3YT2moaQqbwk00|7sY3cw2Kh671e56gaKbwk01)/.test(html), 'stari linkovi su maknuti');
  assert.match(html, /5 analiza/); assert.match(html, /Vrijedi 90 dana od kupnje/); assert.match(html, /Bez pretplate/);
  assert.deepEqual(cjenik.LIMITI, { FREE_UKUPNO: 3, PAKET_ANALIZA: 5, PAKET_DANA: 90, STANDARD_MJESECNO: 10 });
});

test('index.html: planovi se razlikuju samo po broju analiza (+ prioritetna podrška na Pro)', () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  const cijene = html.slice(html.indexOf('id="cijene"'), html.indexOf('id="faq"'));
  for (const laz of ['Puna dubina analize', 'Osnovna tržišna izvješća', 'Web izvješće', 'PDF export']) assert.ok(!cijene.includes(laz), laz);
  assert.equal((cijene.match(/Puni izvještaj/g) || []).length, 4);
  assert.equal((cijene.match(/Spremi kao PDF \(ispis\)/g) || []).length, 4);
  assert.equal((cijene.match(/Prioritetna podrška/g) || []).length, 1);
  assert.match(cijene, /Neograničeno uz razumnu uporabu/);
});

test('index.html: primjer analize je označen kao primjer i odgovara izračunu (Središće, 130,45 m²)', async () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  const primjer = html.slice(html.indexOf('id="primjer"'), html.indexOf('id="analiza"'));
  assert.match(primjer, /Primjer analize/);
  for (const t of ['Zagreb, Središće, 130,45 m²', '694.896 €', '410.000', '470.000 €', '3.142', '3.614 €/m²', 'OPREZ', '1/10', 'Zaprudski Otok', '3.345 €/m²', 'MPGI/DZS', '440.000 €']) assert.ok(primjer.includes(t), t);
  for (const k of ['+8 %', '−7 %', '+4 %', '+2 %', '−4 %', '−2 %']) assert.ok(primjer.includes(k), k);
  // isti brojevi iz zajedničkog koda
  const { default: z } = await import('../public/assets/js/izracuni.js');
  const kor = [8, -7, 4, 2, -4, -2].map((postotak, i) => ({ razlog: `k${i}`, postotak }));
  const fer = z.izracunajFer({ medijan_eur_m2: 3345, korekcije: kor, pouzdanost: 'srednja', povrsina_m2: 130.45, naziv: 'k.o. Zaprudski Otok' });
  assert.deepEqual([fer.min_eur, fer.max_eur, fer.izracun.raspon_m2.min, fer.izracun.raspon_m2.max], [410000, 470000, 3142, 3614]);
  assert.equal(z.izracunajPonudu(694896, fer.min_eur, fer.max_eur).ponuda_eur, 440000);
});

test('index.html: meta keywords bez "tržišni trendovi", nema mrtvog koda detectRecommendation, trajanje bez točne brojke', () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  assert.ok(!/<meta name="keywords"[^>]*tržišni trendovi/.test(html));
  assert.ok(!html.includes('detectRecommendation'));
  assert.ok(!/27 s(ekund)?/.test(html));
  assert.match(html, /obično stiže za oko pola minute/);
});

test('uvjeti korištenja: Paket (90 dana, neiskorištene propadaju) i razumna uporaba za Pro; napomena za pravnika', () => {
  const html = fs.readFileSync(javno('uvjeti-koristenja.html'), 'utf8');
  assert.match(html, /Paket<\/strong> je jednokratna kupnja/);
  assert.match(html, /90 dana od dana kupnje/);
  assert.match(html, /nisu iskorištene propadaju/);
  assert.match(html, /razumnu uporabu/);
  assert.match(html, /<!-- PROVJERITI S PRAVNIKOM/);
});
