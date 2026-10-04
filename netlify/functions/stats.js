// PropIQ — interni pregled brojača analiza (vidi incrementStats u analiza.js).
// GET /.netlify/functions/stats?key=<STATS_KEY>[&month=YYYY-MM]
// Vraća { total, months: { "2026-10": { "ig-hook": { free: 3, pro: 1 } } } }.
// Bez ispravnog ključa (ili ako STATS_KEY nije postavljen) vraća 401.

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function keyMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Dozvoljen je samo GET.' });
  }

  const expected = process.env.STATS_KEY;
  const given = (event.queryStringParameters || {}).key || '';
  if (!expected || !given || !keyMatches(given, expected)) {
    return json(401, { error: 'Neovlašteno.' });
  }

  const month = (event.queryStringParameters || {}).month || '';
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return json(400, { error: 'Parametar month mora biti u formatu YYYY-MM.' });
  }

  try {
    connectLambda(event);
    const store = getStore('propiq-stats');
    const { blobs } = await store.list({ prefix: month ? `stats/${month}/` : 'stats/' });

    const months = {};
    let total = 0;
    await Promise.all(
      blobs.map(async ({ key }) => {
        const [, m, source, plan] = key.split('/');
        if (!m || !source || !plan) return;
        const n = parseInt((await store.get(key)) || '0', 10) || 0;
        months[m] = months[m] || {};
        months[m][source] = months[m][source] || {};
        months[m][source][plan] = n;
        total += n;
      })
    );

    return json(200, { total, months });
  } catch (err) {
    console.error('Greška pri čitanju statistike:', err);
    return json(500, { error: 'Statistika trenutno nije dostupna.' });
  }
};
