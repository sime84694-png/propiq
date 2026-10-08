// Testovi redakcije cijena iz oglasa (netlify/lib/redakcija.mjs) za slijepu procjenu fer vrijednosti.
// Pokretanje: node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import { ukloniCijene, OZNAKA } from '../netlify/lib/redakcija.mjs';

// [ulaz, korisnička cijena | undefined, fragmenti koji NE smiju ostati]
const ZAPISI = [
  ['Cijena: 694.896 €', undefined, ['694', '896', '€']],
  ['Prodaje se za 694 896,00 EUR, 2. kat', undefined, ['694', '896', 'EUR']],
  ['Tražim €320k za stan', undefined, ['320', '€']],
  ['Cijena 320 tis. eura, povoljno', undefined, ['320', 'eura', 'tis']],
  ['Cijena: 320 tisuća eura', undefined, ['320', 'tisuća']],
  ['1.250.000 € (milijun i četvrt)', undefined, ['1.250', '€']],
  ['za 1,2 milijuna eura', undefined, ['1,2', 'milijuna']],
  ['Ukupno 1,2 mil. € s PDV-om', undefined, ['1,2', 'mil', '€']],
  ['185.000,00 EUR', undefined, ['185', 'EUR']],
  ['EUR 320.000', undefined, ['320', 'EUR']],
  ['€ 320 000', undefined, ['320', '€']],
  ['320.000€', undefined, ['320', '€']],
  ['320000 eur', undefined, ['320000', 'eur']],
  ['stari iznos 2.400.000 kn', undefined, ['2.400', 'kn']],
  ['oko 1.500.000 kuna', undefined, ['1.500', 'kuna']],
  ['Cijena 450.000 HRK', undefined, ['450', 'HRK']],
  ['od 300.000 do 320.000 €', undefined, ['300', '320']],
  ['300.000 – 320.000 EUR', undefined, ['300', '320']],
  ['2.500 €/m²', undefined, ['2.500', '€', 'm²']],
  ['3000 eur po m2', undefined, ['3000', 'eur', 'm2']],
  ['9.651 €/m² u kvartu', undefined, ['9.651', '€']],
  ['Cijena po m²: 2.800', undefined, ['2.800']],
  ['Tražena cijena: po dogovoru oko 320k', undefined, ['320k']],
  ['Prodajna cijena iznosi tristo dvadeset tisuća eura.', undefined, ['tristo', 'tisuća', 'eura']],
  ['sto dvadeset tisuća €', undefined, ['dvadeset', 'tisuća']],
  ['Cijena - 99.000 eura', undefined, ['99', 'eura']],
  ['cijena=250000', undefined, ['250000']],
  ['Cijena nekretnine: [x]', undefined, []],
  // zapisi cijene koju je korisnik upisao (i bez valute)
  ['Stan, 320000 hitno', 320000, ['320000']],
  ['Stan, 320.000 hitno', 320000, ['320.000']],
  ['Stan, 320 000 hitno', 320000, ['320 000']],
  ['Stan, 320,000 hitno', 320000, ['320,000']],
  ['Stan, 320.000,00 hitno', 320000, ['320.000']],
  ['Stan za 320k', 320000, ['320k']],
  ['Stan za 320 tisuća', 320000, ['320', 'tisuća']],
  ['Stan za 1.250.000', 1250000, ['1.250']],
  ['Stan za 1,25 mil', 1250000, ['1,25', 'mil']],
  ['Stan za 694896', 694896, ['694896']],
  ['Stan za 694 896', 694896, ['694 896']],
  ['Stan za 185.000,50', 185000.5, ['185.000']],
];

test('redakcija: realni zapisi cijena iz hrvatskih oglasa se uklanjaju', () => {
  for (const [ulaz, cijena, zabranjeno] of ZAPISI) {
    const izlaz = ukloniCijene(ulaz, cijena);
    for (const z of zabranjeno) assert.ok(!izlaz.includes(z), `"${ulaz}" → "${izlaz}" još sadrži "${z}"`);
    if (zabranjeno.length) assert.ok(izlaz.includes(OZNAKA), `"${ulaz}" → "${izlaz}" nema oznaku`);
  }
});

test('redakcija: sve cijene u cijelom oglasu, bez ijednog ostatka', () => {
  const oglas = `Prodaje se trosobni stan, Split – Znanovac, 72 m², 3. kat s liftom.
Cijena: 694.896 €
Cijena po m²: 9.651 €/m²
Tražimo 694 896,00 EUR (€695k, 695 tis.), moguć popust. Stari iznos 5.200.000 kn.
Pričuva 45 €. Obnovljeno 2019. godine, energetski razred B.`;
  const izlaz = ukloniCijene(oglas, 694896);
  assert.ok(!/\d[\d.\s,]*\s*(€|eur|kn)|€\s*\d|694|695|9\.651|5\.200/i.test(izlaz), izlaz);
});

test('redakcija: ostatak oglasa ostaje neizmijenjen (površina, kat, godina, kvadratura, adresa)', () => {
  const t = 'Stan 72 m², 3. kat, lift, 2015. godina, Ulica kneza Branimira 12, 3 sobe, 2 kupaonice, 58,5 m2 neto, parking.';
  assert.equal(ukloniCijene(t, 250000), t);
  assert.equal(ukloniCijene('Europska ulica 3, Eurospin blizu, 58 m2', undefined), 'Europska ulica 3, Eurospin blizu, 58 m2');
});

test('redakcija: prazan ili nevaljan ulaz', () => {
  assert.equal(ukloniCijene('', 1), '');
  assert.equal(ukloniCijene(undefined, 1), '');
  assert.equal(ukloniCijene('Stan', null), 'Stan');
  assert.equal(ukloniCijene('Stan', 'abc'), 'Stan');
});

test('redakcija: uzastopne oznake se spajaju u jednu', () => {
  const izlaz = ukloniCijene('Od 300.000 do 320.000 € po dogovoru', undefined);
  assert.equal(izlaz.split(OZNAKA).length - 1, 1, izlaz);
});

test('redakcija: tuđi brojevi koji sadrže cijenu nisu pogođeni (1.320.000 ≠ 320.000 korisnika)', () => {
  const izlaz = ukloniCijene('ID 1320000 i kod 2320000', 320000);
  assert.equal(izlaz, 'ID 1320000 i kod 2320000');
});
