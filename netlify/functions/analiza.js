// PropIQ — proxy prema Claude API za analizu nekretnina.
// Poziva se s POST-om iz rezultat.html; vraća { analiza: "...markdown..." }.
// API ključ NIKAD nije u kodu — čita se iz Netlify env varijable ANTHROPIC_API_KEY.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const SYSTEM_PROMPT = `Ti si PropIQ — AI investicijski savjetnik za hrvatsko tržište nekretnina.
Na temelju podataka iz forme (ime, agencija i tekst oglasa nekretnine) izradi profesionalnu, sažetu i konkretnu analizu na hrvatskom jeziku.

Analiza OBAVEZNO uključuje sljedeće cjeline (koristi Markdown naslove i liste):
1. **Procjena vrijednosti** — realan raspon tržišne vrijednosti i je li tražena cijena precijenjena, poštena ili prilika.
2. **Tržišni kontekst** — lokacija, tip nekretnine i pozicioniranje u odnosu na hrvatsko tržište.
3. **Investicijska preporuka** — isplativost, potencijalni ROI/najam ako je primjenjivo, te rizici.
4. **Preporuke** — 3–5 konkretnih idućih koraka za agenta ili investitora.

Pravila:
- Piši isključivo na hrvatskom, profesionalnim ali jasnim tonom.
- Vrati SAMO Markdown analizu, bez uvodnih fraza poput "Evo analize".
- Ako u oglasu nedostaju ključni podaci (npr. cijena ili kvadratura), jasno naznači pretpostavke.
- Ne izmišljaj precizne brojke kao činjenice — koristi raspone i naznači da je riječ o procjeni.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Dozvoljen je samo POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Konfiguracija poslužitelja nije potpuna (nedostaje API ključ).' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Neispravan JSON u zahtjevu.' });
  }

  const ime = (data.ime || '').toString().trim();
  const agencija = (data.agencija || '').toString().trim();
  const oglasTekst = (data.oglas_tekst || '').toString().trim();

  if (!oglasTekst) {
    return json(400, { error: 'Nedostaje tekst oglasa za analizu.' });
  }

  const userMessage =
    `Podnositelj: ${ime || 'nepoznato'}` +
    (agencija ? ` (agencija: ${agencija})` : '') +
    `\n\nTekst oglasa nekretnine:\n"""\n${oglasTekst}\n"""`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic API greška:', res.status, detail);
      return json(502, { error: 'Analiza trenutno nije dostupna. Pokušajte ponovo za koji trenutak.' });
    }

    const payload = await res.json();
    const analiza = (payload.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!analiza) {
      return json(502, { error: 'Analiza je vraćena prazna. Pokušajte ponovo.' });
    }

    return json(200, { analiza });
  } catch (err) {
    console.error('Neočekivana greška pri pozivu Anthropic API-ja:', err);
    return json(500, { error: 'Došlo je do greške pri dohvaćanju analize. Pokušajte ponovo.' });
  }
};
