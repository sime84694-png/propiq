// PropIQ — pristanak na kolačiće (Google Consent Mode v2, BASIC način) i slanje događaja.
//
// Učitava se SINKRONO u <head>, odmah iza tracking-config.js, prije bilo kojeg taga.
// BASIC: dok korisnik ne pristane, NE učitava se nijedan Google ni Meta tag i nema nikakvih
// zahtjeva prema Googleu ni Meti (Consent Mode default "denied" postoji samo u dataLayeru).
//   - analitika  → učitava gtag.js i konfigurira GA4,
//   - marketing  → učitava gtag.js i konfigurira Google Ads, te učitava Meta Pixel,
//   - banner (Prihvati sve / Odbij sve / Postavke) se prikazuje dok izbor ne postoji.
//
// Događaji: window.propiqTrack('analysis_success' | 'form_submit' | 'purchase', params)
// Šalju se samo alatima za koje postoji pristanak; dok korisnik ne odluči, čekaju na stranici.
// Postavke se ponovo otvaraju bilo kojim elementom s atributom data-cookie-settings.
// Debug: ?pq_debug=1 uključuje GA4 debug_mode za ovu sesiju (vidljivo u DebugView).
(function () {
  'use strict';

  var CFG = window.PROPIQ_TRACKING || {};
  var STORAGE_KEY = 'propiq_consent';
  var CONSENT_VERSION = 1;
  var MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // izbor vrijedi 12 mjeseci, zatim se ponovo pita

  function isSet(v) { return typeof v === 'string' && v.length > 0 && !/X{4,}/.test(v); }
  var HAS_GA4 = isSet(CFG.GA4_ID);
  var HAS_ADS = isSet(CFG.ADS_ID);
  var HAS_META = isSet(CFG.META_PIXEL_ID);

  // ── 1. Consent Mode v2: default denied (samo dataLayer, bez mrežnih zahtjeva) ──
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  gtag('set', 'ads_data_redaction', true);

  // Stari banner je spremao samo 'accept'/'decline' bez kategorija — nije valjan pristanak za nove alate.
  try { localStorage.removeItem('propiq_cookie'); } catch (e) {}

  function readConsent() {
    try {
      var c = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!c || c.v !== CONSENT_VERSION || typeof c.ts !== 'number') return null;
      if (Date.now() - c.ts > MAX_AGE_MS) return null;
      return { analytics: !!c.analytics, marketing: !!c.marketing, ts: c.ts };
    } catch (e) { return null; }
  }

  function writeConsent(c) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: CONSENT_VERSION, analytics: !!c.analytics, marketing: !!c.marketing, ts: Date.now(),
      }));
    } catch (e) {}
  }

  function consentUpdate(c) {
    var ad = c.marketing ? 'granted' : 'denied';
    gtag('consent', 'update', {
      ad_storage: ad,
      ad_user_data: ad,
      ad_personalization: ad,
      analytics_storage: c.analytics ? 'granted' : 'denied',
    });
    gtag('set', 'ads_data_redaction', !c.marketing);
  }

  var debug = false;
  try {
    if (new URLSearchParams(location.search).get('pq_debug') === '1') sessionStorage.setItem('pq_debug', '1');
    debug = sessionStorage.getItem('pq_debug') === '1';
  } catch (e) {}

  // ── 2. gtag.js — tek uz pristanak (GA4 uz analitiku, Google Ads uz marketing) ──
  var gaOn = false;   // GA4 konfiguriran na ovoj stranici
  var adsOn = false;  // Google Ads konfiguriran na ovoj stranici
  var gtagScript = false;

  function loadGoogle(c) {
    var wantGa = c.analytics && HAS_GA4 && !gaOn;
    var wantAds = c.marketing && HAS_ADS && !adsOn;
    if (!wantGa && !wantAds) return;
    consentUpdate(c); // update ide u dataLayer PRIJE config naredbi
    if (!gtagScript) {
      gtagScript = true;
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(wantGa ? CFG.GA4_ID : CFG.ADS_ID);
      document.head.appendChild(s);
      gtag('js', new Date());
    }
    if (wantGa) { gaOn = true; gtag('config', CFG.GA4_ID, debug ? { debug_mode: true } : {}); }
    if (wantAds) { adsOn = true; gtag('config', CFG.ADS_ID); }
  }

  // ── 3. Meta Pixel — tek uz pristanak na marketing ──
  var metaOn = false;

  function loadMeta() {
    if (metaOn || !HAS_META) return;
    metaOn = true;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', CFG.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  var consent = readConsent();
  if (consent) {
    loadGoogle(consent);
    if (consent.marketing) loadMeta();
  }

  // Brisanje Googleovih i Metinih kolačića kad se pristanak povuče.
  function clearTrackingCookies() {
    var prefixes = ['_ga', '_gid', '_gat', '_gcl', '_fbp', '_fbc'];
    var host = location.hostname;
    var domains = ['', host, '.' + host];
    var parts = host.split('.');
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (!prefixes.some(function (p) { return name.indexOf(p) === 0; })) return;
      domains.forEach(function (d) {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  // ── 4. Događaji ──
  // analysis_success → GA4 (analitika) + Google Ads konverzija i Meta Lead (marketing)
  // form_submit      → GA4 (analitika) + Google Ads konverzija i Meta FormSubmit (marketing)
  // purchase         → GA4 purchase (analitika) + Google Ads konverzija i Meta Purchase (marketing)
  //                    (params: transaction_id = Stripe session_id, value, currency, plan)
  var pendingEvents = []; // nastali prije odluke na ovoj stranici (npr. povratak sa Stripea)

  function send(name, params) {
    if (consent.analytics && HAS_GA4) {
      var ga = { send_to: CFG.GA4_ID };
      Object.keys(params).forEach(function (k) { ga[k] = params[k]; });
      gtag('event', name, ga);
    }
    if (!consent.marketing) return;

    var label = CFG.ADS_LABELS && CFG.ADS_LABELS[name];
    if (HAS_ADS && isSet(label)) {
      var conv = { send_to: CFG.ADS_ID + '/' + label };
      if (params.value != null) { conv.value = params.value; conv.currency = params.currency || 'EUR'; }
      if (params.transaction_id) conv.transaction_id = params.transaction_id;
      gtag('event', 'conversion', conv);
    }
    if (HAS_META && metaOn) {
      if (name === 'analysis_success') {
        window.fbq('track', 'Lead', {}, params.event_id ? { eventID: params.event_id } : {});
      } else if (name === 'form_submit') {
        window.fbq('trackCustom', 'FormSubmit', {});
      } else if (name === 'purchase') {
        window.fbq('track', 'Purchase',
          { value: params.value, currency: params.currency || 'EUR', content_name: params.plan || '' },
          params.transaction_id ? { eventID: params.transaction_id } : {});
      }
    }
  }

  window.propiqTrack = function (name, params) {
    params = params || {};
    if (!consent) { pendingEvents.push([name, params]); return; }
    send(name, params);
  };

  function applyChoice(c) {
    var before = consent;
    consent = { analytics: !!c.analytics, marketing: !!c.marketing, ts: Date.now() };
    writeConsent(consent);
    consentUpdate(consent);
    loadGoogle(consent);
    if (consent.marketing) loadMeta();

    var revoked = (gaOn && !consent.analytics) || ((adsOn || metaOn) && !consent.marketing) ||
      (before && ((before.analytics && !consent.analytics) || (before.marketing && !consent.marketing)));
    if (revoked) {
      clearTrackingCookies();
      // Učitani gtag.js / Pixel se ne mogu "ugasiti" — svježe učitavanje stranice bez njih.
      if ((gaOn && !consent.analytics) || ((adsOn || metaOn) && !consent.marketing)) {
        location.reload();
        return;
      }
    }
    pendingEvents.splice(0).forEach(function (e) { send(e[0], e[1]); });
  }

  // Događaj tik prije napuštanja stranice (npr. slanje forme → rezultat.html) gubi se jer
  // GA4 šalje u paketima. defer() ga sprema u sessionStorage, a šalje ga sljedeća stranica.
  var DEFER_KEY = 'propiq_deferred_events';
  window.propiqTrack.defer = function (name, params) {
    try {
      var q = JSON.parse(sessionStorage.getItem(DEFER_KEY) || '[]');
      q.push([name, params || {}]);
      sessionStorage.setItem(DEFER_KEY, JSON.stringify(q.slice(-10)));
    } catch (e) { window.propiqTrack(name, params); }
  };
  try {
    var pending = JSON.parse(sessionStorage.getItem(DEFER_KEY) || '[]');
    sessionStorage.removeItem(DEFER_KEY);
    pending.forEach(function (e) { window.propiqTrack(e[0], e[1]); });
  } catch (e) {}

  // ── 5. Banner ──
  var CSS = [
    '.pq-cc{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9000;width:calc(100% - 48px);max-width:780px;',
    'background:#111;color:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:18px 24px;',
    'box-shadow:0 16px 48px rgba(0,0,0,.6);font-size:.85rem;line-height:1.6;font-family:inherit}',
    '.pq-cc[hidden]{display:none!important}',
    '.pq-cc-row{display:flex;align-items:center;gap:24px}',
    '.pq-cc-text{flex:1;margin:0}',
    '.pq-cc a{color:rgba(255,255,255,.85);text-decoration:underline;text-underline-offset:2px}',
    '.pq-cc-btns{display:flex;gap:10px;flex-shrink:0;flex-wrap:wrap}',
    '.pq-cc button{font-family:inherit;font-size:.83rem;font-weight:700;line-height:1;padding:11px 20px;border-radius:100px;cursor:pointer;white-space:nowrap}',
    '.pq-cc .pq-solid{background:#f0ece4;color:#0a0806;border:1.5px solid #f0ece4}',
    '.pq-cc .pq-ghost{background:transparent;color:rgba(255,255,255,.8);border:1.5px solid rgba(255,255,255,.25)}',
    '.pq-cc .pq-link{background:none;border:none;color:rgba(255,255,255,.6);text-decoration:underline;padding:11px 6px}',
    '.pq-cc button:focus-visible{outline:2px solid #d4af37;outline-offset:2px}',
    '.pq-cc-panel{margin-top:14px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px}',
    '.pq-cc-opt{display:flex;gap:12px;align-items:flex-start;padding:8px 0}',
    '.pq-cc-opt input{margin-top:4px;width:18px;height:18px;accent-color:#d4af37;flex-shrink:0}',
    '.pq-cc-opt b{color:#f0ece4;font-weight:600}',
    '.pq-cc-save{margin-top:8px;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}',
    '@media (max-width:600px){.pq-cc{bottom:16px;width:calc(100% - 32px);padding:16px}',
    '.pq-cc-row{flex-direction:column;align-items:stretch;gap:12px}.pq-cc-btns button{flex:1}}',
  ].join('');

  var HTML =
    '<div class="pq-cc-row">' +
      '<p class="pq-cc-text" id="pq-cc-desc">Koristimo nužne kolačiće za rad stranice. Uz vaš pristanak koristimo i ' +
      'kolačiće za analitiku (Google Analytics) i marketing (Google Ads, Meta) kako bismo mjerili posjete i oglase. ' +
      'Više u <a href="politika-privatnosti.html#s7">politici privatnosti</a>.</p>' +
      '<div class="pq-cc-btns">' +
        '<button type="button" class="pq-solid" data-pq="all">Prihvati sve</button>' +
        '<button type="button" class="pq-ghost" data-pq="none">Odbij sve</button>' +
        '<button type="button" class="pq-link" data-pq="settings" aria-expanded="false" aria-controls="pq-cc-panel">Postavke</button>' +
      '</div>' +
    '</div>' +
    '<div class="pq-cc-panel" id="pq-cc-panel" hidden>' +
      '<label class="pq-cc-opt"><input type="checkbox" checked disabled>' +
        '<span><b>Nužni</b> (uvijek uključeni). Pamćenje vašeg izbora i osnovni rad stranice.</span></label>' +
      '<label class="pq-cc-opt"><input type="checkbox" id="pq-cc-analytics">' +
        '<span><b>Analitika.</b> Google Analytics: koliko ljudi posjećuje stranicu i koje dijelove koriste.</span></label>' +
      '<label class="pq-cc-opt"><input type="checkbox" id="pq-cc-marketing">' +
        '<span><b>Marketing.</b> Google Ads i Meta (Facebook, Instagram): mjerenje uspješnosti oglasa i prikaz oglasa posjetiteljima.</span></label>' +
      '<div class="pq-cc-save"><button type="button" class="pq-solid" data-pq="save">Spremi izbor</button></div>' +
    '</div>';

  var banner = null;

  function build() {
    if (banner) return banner;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    banner = document.createElement('div');
    banner.className = 'pq-cc';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Postavke kolačića');
    banner.setAttribute('aria-describedby', 'pq-cc-desc');
    banner.hidden = true;
    banner.innerHTML = HTML;
    document.body.appendChild(banner);

    banner.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pq]');
      if (!b) return;
      var a = b.getAttribute('data-pq');
      if (a === 'all') close({ analytics: true, marketing: true });
      else if (a === 'none') close({ analytics: false, marketing: false });
      else if (a === 'save') close({
        analytics: document.getElementById('pq-cc-analytics').checked,
        marketing: document.getElementById('pq-cc-marketing').checked,
      });
      else if (a === 'settings') togglePanel();
    });
    return banner;
  }

  function togglePanel(forceOpen) {
    var panel = document.getElementById('pq-cc-panel');
    var btn = banner.querySelector('[data-pq="settings"]');
    var open = forceOpen === true ? true : panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      document.getElementById('pq-cc-analytics').checked = !!(consent && consent.analytics);
      document.getElementById('pq-cc-marketing').checked = !!(consent && consent.marketing);
    }
  }

  function open(withSettings) {
    build();
    banner.hidden = false;
    if (withSettings) togglePanel(true);
    var first = banner.querySelector('[data-pq="all"]');
    if (first) first.focus({ preventScroll: true });
  }

  function close(choice) {
    applyChoice(choice);
    banner.hidden = true;
    var panel = document.getElementById('pq-cc-panel');
    if (panel) panel.hidden = true;
  }

  window.propiqConsent = {
    open: function () { open(true); },
    get: function () { return consent ? { analytics: consent.analytics, marketing: consent.marketing } : null; },
  };

  function init() {
    if (!consent) open(false);
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-cookie-settings]');
      if (!t) return;
      e.preventDefault();
      open(true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
