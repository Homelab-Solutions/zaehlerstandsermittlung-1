(function () {
  const downloadLink = document.getElementById('db-wechsel-download-link');
  if (!downloadLink) return;

  const token = downloadLink.dataset.token;
  const statusFeld = document.getElementById('db-wechsel-status');
  let laeuft = false;

  function statusAnzeigen(text, istFehler) {
    if (!statusFeld) return;
    statusFeld.textContent = text;
    statusFeld.className = 'text-schwach' + (istFehler ? ' meldung meldung-fehler' : '');
  }

  // Ohne JavaScript bleibt der Link ein normaler Download; Schritt 3 muss dann
  // manuell per Formular-Knopf gestartet werden (bestehender Ablauf).
  downloadLink.addEventListener('click', function (ereignis) {
    ereignis.preventDefault();
    if (laeuft) return;
    laeuft = true;
    downloadLink.setAttribute('aria-disabled', 'true');
    statusAnzeigen('Backup wird heruntergeladen, bitte warten ...', false);

    fetch(downloadLink.href, { credentials: 'same-origin' })
      .then(function (antwort) {
        if (!antwort.ok) throw new Error('Backup-Download fehlgeschlagen (Status ' + antwort.status + ').');
        return antwort.blob();
      })
      .then(function (blob) {
        // Datei lokal speichern, wie beim bisherigen direkten Link - erst wenn
        // dieser Blob vollstaendig vorliegt, gilt der Download als verarbeitet.
        const url = URL.createObjectURL(blob);
        const tempLink = document.createElement('a');
        tempLink.href = url;
        tempLink.download = 'db-wechsel-backup.json';
        document.body.appendChild(tempLink);
        tempLink.click();
        tempLink.remove();
        URL.revokeObjectURL(url);

        statusAnzeigen('Backup heruntergeladen. Migration und Verifikation starten automatisch, bitte warten ...', false);
        return fetch('/admin/datenbank/' + encodeURIComponent(token) + '/migrieren', {
          method: 'POST',
          credentials: 'same-origin',
        });
      })
      .then(function (antwort) {
        // Erfolg wie Fehler liefern eine vollstaendig gerenderte Seite mit dem
        // tatsaechlichen Ergebnis (Verifikationstabelle, Fehlertext, Schritt 4) -
        // diese ersetzt die aktuelle Seite 1:1, ohne eigene Zusatzlogik.
        return antwort.text();
      })
      .then(function (html) {
        document.open();
        document.write(html);
        document.close();
      })
      .catch(function (fehler) {
        laeuft = false;
        downloadLink.removeAttribute('aria-disabled');
        statusAnzeigen('Fehler: ' + fehler.message + ' Bitte erneut auf "Backup herunterladen" klicken oder die Seite neu laden.', true);
      });
  });
})();
