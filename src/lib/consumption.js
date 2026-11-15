const knex = require('../db/knex');
const { teilungFuerTyp } = require('./meterTypen');

// Verbrauch zwischen zwei aufeinanderfolgenden Messungen DESSELBEN Zaehlers.
// Bei Zaehlerwechsel beginnt die Reihe mit dem neuen meter_id neu - es wird NIE
// ueber einen Zaehlerwechsel hinweg subtrahiert (das wuerde den Verbrauch verfaelschen).
function consumptionBetween(prev, curr) {
  if (!prev || !curr || prev.meter_id !== curr.meter_id) return null;
  const diff = Number(curr.value) - Number(prev.value);
  if (diff < 0) {
    return { value: null, anomalie: true, hinweis: 'Zaehlerstand gesunken (Reset oder Fehlablesung?) - nicht in Auswertung uebernommen.' };
  }
  const ms = new Date(curr.reading_at).getTime() - new Date(prev.reading_at).getTime();
  const tage = ms > 0 ? ms / (1000 * 60 * 60 * 24) : null;
  return { value: diff, anomalie: false, tage, proTag: tage ? diff / tage : null };
}

// Letzter + vorletzter Messwert je aktivem Zaehler (fuer Dashboard). Bei
// Stromzaehlern werden Verbrauch und Einspeisung, bei Waermemengenzaehlern
// kWh und m³ getrennt gefuehrt (eigene Messreihe je Teilwert) - ein Zaehler
// kann daher zu mehreren Eintraegen fuehren. Nur die optionale Stromeinspeisung
// erscheint ausschliesslich, wenn dafuer jemals ein Wert erfasst wurde; die
// Waerme-Teilwerte sind beide Pflicht und werden daher immer angezeigt.
async function latestPerMeter() {
  const meters = await knex('meters')
    .join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .leftJoin('meter_groups', 'meters.group_id', 'meter_groups.id')
    .select(
      'meters.*',
      'meter_types.label as type_label_name',
      'meter_types.key as type_key',
      'meter_types.unit as type_unit',
      'meter_types.waerme_kombi',
      'meter_groups.name as group_name'
    )
    .where('meters.active', true)
    .orderBy('meter_types.sort_order');

  const result = [];
  for (const meter of meters) {
    const teilung = teilungFuerTyp({ key: meter.type_key, unit: meter.type_unit, waerme_kombi: meter.waerme_kombi });
    for (const wert of teilung.werte) {
      let q = knex('readings').where({ meter_id: meter.id });
      if (teilung.feld) q = q.andWhere({ [teilung.feld]: wert });
      const letzte = await q.orderBy('reading_at', 'desc').limit(2);
      const [aktuell, vorherig] = letzte;
      if (!aktuell && wert && !teilung.pflicht.includes(wert)) continue;
      const verbrauch = aktuell && vorherig ? consumptionBetween(vorherig, aktuell) : null;
      result.push({
        meter,
        richtung: teilung.feld === 'strom_richtung' ? wert : null,
        teil: teilung.feld === 'waerme_teil' ? wert : null,
        aktuell: aktuell || null,
        vorherig: vorherig || null,
        verbrauch,
      });
    }
  }
  return result;
}

// Zeitreihe aller Messwerte eines Zaehlertyps im Zeitraum, inkl. Zaehlerwechsel-Markern,
// fuer Diagramme. Liefert pro beteiligtem Zaehler eine eigene Segment-Liste. Bei
// Stromzaehlern (Verbrauch/Einspeisung) und Waermemengenzaehlern (kWh/m³) werden
// die Teilwerte als getrennte Segment-Reihen gefuehrt (sonst wuerde der Verbrauch
// faelschlich zwischen den Teilwerten berechnet, da beide zum selben Ablesedatum
// gehoeren).
async function timelineForType(meterTypeId, von, bis) {
  const meterType = await knex('meter_types').where({ id: meterTypeId }).first();
  const teilung = teilungFuerTyp(meterType);
  const meters = await knex('meters').where({ meter_type_id: meterTypeId }).orderBy('einbau_datum');
  const reihen = [];
  for (const meter of meters) {
    for (const wert of teilung.werte) {
      let q = knex('readings').where({ meter_id: meter.id });
      if (teilung.feld) q = q.andWhere({ [teilung.feld]: wert });
      const alle = await q.orderBy('reading_at', 'asc');
      if (alle.length === 0) continue;
      const imZeitraum = alle.filter((r) => {
        const t = new Date(r.reading_at).getTime();
        return (!von || t >= new Date(von).getTime()) && (!bis || t <= new Date(bis).getTime());
      });
      if (imZeitraum.length === 0) continue;
      const punkte = [];
      for (let i = 0; i < imZeitraum.length; i++) {
        const curr = imZeitraum[i];
        const prevGlobalIndex = alle.findIndex((r) => r.id === curr.id) - 1;
        const prev = prevGlobalIndex >= 0 ? alle[prevGlobalIndex] : null;
        const verbrauch = consumptionBetween(prev, curr);
        punkte.push({
          reading: curr,
          verbrauch: verbrauch && !verbrauch.anomalie ? verbrauch.value : null,
          anomalie: verbrauch ? verbrauch.anomalie : false,
          geschaetzt: curr.status === 'geschaetzt',
        });
      }
      if (punkte.length > 0) {
        reihen.push({
          meter,
          richtung: teilung.feld === 'strom_richtung' ? wert : null,
          teil: teilung.feld === 'waerme_teil' ? wert : null,
          punkte,
        });
      }
    }
  }
  return reihen;
}

// Jahresverbrauch je Zaehlerart (und bei Stromzaehlern/Waermemengenzaehlern je
// Teilwert) - Summe der Verbrauchsmengen pro Kalenderjahr, dem Jahr des
// Intervallendes (= Ablesedatum der jeweils zweiten Messung) zugeordnet. Reine
// Auswertung bereits gespeicherter Messwerte (kein Prognoseanteil) fuer
// Verbrauchsvergleiche zwischen Jahren.
async function jahresverbrauchJeTyp() {
  const typen = await knex('meter_types').orderBy('sort_order');
  const ergebnis = [];
  for (const typ of typen) {
    const teilung = teilungFuerTyp(typ);
    const meters = await knex('meters').where({ meter_type_id: typ.id });
    for (const wert of teilung.werte) {
      const jahre = new Map();
      for (const meter of meters) {
        let q = knex('readings').where({ meter_id: meter.id });
        if (teilung.feld) q = q.andWhere({ [teilung.feld]: wert });
        const alle = await q.orderBy('reading_at', 'asc');
        for (let i = 1; i < alle.length; i++) {
          const v = consumptionBetween(alle[i - 1], alle[i]);
          if (v && !v.anomalie && v.value !== null) {
            const jahr = new Date(alle[i].reading_at).getFullYear();
            const eintrag = jahre.get(jahr) || { summe: 0, intervalle: 0 };
            eintrag.summe += v.value;
            eintrag.intervalle += 1;
            jahre.set(jahr, eintrag);
          }
        }
      }
      if (jahre.size > 0) {
        ergebnis.push({
          meterType: typ,
          richtung: teilung.feld === 'strom_richtung' ? wert : null,
          teil: teilung.feld === 'waerme_teil' ? wert : null,
          jahre: [...jahre.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([jahr, w]) => ({ jahr, summe: w.summe, intervalle: w.intervalle })),
        });
      }
    }
  }
  return ergebnis;
}

module.exports = { consumptionBetween, latestPerMeter, timelineForType, jahresverbrauchJeTyp };
