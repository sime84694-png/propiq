// PropIQ — prekidač plaćanja. Jedina zastavica: PLACANJE_UKLJUCENO.
// false: gumbi planova su onemogućeni ("Uskoro"), bez linka, a ispod kartica stoji napomena.
// true: gumbi se vraćaju na Stripe linkove iz data-stripe-href i izvornu oznaku iz data-oznaka.
// Klasična skripta (UMD): u pregledniku postavlja window.PropIQPlacanje, a u Nodeu je CommonJS (za test).
(function (root, tvornica) {
  if (typeof module === 'object' && module.exports) module.exports = tvornica();
  else root.PropIQPlacanje = tvornica();
})(typeof self !== 'undefined' ? self : this, function () {
  const PLACANJE_UKLJUCENO = false;

  function primijeni(doc, uklj = PLACANJE_UKLJUCENO) {
    doc.querySelectorAll('[data-stripe-href]').forEach((a) => {
      if (uklj) {
        a.setAttribute('href', a.getAttribute('data-stripe-href'));
        a.textContent = a.getAttribute('data-oznaka');
        a.removeAttribute('aria-disabled');
      } else {
        a.removeAttribute('href');
        a.textContent = 'Uskoro';
        a.setAttribute('aria-disabled', 'true');
      }
    });
    const napomena = doc.getElementById('placanje-napomena');
    if (napomena) napomena.hidden = uklj;
  }

  return { PLACANJE_UKLJUCENO, primijeni };
});
