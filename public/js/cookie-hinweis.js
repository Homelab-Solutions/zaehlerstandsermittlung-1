(function () {
  // Reine Informationsmaske, kein Einwilligungszwang: diese Anwendung hat
  // aktuell keine einwilligungspflichtigen optionalen Cookies/Technologien
  // (siehe /rechtliches) - die Maske blockiert daher nichts und laesst sich
  // einfach wegklicken. Die Speicherung der Sichtbestaetigung erfolgt bewusst
  // nicht per Cookie, sondern per localStorage (kein Server-Request, keine
  // Übertragung, kein Tracking).
  var SCHLUESSEL = 'zaehlwerk_cookie_hinweis_gesehen';
  var box = document.getElementById('cookie-hinweis');
  var knopf = document.getElementById('cookie-hinweis-schliessen');
  if (!box || !knopf) return;

  try {
    if (!window.localStorage.getItem(SCHLUESSEL)) {
      box.classList.remove('verborgen');
    }
  } catch (err) {
    // localStorage nicht verfuegbar (z. B. Privatmodus mit Einschraenkungen) -
    // Hinweis dann bei jedem Aufruf zeigen, statt die Seite zu blockieren.
    box.classList.remove('verborgen');
  }

  knopf.addEventListener('click', function () {
    box.classList.add('verborgen');
    try {
      window.localStorage.setItem(SCHLUESSEL, '1');
    } catch (err) {
      // ignorieren - der Hinweis erscheint dann ggf. beim naechsten Aufruf erneut
    }
  });
})();
