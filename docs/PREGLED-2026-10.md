# PropIQ — pregled koda (listopad 2026.)

Opseg: cijeli repozitorij na `main` (commit `da20247`) — Netlify funkcije (`netlify/functions/*`, `netlify/lib/stripe-plan.js`), statične stranice (`index.html`, `rezultat.html`, `thank-you.html`, pravne stranice), `assets/js/*`, `netlify.toml` i testovi.
U kodu ništa nije mijenjano. Testovi (`node --test --experimental-test-module-mocks 'tests/**/*.test.mjs'`) prolaze: 29/29.

Stavke su poredane po važnosti. Brojevi redaka odnose se na navedeni commit.

---

## 🔴 Kritično

### K1. Besplatne analize su praktički neograničene — svaki novi email dobiva 3 nove
- **Gdje:** `netlify/functions/analiza.mjs:169`, `:179-181`, `:227-241`
- **Problem:** Email se ne provjerava ni na koji način (ni format, ni duljina, ni vlasništvo). Limit od 3 analize vezan je za string koji korisnik sam upiše, pa `a1@x.hr`, `a2@x.hr`, … (ili Gmail aliasi `ime+1@gmail.com`, `i.me@gmail.com`) svaki put dobivaju nove 3 analize. Svaka analiza je stvaran trošak prema Anthropicu.
- **Pogoršava:** `Access-Control-Allow-Origin: *` (`analiza.mjs:15-19`) i nepostojanje ograničenja po IP-u — funkciju može skriptom zvati bilo tko, s bilo koje stranice, kao besplatan proxy prema Claudeu.
- **Prijedlog:** potvrda emaila (magic link / jednokratni kod) prije prve analize; rate limit po IP-u (npr. Netlify Blobs brojač po `x-nf-client-connection-ip` ili Netlify rate limiting pravilo); CORS ograničiti na vlastitu domenu; normalizirati Gmail aliase.

### K2. Plaćeni plan dobiva svatko tko zna email pretplatnika
- **Gdje:** `netlify/lib/stripe-plan.js:9-11` (postojeći TODO), `netlify/functions/analiza.mjs:188`
- **Problem:** Pro (neograničeno) se dodjeljuje samo na temelju upisanog emaila. Jedan Pro račun može dijeliti cijeli ured ili se email može pogoditi (agencije objavljuju adrese javno). Usto je to i curenje podataka: upisom tuđeg emaila iz odgovora (403 vs. 200 nakon 3 analize) se može zaključiti je li ta osoba pretplatnik.
- **Prijedlog:** ista potvrda emaila kao u K1 (TODO "opcija B" u `stripe-plan.js`) — rješava oba problema odjednom.

### K3. XSS: Markdown od modela ubacuje se u stranicu bez sanitizacije
- **Gdje:** `rezultat.html:560` i `rezultat.html:594` (`analizaEl.innerHTML = marked.parse(...)`)
- **Problem:** `marked` ne sanitizira HTML. Tekst oglasa ide u model bez ikakve obrade, pa oglas (ili tekst koji netko podmetne korisniku za kopiranje) može uputiti model da u odgovor stavi `<img src=x onerror=...>`. Skripta se tada izvršava na domeni PropIQ-a i čita `sessionStorage` (ime, email, oglas) i `localStorage`.
- **Prijedlog:** propustiti izlaz kroz DOMPurify (`DOMPurify.sanitize(marked.parse(md))`) ili isključiti HTML u markedu; uz to dodati CSP (vidi V9).

### K4. `marked` se učitava s CDN-a bez verzije i bez SRI
- **Gdje:** `rezultat.html:496` (`https://cdn.jsdelivr.net/npm/marked/marked.min.js`)
- **Problem:** URL uvijek vuče **najnoviju** verziju. (a) Nova major verzija s promijenjenim API-jem ili bez UMD builda ruši cijelu stranicu rezultata — a to je jedina stranica na kojoj se prikazuje proizvod. (b) Bez `integrity` atributa kompromitirani paket/CDN izvršava proizvoljan kod na stranici koja drži email i analizu.
- **Prijedlog:** fiksirati točnu verziju (`marked@X.Y.Z`) uz `integrity` + `crossorigin`, ili datoteku hostati u `assets/js/`.

### K5. Utrka (race condition) u brojanju limita — paralelni zahtjevi prolaze limit
- **Gdje:** `netlify/functions/analiza.mjs:221-231` (čitanje), `:260` (upis `trenutnoIskoristeno + 1`)
- **Problem:** Brojač se pročita na početku zahtjeva, a upisuje tek nakon kraja streama (desetak sekundi kasnije) kao "pročitana vrijednost + 1". Deset paralelnih zahtjeva s istim emailom (svaki s drugim `request_id`) svi vide npr. 0, svi prolaze provjeru i svi upišu 1. Vrijedi i za Standard (10/mj.).
- **Prijedlog:** rezervirati jedinicu limita prije poziva Anthropicu (upis +1 odmah, povrat ako analiza ne uspije) i/ili koristiti uvjetni upis (Netlify Blobs `onlyIfMatch`/ETag) da se istovremeni upisi ne prepisuju.

---

## 🟠 Važno

### V1. Prekid veze = analiza se ne broji (iskoristivo za besplatne analize)
- **Gdje:** `netlify/functions/analiza.mjs:324-327`, `:345-348`
- **Problem:** Analiza se broji tek nakon `message_stop`. Klijent (skripta) koji primi tekst i zatvori vezu neposredno prije kraja dobiva gotovo cijelu analizu, a ništa mu se ne broji; trošak prema Anthropicu je ipak nastao. Ponašanje je namjerno (test "preglednik prekine vezu…"), ali je u kombinaciji s K1 lako zloupotrebljivo.
- **Prijedlog:** brojati u trenutku kad je stigao prvi tekst (ili nakon N tokena), a ne tek na kraju; "ne broji se" ostaviti samo za greške na strani poslužitelja/Anthropica.

### V2. Nema ograničenja duljine ulaza
- **Gdje:** `netlify/functions/analiza.mjs:166-168`; `index.html:1983` (textarea bez `maxlength`), `index.html:1970-1979` (ime, email, agencija — bez `maxlength`)
- **Problem:** `oglas_tekst`, `ime` i `agencija` mogu biti proizvoljno dugi i svi idu u prompt — jedan zahtjev može poslati stotine tisuća tokena (trošak, spor odgovor, 504). Predugačak email ide i u ključ Bloba (`analiza.mjs:220`, `:229`) gdje može premašiti ograničenje duljine ključa.
- **Prijedlog:** na poslužitelju odbiti `oglas_tekst` > ~15.000 znakova, `ime`/`agencija` > 100, email > 254 + osnovna provjera formata; isto kao `maxlength` u formi.

### V3. Greška pri bilježenju nakon uspješnog streama briše analizu koju je korisnik već vidio
- **Gdje:** `netlify/functions/analiza.mjs:324` (`await zabiljeziUspjeh()` unutar `try`) → `:330-334`; klijent `rezultat.html:686-688` → `showError` sakriva karticu (`rezultat.html:524`)
- **Problem:** Ako Netlify Blobs zakaže pri upisu limita/zapisa zahtjeva, cijela uspješna analiza završava porukom "Veza je prekinuta prije kraja analize", a klijent sakriva već prikazani tekst. Korisnik izgubi rezultat (iako mu se ne broji) i mora ponovo trošiti.
- **Prijedlog:** `zabiljeziUspjeh` omotati vlastitim `try/catch` (zalogirati, ali svejedno poslati `{kraj:true}`).

### V4. Stripe tok: email s checkouta i email u formi nisu povezani
- **Gdje:** `index.html:1812`, `index.html:1830` (Payment Linkovi), `netlify/lib/stripe-plan.js:34-64`
- **Problem:** Pristup ovisi isključivo o tome da korisnik u formu upiše **isti** email kojim je platio. Payment Link ne dobiva `prefilled_email`, nakon plaćanja nigdje se ne kaže "koristite email X", a ako se razlikuje, plaćeni korisnik nakon 3 analize dobiva poruku da je iskoristio besplatne. Nema webhooka ni ikakvog traga u aplikaciji da je netko platio.
- **Prijedlog:** nakon povratka sa Stripea (`?session_id=`) dohvatiti email iz sesije (`purchase-status`) i prikazati/prepopuniti ga u formi; u Payment Link dodati `prefilled_email` ako je poznat.

### V5. Nema načina da korisnik sam otkaže pretplatu, iako to Uvjeti obećavaju
- **Gdje:** `uvjeti-koristenja.html:148` ("putem korisničkog portala"); nigdje u kodu nema poveznice na Stripe Customer Portal
- **Problem:** Tekst Uvjeta ne odgovara stvarnosti; jedini put je email vlasniku. Za pretplatu s automatskom obnovom to je i pravni rizik i izvor povrata novca (chargebacka).
- **Prijedlog:** uključiti Stripe Customer Portal (no-code link) i staviti ga u podnožje / na stranicu rezultata.

### V6. Provjera Stripea na svakom zahtjevu — sporo i ranjivo na rate limit
- **Gdje:** `netlify/lib/stripe-plan.js:42-62`, poziv u `netlify/functions/analiza.mjs:188`
- **Problem:** Prije svake analize (i za besplatne korisnike) idu 2 poziva (`customers` + `customers/search`) i zatim po jedan **sekvencijalni** `subscriptions` poziv za svakog pronađenog kupca. To dodaje stotine ms do sekundi prije nego Claude uopće krene. Stripe Search API ima znatno niži rate limit od običnih endpointa, a skripta iz K1 ga lako potroši — tada se i plaćeni korisnici privremeno tretiraju kao besplatni.
- **Prijedlog:** kratko keširati rezultat po emailu (npr. 5–10 min u Blobsu), `subscriptions` pozive raditi paralelno (`Promise.all`), ili prijeći na webhook koji upisuje plan u Blob.

### V7. Standard limit se resetira po kalendarskom mjesecu (UTC), a poruka govori o obračunskom ciklusu
- **Gdje:** `netlify/functions/analiza.mjs:219-220`, poruka `:224`
- **Problem:** Tko se pretplati 28. dobiva 10 analiza do 1., pa opet 10 — a tko 2., čeka gotovo cijeli mjesec. Poruka "pričekajte sljedeći obračunski ciklus" nije točna; reset je u ponoć UTC (01/02 h po hrvatskom vremenu).
- **Prijedlog:** ključ temeljiti na `current_period_start` pretplate (već se dohvaća u `stripe-plan.js`), ili promijeniti tekst u "do 1. u mjesecu".

### V8. Cijeli repozitorij je vjerojatno javno objavljen
- **Gdje:** `netlify.toml:1-7` (nema `[build] publish`)
- **Problem:** Ako publish direktorij nije zadan ni u Netlify sučelju, objavljuje se korijen repozitorija: `/netlify/functions/analiza.mjs`, `/netlify/lib/stripe-plan.js`, `/tests/…`, `/CLAUDE.md`, `/package.json` su javno dostupni (sistemski prompt, logika limita, price ID-jevi). Tajni ključeva nema, ali olakšava zloupotrebu (K1, K5, V1).
- **Prijedlog:** provjeriti na produkciji (`/netlify/lib/stripe-plan.js`); statične datoteke premjestiti u npr. `public/` i postaviti `publish = "public"`.

### V9. Nema sigurnosnih HTTP zaglavlja
- **Gdje:** `netlify.toml` (nema `[[headers]]`), nema ni `_headers` datoteke
- **Problem:** Nema `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors` (stranica se može uokviriti — clickjacking). CSP bi ublažio i K3.
- **Prijedlog:** dodati `[[headers]] for = "/*"` s osnovnim zaglavljima i CSP-om koji dopušta samo potrebne izvore (self, jsdelivr ako ostane, Formspree, Cloudflare Insights, Google/Meta).

### V10. Email se čuva u čistom obliku i trajno, protivno vlastitoj politici
- **Gdje:** `netlify/functions/analiza.mjs:220` i `:229` (ključ Bloba = sirovi email); `politika-privatnosti.html:193`
- **Problem:** Brojač besplatnih analiza (`propiq-free-quota`) i Standard brojač kao ključ koriste sirovi email i nikad se ne brišu. Za zapise zahtjeva se već koristi HMAC (`hashEmaila`), pa je nekonzistentno. Politika kaže da se brojač čuva "dok koristite uslugu", ali ne postoji mehanizam brisanja.
- **Prijedlog:** i za brojače koristiti `hashEmaila(email)`; Standard ključeve starije od 2 mjeseca brisati; dokumentirati ručno brisanje na zahtjev.

### V11. Formspree "potvrda korisniku" ide vlasniku forme, a usto usporava svaku analizu do 4 s
- **Gdje:** `index.html:2263-2282`
- **Problem:** Formspree šalje obavijest **vlasniku forme**, ne pošiljatelju (`_replyto` samo postavlja Reply-To); korisnik potvrdu dobiva samo ako je u Formspreeu plaćen i uključen autoresponder. Istodobno se preusmjeravanje na rezultat čeka dok Formspree ne odgovori (do 4 s), što je izravno vidljivo kašnjenje na najvažnijem koraku. Tekst poruke na svaki zahtjev puni vlasnikov inbox.
- **Prijedlog:** provjeriti postavke Formspreea; ako potvrda nije bitna, ukloniti poziv, a ako jest, poslati ga s `navigator.sendBeacon`/`keepalive: true` i preusmjeriti odmah.

### V12. Mjerenje konverzija ne radi — svi ID-jevi su placeholderi
- **Gdje:** `assets/js/tracking-config.js:9-16`
- **Problem:** `G-XXXXXXXXXX`, `AW-XXXXXXXXXX`, `XXXXXXXXXXXXXXX` → `consent.js:39-42` ne učitava nijedan alat. Purchase/lead događaji (`index.html:2295-2322`, `rezultat.html:705-710`) se ne šalju nikamo, a banner svejedno traži privolu za GA/Ads/Meta koji se ne koriste.
- **Prijedlog:** upisati stvarne ID-jeve prije pokretanja oglasa, ili do tada pojednostaviti banner.

### V13. Oglašene značajke koje ne postoje ili se ne razlikuju po planu
- **Gdje:** `index.html:1826` ("PDF export izvješća" samo za Pro) vs. `rezultat.html:467` (gumb "Spremi kao PDF" svima); `index.html:1791` ("Osnovna tržišna izvješća") vs. `:1807`/`:1825` ("Puna dubina analize") — `analiza.mjs:24-46` koristi isti prompt i isti `max_tokens` za sve planove; `index.html:1731` ("ROI kalkulator"), `index.html:1745` ("Brendirani izvještaj")
- **Problem:** Plaćeni plan obećava razlike koje ne postoje — rizik po zaštitu potrošača i povrate novca.
- **Prijedlog:** uskladiti tekst cjenika sa stvarnim značajkama ili implementirati razlike.

### V14. Escape ili klik izvan modala briše zalijepljeni oglas
- **Gdje:** `index.html:2211-2213` (Escape uvijek zove `closeModal`), `index.html:2201-2205` (`closeModal` → `resetForm` nakon 300 ms), `index.html:2207-2209` (klik na overlay)
- **Problem:** Slučajan Escape ili klik pored modala nepovratno briše ime, email i dugi tekst oglasa.
- **Prijedlog:** ne resetirati formu pri zatvaranju (samo nakon uspješnog slanja) ili tražiti potvrdu kad polja nisu prazna.

### V15. Exit-intent popup iskače preko otvorenog modala s formom
- **Gdje:** `index.html:2092-2110`
- **Problem:** `showExit` ne provjerava je li modal otvoren; dok korisnik prelazi mišem prema traci preglednika (npr. da kopira oglas iz druge kartice!), popup "Čekaj!" prekrije formu. Upravo tipičan tijek "kopiraj s Njuškala" ga okida.
- **Prijedlog:** ne prikazivati popup dok je `#modal.open` ili nakon što je korisnik već otvorio formu.

---

## 🟡 Sitno

### S1. `thank-you.html` ima zastarjeli i netočan tekst
- **Gdje:** `thank-you.html:155` — "Vaša analiza je u tijeku. Provjerite email za rezultate."
- Analize se ne šalju emailom. Ako je ova stranica success URL Payment Linka, usto ne mjeri kupnju (nema `consent.js` ni logike iz `index.html:2295`) i ne objašnjava da se za plaćeni plan mora koristiti isti email (V4).

### S2. Plan u mjerenju je uvijek "free"; `plan` i `session_id` se šalju a ignoriraju
- **Gdje:** `index.html:2248-2249`, `rezultat.html:707`, `index.html:2286`
- `data.plan` dolazi iz URL-a (`?plan=`), pa je kod plaćenih korisnika gotovo uvijek prazan → `analysis_success` se bilježi kao free. Funkcija ga s pravom ignorira (`analiza.mjs:183`), ali bi mogla vratiti stvarni plan u `kraj` događaju.

### S3. `purchase-status` ne prepoznaje pretplatu bez naplate
- **Gdje:** `netlify/functions/purchase-status.js:36`
- Uz probni period ili 100 % kupon Stripe vraća `payment_status: 'no_payment_required'` → `paid: false`, konverzija se ne mjeri.

### S4. Ključ za statistiku u query stringu
- **Gdje:** `netlify/functions/stats.js:27`
- `?key=` završava u povijesti preglednika i logovima. Bolje zaglavlje (`Authorization: Bearer …`).

### S5. Sol za hash emaila pada na Anthropic API ključ
- **Gdje:** `netlify/functions/analiza.mjs:72-75`
- Ako `ZAHTJEVI_SALT` nije postavljen, kao HMAC ključ koristi se API ključ — rotacija ključa mijenja sve hasheve (prekida zaštitu od F5 u tom trenutku) i miješa namjene tajni. Postaviti zasebnu env varijablu.

### S6. Nepotpuno escapiranje u Stripe Search upitu
- **Gdje:** `netlify/lib/stripe-plan.js:45`
- Escapira se samo `'`, ne i `\`; email s backslashom može razbiti upit. Rješava se validacijom emaila iz V2.

### S7. Brisanje starih zapisa zahtjeva lista cijeli store na svaki upis
- **Gdje:** `netlify/functions/analiza.mjs:92-95`
- `store.list()` bez prefiksa pri svakom upisu — s rastom prometa (do 24 h zapisa) sve sporije i skuplje. Dovoljno je čistiti povremeno (npr. 1 od 50 zahtjeva) ili zakazanom funkcijom.

### S8. Model i parametri su hardkodirani
- **Gdje:** `netlify/functions/analiza.mjs:286-287`
- `claude-sonnet-4-6` i `max_tokens: 1600` — izdvojiti u env varijablu da se model može mijenjati bez deploya.

### S9. Beskonačna `requestAnimationFrame` petlja i 3D tilt troše CPU/bateriju
- **Gdje:** `index.html:2133-2154` (spotlight se iscrtava 60×/s i kad se miš ne miče), `index.html:2156-2183` (tilt)
- JS animacije ne poštuju `prefers-reduced-motion` (CSS pravilo postoji samo u `rezultat.html:335`). Petlju zaustaviti kad je pomak zanemariv; na touch uređajima ne pokretati.

### S10. Mrtav kod u `index.html`
- **Gdje:** `index.html:2215-2225` (`detectRecommendation` se nigdje ne poziva), `index.html:1990-2004` (`#form-success` blok — forma uvijek preusmjerava na `rezultat.html`), `index.html:2191-2199` (`resetForm` čisti taj blok)

### S11. Modal nije pristupačan
- **Gdje:** `index.html:1953` (`.modal-overlay`), `index.html:2186-2189` (`openModal`)
- Nema `role="dialog"`/`aria-modal`, fokus se ne premješta u formu niti zadržava unutar modala.

### S12. Testovi traju ~55 s zbog mocka koji ignorira `abort`
- **Gdje:** `tests/pretplata.test.mjs:363-367`
- Lažni stream u testu "preglednik prekine vezu…" ne reagira na `signal`, pa `reader.read()` u `procitajClaudeStream` visi dok ne istekne 55-sekundni timer (`analiza.mjs:274`). Pojedinačni testovi traju milisekunde; mock bi trebao zatvoriti stream na `signal.abort`.

### S13. Pravo na odustanak — provjeriti s pravnikom
- **Gdje:** `uvjeti-koristenja.html:154`
- Pristanak na gubitak prava na odustanak "pokretanjem prve analize" možda nije dovoljan — obično se traži izričita privola i potvrda **prije** početka isporuke (npr. checkbox na checkoutu). Nije pravni savjet, samo rizik za provjeru.

### S14. SEO sitnice
- **Gdje:** `sitemap.xml:5` (`lastmod` 2026-04-06), `sitemap.xml` sadrži samo početnu (bez pravnih stranica); `index.html:13` `meta keywords` se ne koristi.

---

## Preporučeni redoslijed

1. **K1 + K2** (potvrda emaila + rate limit + CORS) — najveći financijski rizik, jedno rješenje pokriva oba.
2. **K3 + K4** (DOMPurify, fiksirana verzija `marked` sa SRI) — malo posla, velik učinak.
3. **K5, V1, V2, V3** — logika limita i ulaza u `analiza.mjs`.
4. **V4, V5, V7, S1** — Stripe tok i otkazivanje.
5. Ostalo prema dostupnom vremenu.
