// Gemeinsame, kleine Hilfsfunktionen rund um Zaehlerarten - werden sowohl von
// der Zaehlerarten-Verwaltung (admin.js) als auch von Erfassung/Auswertung
// (readings.js, consumption.js, forecast.js, dashboard.js) verwendet, damit die
// Erkennung "ist das ein Stromzaehler" und die Eichdaten-Sichtbarkeit nicht
// mehrfach, potenziell abweichend implementiert werden.

const ERLAUBTE_EINHEITEN = ['m³', 'kWh'];

// Stabiler technischer Schluessel (wird u. a. fuer die Heizungs-/Gas-Saisonlogik
// in forecast.js und hier fuer die Stromerkennung verwendet) - bleibt beim
// Bearbeiten einer Zaehlerart unveraendert, nur das Label ist editierbar.
function slugifyKey(text) {
  const basis = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return basis || 'zaehlerart';
}

// Stromzaehler = Einheit kWh und "strom" im technischen Schluessel (deckt die
// neue Zaehlerart "Strom Haus" sowie bestehende wie "Strom Mietwohnung" und
// "Heizungsstrom gesamt" ab). Nur fuer diese wird Verbrauch UND Einspeisung
// (OBIS 1.8.0 / 2.8.0) angeboten; die Einspeisung bleibt dabei optional.
function istStromTyp(meterType) {
  if (!meterType) return false;
  return meterType.unit === 'kWh' && /strom/i.test(meterType.key || '');
}

// Effektive Sichtbarkeit der Eichdaten (Eichdatum/Eichfrist) eines Zaehlers:
// ein gesetzter Override am Zaehler gewinnt, sonst die Vorgabe der Zaehlerart.
function effektivEichdatenAnzeigen(meter) {
  if (meter.eichdaten_anzeigen === null || meter.eichdaten_anzeigen === undefined) {
    return Boolean(meter.eichdaten_anzeigen_standard);
  }
  return Boolean(meter.eichdaten_anzeigen);
}

// Waermemengenzaehler = Zaehlerart mit explizitem Admin-Flag "waerme_kombi"
// (Einheit dabei immer kWh, siehe admin.js) - bei Auswahl eines solchen
// Zaehlers werden kWh UND m³ gemeinsam zum selben Ablesedatum erfasst
// (Auftrag "Messwerterfassung"). Bewusst ein eigenes, explizites Flag statt
// einer Schluessel-Heuristik wie bei istStromTyp, da bestehende Heizungs-
// Zaehlerarten (getrennte kWh-/m³-Zaehler) dadurch unveraendert bleiben.
function istWaermeKombiTyp(meterType) {
  if (!meterType) return false;
  return meterType.unit === 'kWh' && Boolean(meterType.waerme_kombi);
}

// Liefert die Unterteilung der Messwerte eines Zaehlertyps in bis zu zwei
// gemeinsam zu erfassende/auszuwertende Teilwerte (Stromrichtung bzw.
// Waerme-Teilwert), damit Erfassung, Verbrauchsberechnung, Diagramme und
// Export/Import dieselbe Logik verwenden, ohne die beiden Faelle in jeder
// Datei erneut hart zu verdrahten. `feld` ist die readings-Spalte, die den
// jeweiligen Teilwert kennzeichnet; `pflicht` markiert Werte, die (anders als
// die optionale Stromeinspeisung) immer gemeinsam gespeichert werden muessen.
function teilungFuerTyp(meterType) {
  if (istStromTyp(meterType)) {
    return { feld: 'strom_richtung', werte: ['verbrauch', 'einspeisung'], pflicht: ['verbrauch'] };
  }
  if (istWaermeKombiTyp(meterType)) {
    return { feld: 'waerme_teil', werte: ['kwh', 'm3'], pflicht: ['kwh', 'm3'] };
  }
  return { feld: null, werte: [null], pflicht: [null] };
}

// Eindeutige Anzeige eines Zaehlers als "Gruppe - Bezeichnung" (Auftrag
// "Zaehlergruppen und Berechtigungen"): die frei eingebbare Bezeichnung des
// Zaehlers gewinnt, sonst der Name der Zaehlerart; ohne Gruppe (z. B. ein noch
// nicht zugeordneter Bestandszaehler) wird nur die Bezeichnung angezeigt.
function zaehlerAnzeigeName(meter, typeLabel) {
  const bezeichnung = (meter.anzeige_bezeichnung && meter.anzeige_bezeichnung.trim()) || typeLabel;
  return meter.group_name ? `${meter.group_name} – ${bezeichnung}` : bezeichnung;
}

module.exports = {
  ERLAUBTE_EINHEITEN,
  slugifyKey,
  istStromTyp,
  istWaermeKombiTyp,
  teilungFuerTyp,
  effektivEichdatenAnzeigen,
  zaehlerAnzeigeName,
};
