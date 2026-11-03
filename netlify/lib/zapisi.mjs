// PropIQ — rok čuvanja zapisa analize (store propiq-procjene) i brisanje isteklih zapisa.
// Ključ zapisa je {id}:{vrijeme nastanka u ms}. Politika privatnosti obećava najviše 24 h; kod čuva 1 h.
// Brišu ih: (1) zakazana funkcija jednom na sat (netlify/functions/ocisti-zapise.mjs), (2) svaki upis u store,
// (3) čitanje isteklog zapisa. Istekao zapis se pri čitanju tretira kao nepostojeći.

export const PROCJENE_CUVANJE_MS = 60 * 60 * 1000;

export const vrijemeKljuca = (key) => parseInt(key.slice(key.lastIndexOf(':') + 1), 10) || 0;
export const jeIstekao = (key, sada = Date.now(), cuvanjeMs = PROCJENE_CUVANJE_MS) => sada - vrijemeKljuca(key) >= cuvanjeMs;

// Briše sve zapise starije od cuvanjeMs. Vraća broj obrisanih.
export async function obrisiIstekle(store, cuvanjeMs = PROCJENE_CUVANJE_MS, sada = Date.now()) {
  const { blobs } = await store.list();
  const istekli = blobs.filter((b) => jeIstekao(b.key, sada, cuvanjeMs));
  await Promise.all(istekli.map((b) => store.delete(b.key)));
  return istekli.length;
}
