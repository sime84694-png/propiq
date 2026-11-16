// Zakazana funkcija: jednom na sat briše istekle zapise zahtjeva (propiq-procjene, vidi netlify/lib/zapisi.mjs)
// i istekle brojače limita po IP-u (propiq-ratelimit, vidi netlify/lib/zastita.mjs).
import { jakiStore, obrisiIstekleLimite } from '../lib/zastita.mjs';
import { obrisiIstekle } from '../lib/zapisi.mjs';

export default async () => {
  // Svaki store zasebno: greška u jednom ne smije spriječiti čišćenje drugog.
  try {
    const n = await obrisiIstekle(jakiStore('propiq-procjene'));
    console.log(`Obrisano isteklih zapisa zahtjeva: ${n}`);
  } catch (err) {
    console.error('Brisanje isteklih zapisa nije uspjelo:', err);
  }
  try {
    const n = await obrisiIstekleLimite(jakiStore('propiq-ratelimit'));
    console.log(`Obrisano isteklih brojača limita: ${n}`);
  } catch (err) {
    console.error('Brisanje isteklih brojača limita nije uspjelo:', err);
  }
};

export const config = { schedule: '@hourly' };
