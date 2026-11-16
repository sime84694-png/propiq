// Banner za kolačiće (public/assets/js/consent.js): dva stanja.
//  - svi ID-jevi u tracking-config.js su placeholderi (XXXX): nema banera ni kategorija, "Postavke kolačića" otvara
//    samo informativni panel, a ništa se ne sprema u preglednik;
//  - ID-jevi upisani: banner s kategorijama vraća se sam, bez izmjene koda.
// Nema DOM biblioteke u projektu pa se skripta izvodi u vm kontekstu s minimalnim lažnim DOM-om.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const kod = fs.readFileSync(path.join(import.meta.dirname, '..', 'public/assets/js/consent.js'), 'utf8');
const PLACEHOLDERI = { GA4_ID: 'G-XXXXXXXXXX', ADS_ID: 'AW-XXXXXXXXXX', ADS_LABELS: {}, META_PIXEL_ID: 'XXXXXXXXXXXXXXX' };

function ucitaj(cfg, { spremljenIzbor = null } = {}) {
  const el = () => ({
    hidden: false, innerHTML: '', className: '', textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, appendChild() {},
    querySelector() { return { focus() {}, setAttribute() {}, checked: false }; },
  });
  const dodani = [];
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const local = mem(); const session = mem();
  if (spremljenIzbor) local.setItem('propiq_consent', JSON.stringify({ v: 1, ...spremljenIzbor, ts: Date.now() }));
  const doc = {
    readyState: 'complete', cookie: '', referrer: '',
    createElement: el,
    head: { appendChild() {} },
    body: { appendChild: (e) => dodani.push(e) },
    getElementById: () => el(),
    addEventListener() {},
  };
  const win = { PROPIQ_TRACKING: cfg, localStorage: local, sessionStorage: session, dispatchEvent() {}, addEventListener() {} };
  const ctx = vm.createContext({
    window: win, document: doc, localStorage: local, sessionStorage: session, location: { hostname: 'propiq-hr.netlify.app', search: '', reload() {} },
    CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } }, console, Date, JSON, encodeURIComponent,
  });
  vm.runInContext(kod, ctx);
  return { win, dodani, session };
}

test('svi ID-jevi su placeholderi: banner se ne prikazuje pri učitavanju', () => {
  const { win, dodani } = ucitaj(PLACEHOLDERI);
  assert.equal(win.propiqConsent.active, false);
  assert.equal(dodani.length, 0, 'banner nije dodan u stranicu');
});

test('svi ID-jevi su placeholderi: "Postavke kolačića" otvara samo informativni panel, bez kategorija analitike i marketinga', () => {
  const { win, dodani } = ucitaj(PLACEHOLDERI);
  win.propiqConsent.open();
  assert.equal(dodani.length, 1);
  const html = dodani[0].innerHTML;
  assert.equal(dodani[0].hidden, false);
  assert.match(html, /Pohrana u pregledniku/);
  assert.match(html, /propiq_analiza_data/);
  assert.match(html, /propiq_exit/);
  assert.match(html, /data-pq="close"/);
  assert.doesNotMatch(html, /Prihvati sve|Odbij sve|pq-cc-analytics|pq-cc-marketing|Google Analytics|Meta/);
});

test('svi ID-jevi su placeholderi: odgođeni događaji se ne spremaju u sessionStorage', () => {
  const { win, session } = ucitaj(PLACEHOLDERI);
  win.propiqTrack.defer('form_submit', { plan: 'free' });
  assert.equal(session.m.size, 0);
});

test('barem jedan pravi ID: banner s kategorijama vraća se sam i prikazuje se pri prvom posjetu', () => {
  for (const cfg of [{ ...PLACEHOLDERI, GA4_ID: 'G-ABC123DEF4' }, { ...PLACEHOLDERI, ADS_ID: 'AW-123456789' }, { ...PLACEHOLDERI, META_PIXEL_ID: '123456789012345' }]) {
    const { win, dodani } = ucitaj(cfg);
    assert.equal(win.propiqConsent.active, true);
    assert.equal(dodani.length, 1, 'banner je dodan pri učitavanju');
    assert.equal(dodani[0].hidden, false);
    assert.match(dodani[0].innerHTML, /Prihvati sve/);
    assert.match(dodani[0].innerHTML, /pq-cc-analytics/);
    assert.match(dodani[0].innerHTML, /pq-cc-marketing/);
  }
});

test('pravi ID i već spremljen izbor: banner se ne prikazuje, a "Postavke kolačića" ga otvara s kategorijama', () => {
  const { win, dodani } = ucitaj({ ...PLACEHOLDERI, GA4_ID: 'G-ABC123DEF4' }, { spremljenIzbor: { analytics: false, marketing: false } });
  assert.equal(dodani.length, 0);
  win.propiqConsent.open();
  assert.equal(dodani.length, 1);
  assert.match(dodani[0].innerHTML, /pq-cc-analytics/);
});

test('pravi ID: odgođeni događaji se i dalje spremaju (ponašanje s mjerenjem je nepromijenjeno)', () => {
  const { win, session } = ucitaj({ ...PLACEHOLDERI, GA4_ID: 'G-ABC123DEF4' });
  win.propiqTrack.defer('form_submit', { plan: 'free' });
  assert.equal(session.m.size, 1);
});
