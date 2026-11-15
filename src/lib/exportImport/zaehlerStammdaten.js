const knex = require('../../db/knex');
const { wendeStammdatenImportAn } = require('./importStammdaten');

// Eigenstaendige, vom Messwerte-Import/-Export VOLLSTAENDIG getrennte Funktion
// fuer Zähler-Stammdaten (Zählergruppen, Zählerarten, Zähler) OHNE Messwerte
// (Auftrag "Separater Import und Export von Zählern"). Das Dateiformat ist
// bewusst identisch zu den entsprechenden Feldern des vollstaendigen
// JSON-Exports (lib/exportImport/daten.js gatherAll()), damit beide Wege
// dieselbe, bereits getestete Anlegelogik (importStammdaten.js) nutzen koennen -
// hier jedoch ohne readings/photos/users/settings/audit_log und mit einer
// eigenen, ausfuehrlicheren Vorschau (neu/vorhanden/Konflikt je Eintrag).

const ART_KENNZEICHEN = 'zaehler_stammdaten';

async function erzeugeExport() {
  const [meterTypes, meterGroups, meters] = await Promise.all([
    knex('meter_types').select('*').orderBy('sort_order'),
    knex('meter_groups').select('*').orderBy('sort_order'),
    knex('meters').select('*').orderBy('id'),
  ]);
  return {
    art: ART_KENNZEICHEN,
    erzeugt_am: new Date().toISOString(),
    meter_types: meterTypes,
    meter_groups: meterGroups,
    meters,
  };
}

// Erkennt sowohl eine dedizierte Zähler-Stammdatenexport-Datei (art: 'zaehler_stammdaten')
// als auch einen vollstaendigen JSON-Export (lib/exportImport/daten.js), der
// dieselben Stammdaten-Felder enthaelt - beide sind fuer diesen Import gueltig.
function istGueltigeStammdatendatei(rohDaten) {
  return Boolean(rohDaten) && !Array.isArray(rohDaten)
    && (Array.isArray(rohDaten.meters) || Array.isArray(rohDaten.meter_types) || Array.isArray(rohDaten.meter_groups));
}

// Reine Lesepruefung (keine Datenbankaenderung) fuer die Vorschau: zeigt je
// Gruppe/Zählerart/Zähler, ob sie neu angelegt wuerden, bereits vorhanden sind
// (ggf. mit abweichenden Werten - diese werden nie ueberschrieben, nur als
// Hinweis angezeigt) oder einen unaufloesbaren Konflikt darstellen (wird beim
// Commit uebersprungen). Macht transparent, welcher Schluessel verglichen
// wurde: Name (Gruppen), technischer Key (Zählerarten), Zählernummer (Zähler).
async function analysiereImport(rohDaten) {
  const meterGroups = Array.isArray(rohDaten.meter_groups) ? rohDaten.meter_groups : [];
  const meterTypes = Array.isArray(rohDaten.meter_types) ? rohDaten.meter_types : [];
  const meters = Array.isArray(rohDaten.meters) ? rohDaten.meters : [];

  const vorhandeneGruppen = new Map((await knex('meter_groups').select('name')).map((g) => [g.name, g]));
  const vorhandeneTypen = new Map((await knex('meter_types').select('key', 'unit', 'waerme_kombi')).map((t) => [t.key, t]));
  const vorhandeneZaehler = new Set((await knex('meters').pluck('number')).map((n) => String(n).trim()));

  const gruppen = meterGroups.map((g) => ({
    name: g.name || '(ohne Namen)',
    schluessel: g.name,
    status: g.name && vorhandeneGruppen.has(g.name) ? 'vorhanden' : 'neu',
  }));

  const neuAngelegteTypKeys = new Set();
  const typen = meterTypes.map((t) => {
    if (!t.key) return { label: t.label || '(ohne Schlüssel)', schluessel: t.key, status: 'konflikt', grund: 'Kein technischer Schlüssel im Export angegeben.' };
    const bestehend = vorhandeneTypen.get(t.key);
    if (!bestehend) {
      neuAngelegteTypKeys.add(t.key);
      return { label: t.label || t.key, schluessel: t.key, status: 'neu' };
    }
    const einheit = t.unit === 'kWh' ? 'kWh' : 'm³';
    const abweichungen = [];
    if (bestehend.unit !== einheit) abweichungen.push(`Einheit (Export: ${einheit}, vorhanden: ${bestehend.unit})`);
    if (Boolean(bestehend.waerme_kombi) !== Boolean(t.waerme_kombi)) abweichungen.push('Wärmemengenzähler-Kennzeichen');
    return abweichungen.length > 0
      ? { label: t.label || t.key, schluessel: t.key, status: 'vorhanden_abweichend', grund: `Bleibt unverändert (wird nie überschrieben). Abweichung(en) im Export: ${abweichungen.join(', ')}.` }
      : { label: t.label || t.key, schluessel: t.key, status: 'vorhanden' };
  });

  const typKeyByOldId = new Map(meterTypes.map((t) => [t.id, t.key]));
  const zaehler = meters.map((m) => {
    const nummer = m.number ? String(m.number).trim() : '';
    if (!nummer) return { nummer: '(ohne Nummer)', status: 'konflikt', grund: 'Keine Zählernummer im Export angegeben.' };
    if (vorhandeneZaehler.has(nummer)) return { nummer, status: 'vorhanden', grund: 'Bleibt unverändert (wird nie überschrieben).' };
    const typKey = typKeyByOldId.get(m.meter_type_id);
    const typAufloesbar = typKey && (vorhandeneTypen.has(typKey) || neuAngelegteTypKeys.has(typKey));
    if (!typAufloesbar) return { nummer, status: 'konflikt', grund: 'Zählerart dieses Zählers ist im Export nicht auflösbar - wird übersprungen.' };
    return { nummer, status: 'neu' };
  });

  const zaehleStatus = (liste, status) => liste.filter((e) => e.status === status).length;
  return {
    gruppen,
    typen,
    zaehler,
    zusammenfassung: {
      gesamtGruppen: gruppen.length,
      neueGruppen: zaehleStatus(gruppen, 'neu'),
      gesamtTypen: typen.length,
      neueTypen: zaehleStatus(typen, 'neu'),
      vorhandeneAbweichendeTypen: zaehleStatus(typen, 'vorhanden_abweichend'),
      gesamtZaehler: zaehler.length,
      neueZaehler: zaehleStatus(zaehler, 'neu'),
      konflikteZaehler: zaehleStatus(zaehler, 'konflikt') + zaehleStatus(typen, 'konflikt'),
    },
  };
}

// Schreibt die Stammdaten transaktional (Alles-oder-nichts je anlegbarer
// Eintrag; bereits vorhandene Eintraege werden nie veraendert). Nutzt
// bewusst dieselbe, bereits getestete Logik wie der Messwerte-Import
// (importStammdaten.js) - keine Doppelimplementierung.
async function commitImport(rohDaten) {
  let ergebnis;
  await knex.transaction(async (trx) => {
    ergebnis = await wendeStammdatenImportAn(trx, rohDaten);
  });
  return {
    neueGruppen: ergebnis.neueGruppen,
    neueTypen: ergebnis.neueTypen,
    neueZaehler: ergebnis.neueZaehler,
    uebersprungeneZaehler: ergebnis.uebersprungeneZaehler,
  };
}

module.exports = { erzeugeExport, istGueltigeStammdatendatei, analysiereImport, commitImport };
