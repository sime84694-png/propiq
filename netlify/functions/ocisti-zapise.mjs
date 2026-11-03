// Zakazana funkcija: jednom na sat briše istekle zapise zahtjeva (propiq-procjene), vidi netlify/lib/zapisi.mjs.
import { jakiStore } from '../lib/zastita.mjs';
import { obrisiIstekle } from '../lib/zapisi.mjs';

export default async () => {
  try {
    const n = await obrisiIstekle(jakiStore('propiq-procjene'));
    console.log(`Obrisano isteklih zapisa zahtjeva: ${n}`);
  } catch (err) {
    console.error('Brisanje isteklih zapisa nije uspjelo:', err);
  }
};

export const config = { schedule: '@hourly' };
