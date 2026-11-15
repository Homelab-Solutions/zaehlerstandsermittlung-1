const knex = require('../../db/knex');

// Ergaenzung zum Messwerte-Import (Auftrag Abschnitt 2): ein vollstaendiger
// JSON-Export (lib/exportImport/daten.js gatherAll()) enthaelt neben den
// Messwerten auch die Zaehler-Stammdaten (meter_groups, meter_types, meters).
// Auf einem frischen oder zurueckgesetzten System (wo Zaehler evtl. noch nicht
// angelegt sind) werden fehlende Stammdaten hier automatisch ergaenzt, BEVOR
// die Messwerte zugeordnet werden - CSV/Excel-Importe (nur Messwerte, kein
// `stammdaten`-Objekt) sind davon unberuehrt und verlangen weiterhin bereits
// vorhandene Zaehler (siehe importValidate.js).
//
// Bewusst NICHT Teil dieses Imports: Benutzerkonten, Fotos, Einstellungen,
// Audit-Protokoll - diese Teile des JSON-Exports werden ignoriert. Eine volle
// Wiederherstellung dieser Daten ist Aufgabe von "Vollbackup / Wiederherstellung"
// (lib/backup.js), nicht der schnelleren, weniger abgesicherten Import-Funktion.
// Ebenso NICHT uebernommen: `ersetzt_meter_id` (Zaehlerwechsel-Verknuepfung) -
// die exportierten IDs passen nicht zu den neu vergebenen IDs dieses Imports;
// eine Zaehlerwechsel-Historie muesste danach manuell in der Zaehlerverwaltung
// nachgetragen werden (siehe README, "Bekannte Einschränkungen").

function istVollstaendigerExport(rohDaten) {
  return Boolean(rohDaten) && !Array.isArray(rohDaten)
    && (Array.isArray(rohDaten.meters) || Array.isArray(rohDaten.meter_types));
}

// Reine Lesepruefung fuer die Vorschau - veraendert nichts an der Datenbank.
async function planeStammdatenImport(rohDaten) {
  const meterGroups = Array.isArray(rohDaten.meter_groups) ? rohDaten.meter_groups : [];
  const meterTypes = Array.isArray(rohDaten.meter_types) ? rohDaten.meter_types : [];
  const meters = Array.isArray(rohDaten.meters) ? rohDaten.meters : [];

  const vorhandeneGruppen = new Set(await knex('meter_groups').pluck('name'));
  const vorhandeneTypen = new Set(await knex('meter_types').pluck('key'));
  const vorhandeneZaehler = new Set((await knex('meters').pluck('number')).map((n) => String(n).trim()));

  return {
    neueGruppen: [...new Set(meterGroups.map((g) => g.name).filter((n) => n && !vorhandeneGruppen.has(n)))],
    neueTypen: meterTypes.filter((t) => t.key && !vorhandeneTypen.has(t.key)).map((t) => t.label || t.key),
    neueZaehler: meters.filter((m) => m.number && !vorhandeneZaehler.has(String(m.number).trim())).map((m) => String(m.number).trim()),
    gesamtGruppen: meterGroups.length,
    gesamtTypen: meterTypes.length,
    gesamtZaehler: meters.length,
  };
}

// Legt fehlende Stammdaten innerhalb der laufenden Import-Transaktion an.
// Reihenfolge wichtig: Gruppen/Zaehlerarten zuerst, da Zaehler darauf verweisen.
// Bereits vorhandene Eintraege (gleicher Name/Key/Nummer) werden NIE veraendert
// oder ueberschrieben, nur fehlende ergaenzt.
async function wendeStammdatenImportAn(trx, rohDaten) {
  const meterGroups = Array.isArray(rohDaten.meter_groups) ? rohDaten.meter_groups : [];
  const meterTypes = Array.isArray(rohDaten.meter_types) ? rohDaten.meter_types : [];
  const meters = Array.isArray(rohDaten.meters) ? rohDaten.meters : [];

  // Alte (Export-)IDs -> Name/Key, um die Referenzen der Zaehler (group_id,
  // meter_type_id) innerhalb des Exports aufzuloesen - unabhaengig davon, ob
  // diese IDs in der Ziel-Datenbank noch etwas anderes bedeuten.
  const altGruppeNameByOldId = new Map(meterGroups.map((g) => [g.id, g.name]));
  const altTypKeyByOldId = new Map(meterTypes.map((t) => [t.id, t.key]));

  const gruppeIdByName = new Map((await trx('meter_groups').select('id', 'name')).map((g) => [g.name, g.id]));
  let neueGruppen = 0;
  for (const g of meterGroups) {
    if (!g.name || gruppeIdByName.has(g.name)) continue;
    const [id] = await trx('meter_groups').insert({ name: g.name, sort_order: Number(g.sort_order) || 0, active: g.active !== false });
    gruppeIdByName.set(g.name, id);
    neueGruppen++;
  }

  const typIdByKey = new Map((await trx('meter_types').select('id', 'key')).map((t) => [t.key, t.id]));
  let neueTypen = 0;
  for (const t of meterTypes) {
    if (!t.key || typIdByKey.has(t.key)) continue;
    const [id] = await trx('meter_types').insert({
      key: t.key,
      label: t.label || t.key,
      unit: t.unit === 'kWh' ? 'kWh' : 'm³',
      sort_order: Number(t.sort_order) || 0,
      active: t.active !== false,
      betreiber_versorger_standard: Boolean(t.betreiber_versorger_standard),
      eichdaten_anzeigen_standard: t.eichdaten_anzeigen_standard !== false,
      waerme_kombi: Boolean(t.waerme_kombi),
    });
    typIdByKey.set(t.key, id);
    neueTypen++;
  }

  const meterIdByNumber = new Map((await trx('meters').select('id', 'number')).map((m) => [String(m.number).trim(), m.id]));
  let neueZaehler = 0;
  // Zaehler, die NICHT angelegt werden konnten, weil ihre Zaehlerart im Export
  // weder vorhanden noch dort selbst auflösbar war - wird dem Aufrufer
  // zurueckgegeben, damit das nach dem Commit transparent gemeldet werden kann
  // (Auftrag "Zähler-Stammdaten Import/Export": unaufgeloeste Konflikte sichtbar
  // machen statt sie stillschweigend zu verwerfen).
  const uebersprungeneZaehler = [];
  for (const m of meters) {
    const nummer = m.number ? String(m.number).trim() : '';
    if (!nummer || meterIdByNumber.has(nummer)) continue;
    const typKey = altTypKeyByOldId.get(m.meter_type_id);
    const meterTypeId = typKey ? typIdByKey.get(typKey) : null;
    if (!meterTypeId) {
      uebersprungeneZaehler.push({ number: nummer, grund: 'Zählerart im Export nicht auflösbar.' });
      continue;
    }
    const gruppenName = altGruppeNameByOldId.get(m.group_id);
    const [neueId] = await trx('meters').insert({
      meter_type_id: meterTypeId,
      number: nummer,
      manufacturer: m.manufacturer || null,
      messbetreiber: m.messbetreiber || null,
      type_label: m.type_label || null,
      unit: m.unit || 'm³',
      eich_datum: m.eich_datum || null,
      eich_frist: m.eich_frist || null,
      einbau_datum: m.einbau_datum || null,
      ausbau_datum: m.ausbau_datum || null,
      bemerkung: m.bemerkung || null,
      active: m.active !== false,
      betreiber_typ: ['eigentuemer', 'energieversorger'].includes(m.betreiber_typ) ? m.betreiber_typ : 'eigentuemer',
      eichfrist_benachrichtigen: m.eichfrist_benachrichtigen !== false,
      eichdaten_anzeigen: m.eichdaten_anzeigen === null || m.eichdaten_anzeigen === undefined ? null : Boolean(m.eichdaten_anzeigen),
      group_id: gruppenName ? gruppeIdByName.get(gruppenName) || null : null,
      anzeige_bezeichnung: m.anzeige_bezeichnung || null,
    });
    meterIdByNumber.set(nummer, neueId);
    neueZaehler++;
  }

  return { neueGruppen, neueTypen, neueZaehler, meterIdByNumber, uebersprungeneZaehler };
}

module.exports = { istVollstaendigerExport, planeStammdatenImport, wendeStammdatenImportAn };
