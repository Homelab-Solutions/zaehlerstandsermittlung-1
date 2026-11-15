(function () {
  const kameraInput = document.getElementById('foto-kamera-input');
  const dateiInput = document.getElementById('foto-datei-input');
  const analysierenKnopf = document.getElementById('foto-analysieren-knopf');
  const statusBox = document.getElementById('foto-status');
  const ladeAnzeige = document.getElementById('foto-lade-anzeige');
  const vorschauBild = document.getElementById('foto-vorschau');
  const fotoTempIdFeld = document.getElementById('foto_temp_id');
  const fotoSpeichernZeile = document.getElementById('foto-speichern-zeile');
  const erfassungswegFeld = document.getElementById('erfassungsweg');
  const wertFeld = document.getElementById('wert');
  const meterSelect = document.getElementById('meter_id');
  const formular = document.getElementById('messwert-formular');
  const speichernKnopf = document.getElementById('messwert-speichern-knopf');

  let ausgewaehlteDatei = null;
  let laeuftAnalyse = false;

  // KI-Verfuegbarkeit wird im Hintergrund geprueft (kein Foto-Upload, keine
  // Bildanalyse) - solange kein Ergebnis vorliegt oder die Pruefung "nicht
  // verfuegbar" ergibt, bleibt die Foto-Erkennung ausgeblendet statt scheinbar
  // verfuegbar zu wirken. Der farbige Punkt zeigt den Status zusaetzlich visuell
  // an (gruen/pulsierend = verfuegbar, erst NACH erfolgreicher Pruefung).
  const kiStatusFeld = document.getElementById('ki-status');
  const kiStatusPunkt = document.getElementById('ki-status-punkt');
  const fotoAktionenBereich = document.getElementById('foto-aktionen-bereich');
  function kiStatusAnzeigen(text, klasse) {
    if (kiStatusPunkt) kiStatusPunkt.className = 'ki-status-punkt ' + klasse;
    if (kiStatusFeld) {
      kiStatusFeld.textContent = '';
      if (kiStatusPunkt) kiStatusFeld.appendChild(kiStatusPunkt);
      kiStatusFeld.appendChild(document.createTextNode(' ' + text));
    }
  }
  if (kiStatusFeld) {
    fetch('/api/ki/status')
      .then((r) => r.json())
      .then((s) => {
        if (s.verfuegbar) {
          kiStatusAnzeigen('KI-Fotoerkennung verfügbar.', 'ki-status-punkt-verfuegbar');
          if (fotoAktionenBereich) fotoAktionenBereich.classList.remove('verborgen');
        } else {
          kiStatusAnzeigen('KI-Fotoerkennung derzeit nicht verfügbar' + (s.meldung ? ': ' + s.meldung : '.') + ' Die manuelle Erfassung unten funktioniert uneingeschränkt.', 'ki-status-punkt-nicht-verfuegbar');
        }
      })
      .catch(() => {
        kiStatusAnzeigen('KI-Verfügbarkeit konnte nicht geprüft werden. Die manuelle Erfassung unten funktioniert uneingeschränkt.', 'ki-status-punkt-nicht-verfuegbar');
      });
  }

  // Stromzaehler (Einheit kWh, "strom" im technischen Schluessel): Verbrauch
  // (OBIS 1.8.0) und Einspeisung (OBIS 2.8.0) gemeinsam erfassbar. Waerme-
  // mengenzaehler (vom Server als waermeKombi markiert): kWh (Hauptfeld) und
  // m³ sind beide Pflicht. Fuer andere Zaehlerarten bleiben beide Zusatzfelder
  // verborgen.
  const einspeisungZeile = document.getElementById('einspeisung-zeile');
  const einspeisungFeld = document.getElementById('wert_einspeisung');
  const waermeM3Zeile = document.getElementById('waerme-m3-zeile');
  const waermeM3Feld = document.getElementById('wert_m3');
  const wertLabelText = document.getElementById('wert-label-text');
  function istStromZaehler(meter) {
    return Boolean(meter) && meter.typeUnit === 'kWh' && /strom/i.test(meter.typeKey || '');
  }
  // Eindeutige Feldbeschriftung je Zaehlerart (Auftrag "Eindeutige Beschriftung
  // der Messfelder"): Stromzaehler nennen OBIS-Kennzahl + Einheit, Waerme-
  // mengenzaehler die Messgroesse (Waermemenge/Volumen) je Einheit, alle
  // anderen Zaehlerarten "Zaehlerstand (<Einheit>)".
  function stromfeldAktualisieren() {
    const liste = window.__ZAEHLER_LISTE__ || [];
    const gewaehlt = liste.find((z) => String(z.id) === meterSelect.value);
    const strom = istStromZaehler(gewaehlt);
    const waermeKombi = Boolean(gewaehlt && gewaehlt.waermeKombi);
    if (einspeisungZeile) einspeisungZeile.classList.toggle('verborgen', !strom);
    if (!strom && einspeisungFeld) einspeisungFeld.value = '';
    if (waermeM3Zeile) waermeM3Zeile.classList.toggle('verborgen', !waermeKombi);
    if (waermeM3Feld) {
      waermeM3Feld.required = waermeKombi;
      if (!waermeKombi) waermeM3Feld.value = '';
    }
    if (wertLabelText) {
      if (strom) {
        wertLabelText.textContent = 'Bezug (OBIS 1.8.0) (kWh)';
      } else if (waermeKombi) {
        wertLabelText.textContent = 'Wärmemenge (kWh)';
      } else if (gewaehlt && gewaehlt.typeUnit) {
        wertLabelText.textContent = `Zählerstand (${gewaehlt.typeUnit})`;
      } else {
        wertLabelText.textContent = 'Zählerstand';
      }
    }
  }
  if (meterSelect) {
    meterSelect.addEventListener('change', stromfeldAktualisieren);
    stromfeldAktualisieren();
  }

  function dateiUebernehmen(datei) {
    if (!datei) return;
    ausgewaehlteDatei = datei;
    vorschauBild.src = URL.createObjectURL(datei);
    vorschauBild.style.display = 'block';
    if (analysierenKnopf) analysierenKnopf.disabled = false;
    if (statusBox) statusBox.textContent = 'Foto ausgewählt - bereit zur Analyse.';
  }

  if (kameraInput) kameraInput.addEventListener('change', () => dateiUebernehmen(kameraInput.files[0]));
  if (dateiInput) dateiInput.addEventListener('change', () => dateiUebernehmen(dateiInput.files[0]));

  // Versucht, eine von der KI erkannte Zaehlernummer eindeutig einem vorhandenen
  // Zaehler zuzuordnen. Hat der Nutzer bereits einen Zaehler gewaehlt, wird diese
  // Auswahl nie ueberschrieben; bei Mehrdeutigkeit erfolgt keine Zuordnung.
  function zaehlerVorschlagen(zaehlernummer) {
    if (!zaehlernummer || !meterSelect || meterSelect.value) return null;
    const liste = window.__ZAEHLER_LISTE__ || [];
    const gesucht = String(zaehlernummer).trim().toLowerCase();
    const treffer = liste.filter((z) => String(z.number).trim().toLowerCase() === gesucht);
    if (treffer.length === 1) {
      meterSelect.value = String(treffer[0].id);
      return treffer[0];
    }
    return null;
  }

  if (analysierenKnopf) {
    analysierenKnopf.addEventListener('click', async () => {
      if (laeuftAnalyse) return;
      if (!ausgewaehlteDatei) {
        statusBox.textContent = 'Bitte zuerst ein Foto aufnehmen oder auswählen.';
        return;
      }

      laeuftAnalyse = true;
      analysierenKnopf.disabled = true;
      if (speichernKnopf) speichernKnopf.disabled = true;
      ladeAnzeige.classList.remove('verborgen');
      ladeAnzeige.setAttribute('aria-hidden', 'false');
      statusBox.textContent = '';

      const formData = new FormData();
      formData.append('foto', ausgewaehlteDatei);

      try {
        const res = await fetch('/api/fotos/analysieren', { method: 'POST', body: formData });
        const daten = await res.json();
        if (!res.ok) {
          statusBox.textContent = daten.error || 'Fehler bei der Analyse.';
          return;
        }
        fotoTempIdFeld.value = daten.tempId;
        fotoSpeichernZeile.style.display = 'block';

        if (daten.kiStatus === 'ok' && daten.vorschlag) {
          const v = daten.vorschlag;
          let text = 'KI-Vorschlag - bitte prüfen: ';
          if (v.zaehlerstand !== null) {
            text += `Zählerstand ${v.zaehlerstand}`;
            wertFeld.value = v.zaehlerstand;
          } else {
            text += 'kein Zählerstand erkannt.';
          }
          if (v.zaehlernummer) {
            const vorschlag = zaehlerVorschlagen(v.zaehlernummer);
            text += vorschlag
              ? `, Zähler "${v.zaehlernummer}" automatisch vorausgewählt - bitte prüfen`
              : `, Zählernummer "${v.zaehlernummer}" erkannt (bitte passenden Zähler oben prüfen/auswählen)`;
          }
          if (v.confidence !== null) text += ` (Konfidenz ${Math.round(v.confidence * 100)}%)`;
          if (v.hinweis) text += ` - Hinweis: ${v.hinweis}`;
          statusBox.textContent = text;
          erfassungswegFeld.value = 'fotoanalyse';
        } else if (daten.kiStatus === 'nicht_konfiguriert') {
          statusBox.textContent = 'KI-Fotoerkennung ist nicht konfiguriert. Bitte Wert manuell eintragen.';
        } else {
          statusBox.textContent = 'KI-Fotoerkennung fehlgeschlagen (' + (daten.meldung || 'unbekannter Fehler') + '). Bitte Wert manuell eintragen.';
        }
      } catch (err) {
        statusBox.textContent = 'Verbindungsfehler bei der Fotoanalyse. Bitte Wert manuell eintragen.';
      } finally {
        laeuftAnalyse = false;
        analysierenKnopf.disabled = false;
        if (speichernKnopf) speichernKnopf.disabled = false;
        ladeAnzeige.classList.add('verborgen');
        ladeAnzeige.setAttribute('aria-hidden', 'true');
      }
    });
  }

  // Doppeltes Abschicken (z. B. Doppeltipp auf Touchscreens) verhindern.
  formular.addEventListener('submit', () => {
    if (speichernKnopf) speichernKnopf.disabled = true;
  });
})();
