(function () {
  var knopf = document.getElementById('nav-umschalter');
  var nav = document.getElementById('hauptnav');
  if (!knopf || !nav) return;

  function schliessen() {
    nav.classList.remove('offen');
    knopf.setAttribute('aria-expanded', 'false');
  }

  knopf.addEventListener('click', function () {
    var offen = nav.classList.toggle('offen');
    knopf.setAttribute('aria-expanded', offen ? 'true' : 'false');
  });

  // Nach Klick auf einen Link das mobile Menue schliessen (Navigation bleibt
  // beim naechsten Seitenaufruf ohnehin zu).
  nav.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', schliessen);
  });

  // Beim Wechsel auf eine breite Ansicht (z. B. Tablet-Drehung) Menuezustand
  // zuruecksetzen, damit es auf Desktop nicht "haengen" bleibt.
  window.addEventListener('resize', function () {
    if (window.innerWidth > 860) schliessen();
  });
})();
