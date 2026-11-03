// PropIQ — normalizacija e-maila za brojač besplatnih analiza i blokada jednokratnih adresa.
// Normalizirani oblik služi SAMO za ključ besplatne kvote. Provjera pretplate na Stripeu, mjesečna kvota
// i krediti iz paketa i dalje koriste e-mail onako kako je upisan (lowercase + trim), jer se plaćanje
// veže uz adresu s računa.

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Lokalni razvoj (netlify dev): aliasi se ne svode, da se može testirati s ime+propiqN@... adresama.
// Produkcija i deploy preview nemaju iznimku (CONTEXT je tamo "production" / "deploy-preview" / "branch-deploy").
export const jeLokalniRazvoj = (env = process.env) => env.CONTEXT === 'dev';

export function normalizirajEmail(email, env = process.env) {
  const e = String(email || '').trim().toLowerCase();
  if (jeLokalniRazvoj(env)) return e;
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let lokalni = e.slice(0, at);
  let domena = e.slice(at + 1);
  const plus = lokalni.indexOf('+');
  if (plus >= 0) lokalni = lokalni.slice(0, plus);
  if (GMAIL.has(domena)) {
    lokalni = lokalni.replace(/\./g, '');
    domena = 'gmail.com';
  }
  return lokalni ? `${lokalni}@${domena}` : e;
}

// 30 najčešćih domena za jednokratne adrese (nije iscrpan popis; zaustavlja samo najjednostavnije zaobilaženje).
const JEDNOKRATNE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com',
  'tempmail.net', 'temp-mail.io', 'tempail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.net',
  'throwawaymail.com', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
  'mohmal.com', 'emailondeck.com', 'mintemail.com', 'spamgourmet.com', 'moakt.com', 'mailnesia.com',
]);

export function jeJednokratnaAdresa(email) {
  const domena = String(email || '').trim().toLowerCase().split('@').pop();
  return JEDNOKRATNE.has(domena);
}

export const PORUKA_JEDNOKRATNA =
  'Jednokratne e-mail adrese nisu dopuštene za besplatne analize. Upiši svoju stalnu e-mail adresu.';
