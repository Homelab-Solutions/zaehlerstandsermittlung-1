(function () {
  const select = document.getElementById('meterTypeIds');
  const vonFeld = document.getElementById('von');
  const bisFeld = document.getElementById('bis');
  const vorjahrBox = document.getElementById('vorjahr');
  const ladenKnopf = document.getElementById('diagramm-laden');
  const verbrauchTabelle = document.getElementById('verbrauch-tabelle');
  let chart = null;

  const FARBEN = ['#2663a3', '#a15c00', '#1e7a34', '#8e3b8e', '#b3261e', '#2a9d8f'];

  function ausgewaehlteIds() {
    return Array.from(select.selectedOptions).map((o) => o.value);
  }

  async function diagrammLaden() {
    const ids = ausgewaehlteIds();
    if (ids.length === 0) return;
    const params = new URLSearchParams({ meterTypeIds: ids.join(',') });
    if (vonFeld.value) params.set('von', vonFeld.value);
    if (bisFeld.value) params.set('bis', bisFeld.value);
    if (vorjahrBox.checked) params.set('vorjahr', '1');

    const res = await fetch('/api/diagramme/daten?' + params.toString());
    const daten = await res.json();

    const datasets = [];
    const verbrauchZeilen = [];
    let farbIndex = 0;

    daten.reihen.forEach((reihe) => {
      reihe.segmente.forEach((segment) => {
        const farbe = FARBEN[farbIndex % FARBEN.length];
        farbIndex++;
        const richtungText = segment.richtung === 'verbrauch' ? ' (Verbrauch)' : segment.richtung === 'einspeisung' ? ' (Einspeisung)' : (segment.teil === 'kwh' ? ' (kWh)' : segment.teil === 'm3' ? ' (m³)' : '');
        const label = `${reihe.meterType.label}${richtungText} - Zähler ${segment.meter.number}${reihe.vorjahr ? ' (Vorjahr)' : ''}`;
        datasets.push({
          label,
          data: segment.punkte.map((p) => ({ x: new Date(p.reading.reading_at).getTime(), y: Number(p.reading.value) })),
          borderColor: farbe,
          backgroundColor: farbe,
          pointStyle: segment.punkte.map((p) => (p.geschaetzt ? 'rectRot' : p.anomalie ? 'crossRot' : 'circle')),
          pointRadius: segment.punkte.map((p) => (p.geschaetzt || p.anomalie ? 6 : 3)),
          spanGaps: true,
          tension: 0.1,
        });

        segment.punkte.forEach((p, i) => {
          if (i === 0) return;
          const vorher = segment.punkte[i - 1];
          verbrauchZeilen.push({
            zaehlerart: reihe.meterType.label + richtungText,
            zaehler: segment.meter.number,
            von: vorher.reading.reading_at,
            bis: p.reading.reading_at,
            verbrauch: p.verbrauch,
            anomalie: p.anomalie,
            geschaetzt: p.geschaetzt,
            vorjahr: reihe.vorjahr,
          });
        });
      });
    });

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('zaehler-chart'), {
      type: 'line',
      data: { datasets },
      options: {
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Datum' },
            ticks: { callback: (value) => new Date(value).toLocaleDateString('de-DE') },
          },
          y: { title: { display: true, text: 'Zählerstand' } },
        },
        plugins: { legend: { position: 'bottom' } },
      },
    });

    renderVerbrauchTabelle(verbrauchZeilen);
  }

  function renderVerbrauchTabelle(zeilen) {
    if (zeilen.length === 0) {
      verbrauchTabelle.innerHTML = '<p class="text-schwach">Keine Daten im gewählten Zeitraum.</p>';
      return;
    }
    const zeilenHtml = zeilen
      .map((z) => {
        const datumVon = new Date(z.von).toLocaleDateString('de-DE');
        const datumBis = new Date(z.bis).toLocaleDateString('de-DE');
        let wert = '-';
        if (z.anomalie) wert = '<span class="text-fehler">nicht ermittelbar</span>';
        else if (z.verbrauch !== null) wert = z.verbrauch.toFixed(3);
        const hinweise = [];
        if (z.geschaetzt) hinweise.push('geschätzt');
        if (z.vorjahr) hinweise.push('Vorjahr');
        return `<tr><td>${z.zaehlerart}</td><td>${z.zaehler}</td><td>${datumVon} - ${datumBis}</td><td>${wert}</td><td>${hinweise.join(', ')}</td></tr>`;
      })
      .join('');
    verbrauchTabelle.innerHTML = `<table class="tabelle"><thead><tr><th>Zählerart</th><th>Zähler</th><th>Zeitraum</th><th>Verbrauch</th><th>Hinweis</th></tr></thead><tbody>${zeilenHtml}</tbody></table>`;
  }

  ladenKnopf.addEventListener('click', diagrammLaden);

  document.getElementById('prognose-laden').addEventListener('click', async () => {
    const meterTypeId = document.getElementById('prognose-typ').value;
    const tage = document.getElementById('prognose-tage').value;
    const res = await fetch(`/api/diagramme/prognose?meterTypeId=${meterTypeId}&tage=${tage}`);
    const p = await res.json();
    const ziel = document.getElementById('prognose-ergebnis');
    if (!p.moeglich) {
      ziel.innerHTML = `<p class="text-schwach">Keine Prognose möglich: ${p.einschraenkungen ? p.einschraenkungen.join(' ') : 'nicht genug Daten.'}</p>`;
      return;
    }
    let html = '';
    if (p.grob) html += '<p class="chip chip-warnung">GROBE SCHÄTZUNG</p>';
    html += `<p>Methode: ${p.methode}<br>Datengrundlage: ${p.datengrundlage}<br>`;
    html += `Prognose für ${p.prognoseTage} Tage: <strong>${p.prognoseWert.toFixed(2)}</strong> (ca. ${p.avgProTag.toFixed(4)} pro Tag im Schnitt)</p>`;
    if (p.vorjahresvergleich) {
      html += `<p>Vorjahresvergleich (gleicher Zeitraum vor einem Jahr): ${p.vorjahresvergleich.wert.toFixed(2)} (${p.vorjahresvergleich.intervalle} Messintervall(e))</p>`;
    } else {
      html += '<p class="text-schwach">Kein Vorjahreszeitraum mit Daten verfügbar.</p>';
    }
    html += `<ul class="text-schwach">${p.einschraenkungen.map((e) => `<li>${e}</li>`).join('')}</ul>`;
    ziel.innerHTML = html;
  });
})();
