// PropIQ — ID-jevi za mjerenje. JEDINO mjesto gdje se upisuju.
// Dok vrijednost sadrži "XXXX", taj alat se ne učitava (consent.js ga preskače).
//
// GA4:        Admin → Data streams → Web → Measurement ID (G-…)
// Google Ads: Goals → Conversions → konverzija → Tag setup → "Use Google tag"
//             → send_to izgleda "AW-123456789/AbCdEfGhIj": prvi dio je ADS_ID, drugi je label.
// Meta:       Events Manager → Data sources → Pixel ID (samo brojke)
window.PROPIQ_TRACKING = {
  GA4_ID: 'G-XXXXXXXXXX',
  ADS_ID: 'AW-XXXXXXXXXX',
  ADS_LABELS: {
    analysis_success: 'XXXXXXXXXX',
    form_submit: 'XXXXXXXXXX',
    purchase: 'XXXXXXXXXX',
  },
  META_PIXEL_ID: 'XXXXXXXXXXXXXXX',
};
