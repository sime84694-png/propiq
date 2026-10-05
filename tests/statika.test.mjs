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
    ['script-src', 'cdn.jsdelivr.net'],
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
test('rezultat.html: skripte s CDN-a imaju fiksnu verziju, integrity i crossorigin', () => {
  const html = fs.readFileSync(javno('rezultat.html'), 'utf8');
  const cdn = [...html.matchAll(/<script[^>]*src="(https:\/\/cdn\.jsdelivr\.net[^"]+)"[^>]*>/g)];
  assert.ok(cdn.length >= 2, 'marked i DOMPurify');
  for (const [tag, url] of cdn) {
    assert.match(url, /@\d+\.\d+\.\d+\//, `fiksna verzija: ${url}`);
    assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+"/, `integrity: ${url}`);
    assert.match(tag, /crossorigin="anonymous"/, `crossorigin: ${url}`);
  }
  assert.ok(cdn.some(([, u]) => /\/marked@/.test(u)) && cdn.some(([, u]) => /\/dompurify@/.test(u)));
});

test('rezultat.html: izlaz iz markeda nikad ne ide u innerHTML bez DOMPurify', () => {
  const html = fs.readFileSync(javno('rezultat.html'), 'utf8');
  assert.ok(!/innerHTML\s*=\s*marked\.parse/.test(html));
  assert.equal([...html.matchAll(/marked\.parse\(/g)].length, 1, 'marked.parse samo na jednom mjestu');
  assert.match(html, /DOMPurify\.sanitize\(marked\.parse\(/);
  assert.match(html, /if \(!window\.DOMPurify\) return ''/, 'bez DOMPurify ne prikazuje se ništa');
});

// ── V2 (forma) ──
test('index.html: polja forme imaju maxlength jednak ograničenjima na poslužitelju', () => {
  const html = fs.readFileSync(javno('index.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'netlify/functions/analiza.mjs'), 'utf8');
  const lim = (n) => Number(src.match(new RegExp(`const ${n} = (\\d+);`))[1]);
  const maxlength = (id) => Number(html.match(new RegExp(`id="${id}"[^>]*maxlength="(\\d+)"`))[1]);
  assert.equal(maxlength('ime'), lim('MAX_IME'));
  assert.equal(maxlength('agencija'), lim('MAX_AGENCIJA'));
  assert.equal(maxlength('email'), lim('MAX_EMAIL'));
  assert.equal(maxlength('oglas_tekst'), lim('MAX_OGLAS'));
});
