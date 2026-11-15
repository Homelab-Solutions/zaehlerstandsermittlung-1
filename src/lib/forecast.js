const knex = require('../db/knex');
const { consumptionBetween } = require('./consumption');
const { teilungFuerTyp } = require('./meterTypen');

// Heizperiode als plausible Ausgangsannahme: ca. Oktober bis Mai. Dient nur der
// saisonalen PROGNOSE (Anzeige) - nirgends fuer echte Messwerte/Abrechnung verwendet.
const HEIZMONATE = new Set([10, 11, 12, 1, 2, 3, 4, 5]);

function istHeizmonat(datum) {
  return HEIZMONATE.has(datum.getMonth() + 1);
}

function segmentMitte(s) {
  return new Date((new Date(s.von).getTime() + new Date(s.bis).getTime()) / 2);
}

function tagesrateAus(segs) {
  const summeWert = segs.reduce((a, s) => a + s.wert, 0);
  const summeTage = segs.reduce((a, s) => a + s.tage, 0);
  return summeTage > 0 ? summeWert / summeTage : null;
}

function istHeizungTyp(meterType) {
  return /heizung/i.test(meterType.key || '');
}

function istGasTyp(meterType) {
  return /gas/i.test(meterType.key || '');
}

async function sammleSegmente(meterTypeId, { feld = null, wert = null } = {}) {
  const meters = await knex('meters').where({ meter_type_id: meterTypeId });
  const segmente = [];
  for (const meter of meters) {
    let q = knex('readings').where({ meter_id: meter.id });
    if (feld) q = q.andWhere({ [feld]: wert });
    const alle = await q.orderBy('reading_at', 'asc');
    for (let i = 1; i < alle.length; i++) {
      const v = consumptionBetween(alle[i - 1], alle[i]);
      if (v && !v.anomalie && v.tage) {
        segmente.push({ von: alle[i - 1].reading_at, bis: alle[i].reading_at, wert: v.value, tage: v.tage });
      }
    }
  }
  return segmente;
}

// Tagesraten getrennt nach Heizmonaten/Sommermonaten (Mitte des Messintervalls
// entscheidet die Zuordnung).
function saisonaleRaten(segmente) {
  const heiz = segmente.filter((s) => istHeizmonat(segmentMitte(s)));
  const sommer = segmente.filter((s) => !istHeizmonat(segmentMitte(s)));
  return { rateHeiz: tagesrateAus(heiz), rateSommer: tagesrateAus(sommer), anzahlHeiz: heiz.length, anzahlSommer: sommer.length };
}

// Gesamtdurchschnitt pro Tag (max. letzte 365 Tage mit Daten, sonst alles) - die
// bisherige, nicht-saisonale Methode; dient weiterhin fuer Zaehlerarten ohne
// Heizungs-/Gas-Sonderlogik sowie als klar gekennzeichneter Grob-Fallback.
function flacheRate(segmente) {
  const jetzt = Date.now();
  const einJahrMs = 365 * 24 * 60 * 60 * 1000;
  const relevante = segmente.filter((s) => jetzt - new Date(s.bis).getTime() <= einJahrMs);
  const basis = relevante.length > 0 ? relevante : segmente;
  return tagesrateAus(basis);
}

// Summiert eine tagesgenaue Rate (abhaengig von Heiz-/Sommermonat) ueber einen
// Zeitraum auf - Grundlage sowohl fuer die N-Tage-Prognose als auch fuer den
// voraussichtlichen aktuellen Stand.
function hochrechnungUeberZeitraum(von, tageAnzahl, rateFn) {
  let summe = 0;
  const ganzeTage = Math.floor(tageAnzahl);
  const restTag = tageAnzahl - ganzeTage;
  const tag = new Date(von);
  tag.setHours(12, 0, 0, 0);
  for (let i = 0; i < ganzeTage; i++) {
    summe += rateFn(tag);
    tag.setDate(tag.getDate() + 1);
  }
  if (restTag > 0) summe += rateFn(tag) * restTag;
  return summe;
}

// Kernstueck der Prognoselogik: ermittelt den voraussichtlichen Zuwachs ueber
// `tageAnzahl` Tage ab `von`, je nach Zaehlerart mit saisonaler Logik (Heizung,
// Gas) oder als einfacher Durchschnitt (alle anderen Zaehlerarten).
function schaetzeZuwachs({ meterType, segmente, von, tageAnzahl }) {
  if (!meterType || segmente.length === 0 || tageAnzahl <= 0) return { moeglich: false };

  const heiz = istHeizungTyp(meterType);
  const gas = istGasTyp(meterType);

  if (heiz || gas) {
    const { rateHeiz, rateSommer, anzahlHeiz, anzahlSommer } = saisonaleRaten(segmente);

    if (heiz && anzahlHeiz > 0) {
      const rateAusserhalb = anzahlSommer > 0 ? rateSommer : 0;
      const zuwachs = hochrechnungUeberZeitraum(von, tageAnzahl, (tag) => (istHeizmonat(tag) ? rateHeiz : rateAusserhalb));
      return {
        moeglich: true,
        zuwachs,
        grob: false,
        methode: 'Saisonale Hochrechnung (Heizperiode ca. Oktober-Mai getrennt von den Sommermonaten betrachtet)',
        einschraenkungen: [
          `Heizperiode: ca. ${rateHeiz.toFixed(4)} Einheiten/Tag aus ${anzahlHeiz} Messintervall(en).`,
          anzahlSommer > 0
            ? `Außerhalb der Heizperiode: ca. ${rateSommer.toFixed(4)} Einheiten/Tag aus ${anzahlSommer} Messintervall(en).`
            : 'Außerhalb der Heizperiode liegen noch keine Messintervalle vor - für diese Tage wird kein Verbrauch angenommen.',
          'Saisonale Schätzung auf Basis der Messhistorie, keine KI-Prognose; Witterung und Nutzungsverhalten können abweichen.',
        ],
      };
    }

    if (gas && anzahlSommer > 0 && anzahlHeiz > 0) {
      const grundrate = rateSommer;
      const zusatzrate = Math.max(0, rateHeiz - rateSommer);
      const zuwachs = hochrechnungUeberZeitraum(von, tageAnzahl, (tag) => grundrate + (istHeizmonat(tag) ? zusatzrate : 0));
      return {
        moeglich: true,
        zuwachs,
        grob: false,
        methode: 'Saisonale Hochrechnung: ganzjähriger Grundverbrauch (Warmwasser, aus den Sommermonaten) plus zusätzlicher Verbrauch in der Heizperiode',
        einschraenkungen: [
          `Grundverbrauch (ganzjährig, aus Sommermonaten): ca. ${grundrate.toFixed(4)} Einheiten/Tag aus ${anzahlSommer} Messintervall(en).`,
          `Zusätzlicher Verbrauch in der Heizperiode: ca. ${zusatzrate.toFixed(4)} Einheiten/Tag aus ${anzahlHeiz} Messintervall(en).`,
          'Saisonale Schätzung auf Basis der Messhistorie, keine KI-Prognose; Witterung und Nutzungsverhalten können abweichen.',
        ],
      };
    }

    // Noch nicht genug Daten aus Heizperiode UND Sommermonaten fuer eine saisonale
    // Aufteilung - klar als grobe Schaetzung gekennzeichneter Fallback statt einer
    // falsch sicher wirkenden saisonalen Zahl.
    const rate = flacheRate(segmente);
    if (rate === null) return { moeglich: false };
    return {
      moeglich: true,
      zuwachs: rate * tageAnzahl,
      grob: true,
      methode: 'Grobe Schätzung (Gesamtdurchschnitt) - Messhistorie reicht noch nicht für eine saisonale Aufteilung',
      einschraenkungen: [
        'GROBE SCHÄTZUNG: Es liegen noch nicht genug Messintervalle aus der Heizperiode UND den Sommermonaten vor, um die saisonale Logik anzuwenden.',
        'Rein statistischer Gesamtdurchschnitt, keine KI-Prognose.',
      ],
    };
  }

  const rate = flacheRate(segmente);
  if (rate === null) return { moeglich: false };
  return {
    moeglich: true,
    zuwachs: rate * tageAnzahl,
    grob: false,
    methode: 'Durchschnitt pro Tag aus Messhistorie, linear hochgerechnet',
    einschraenkungen: [
      'Rein statistische Hochrechnung auf Basis vergangener Verbrauchswerte, keine KI-Prognose.',
      'Zählerwechsel, Schätzwerte und kurze Messreihen können die Genauigkeit deutlich einschränken.',
    ],
  };
}

// Prognose ueber einen frei waehlbaren Zeitraum (Diagramme-Seite) - ausschliesslich
// Anzeige, wird nirgends gespeichert.
async function forecastForType(meterTypeId, { tageVoraus = 90 } = {}) {
  const meterType = await knex('meter_types').where({ id: meterTypeId }).first();
  // Bei Stromzaehlern/Waermemengenzaehlern beschraenkt sich diese Prognose
  // bewusst auf den jeweils ersten Teilwert (Verbrauch bzw. kWh) - die anderen
  // Teilwerte (Einspeisung bzw. m³) wuerden sonst faelschlich mit hineingerechnet,
  // da beide Werte zum selben Ablesedatum gehoeren.
  const teilung = teilungFuerTyp(meterType);
  const segmente = await sammleSegmente(meterTypeId, { feld: teilung.feld, wert: teilung.werte[0] });

  if (!meterType || segmente.length === 0) {
    return {
      methode: null,
      datengrundlage: 'keine ausreichenden Messwerte',
      moeglich: false,
      einschraenkungen: ['Es liegen noch keine zwei aufeinanderfolgenden Messungen desselben Zählers vor.'],
    };
  }

  const jetzt = new Date();
  const ergebnis = schaetzeZuwachs({ meterType, segmente, von: jetzt, tageAnzahl: tageVoraus });
  if (!ergebnis.moeglich) {
    return {
      methode: null,
      datengrundlage: 'keine ausreichenden Messwerte',
      moeglich: false,
      einschraenkungen: ['Es liegen noch keine zwei aufeinanderfolgenden Messungen desselben Zählers vor.'],
    };
  }

  const vonDatum = new Date(Math.min(...segmente.map((s) => new Date(s.von).getTime())));
  const bisDatum = new Date(Math.max(...segmente.map((s) => new Date(s.bis).getTime())));

  const einJahrMs = 365 * 24 * 60 * 60 * 1000;
  const vorjahrVon = new Date(jetzt.getTime() - tageVoraus * 24 * 60 * 60 * 1000 - einJahrMs);
  const vorjahrBis = new Date(jetzt.getTime() - einJahrMs);
  const vorjahrSegmente = segmente.filter((s) => {
    const mitte = segmentMitte(s).getTime();
    return mitte >= vorjahrVon.getTime() && mitte <= vorjahrBis.getTime();
  });
  const vorjahrSumme = vorjahrSegmente.reduce((a, s) => a + s.wert, 0);

  return {
    methode: ergebnis.methode,
    grob: ergebnis.grob,
    datengrundlage: `${segmente.length} Messintervall(e) zwischen ${vonDatum.toISOString().slice(0, 10)} und ${bisDatum.toISOString().slice(0, 10)}`,
    moeglich: true,
    avgProTag: ergebnis.zuwachs / tageVoraus,
    prognoseTage: tageVoraus,
    prognoseWert: ergebnis.zuwachs,
    vorjahresvergleich: vorjahrSegmente.length > 0 ? { tage: tageVoraus, wert: vorjahrSumme, intervalle: vorjahrSegmente.length } : null,
    einschraenkungen: ergebnis.einschraenkungen,
  };
}

// Voraussichtlicher AKTUELLER Zaehlerstand (Hochrechnung vom letzten Messwert bis
// "heute"), rein zur Information auf dem Dashboard - wird nirgends gespeichert,
// nie als Ablesung/Export-/Importwert behandelt.
async function aktuellerStandSchaetzung(meterId, { feld = null, wert = null } = {}) {
  const meter = await knex('meters').where({ id: meterId }).first();
  if (!meter) return { moeglich: false };

  let letzteQuery = knex('readings').where({ meter_id: meterId });
  if (feld) letzteQuery = letzteQuery.andWhere({ [feld]: wert });
  const letzte = await letzteQuery.orderBy('reading_at', 'desc').first();
  if (!letzte) return { moeglich: false };

  const tageSeit = (Date.now() - new Date(letzte.reading_at).getTime()) / (1000 * 60 * 60 * 24);
  if (tageSeit < 0.5) {
    return { moeglich: true, wert: Number(letzte.value), basisWert: Number(letzte.value), basisDatum: letzte.reading_at, tageSeit: 0, grob: false, methode: 'aktuelle Ablesung', einschraenkungen: [] };
  }

  const meterType = await knex('meter_types').where({ id: meter.meter_type_id }).first();
  const segmente = await sammleSegmente(meter.meter_type_id, { feld, wert });
  const ergebnis = schaetzeZuwachs({ meterType, segmente, von: new Date(letzte.reading_at), tageAnzahl: tageSeit });
  if (!ergebnis.moeglich) return { moeglich: false };

  return {
    moeglich: true,
    wert: Number(letzte.value) + ergebnis.zuwachs,
    basisWert: Number(letzte.value),
    basisDatum: letzte.reading_at,
    tageSeit: Math.round(tageSeit * 10) / 10,
    grob: ergebnis.grob,
    methode: ergebnis.methode,
    einschraenkungen: ergebnis.einschraenkungen,
  };
}

module.exports = { forecastForType, aktuellerStandSchaetzung };
