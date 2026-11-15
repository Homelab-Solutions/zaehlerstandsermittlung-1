const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const knex = require('../../db/knex');
const config = require('../../config');

// Keine Uhrzeit-Spalte (Auftrag "Dashboard, Importvorlage und KI-Status"):
// die Ableseuhrzeit wird beim manuellen Erfassen ohnehin nicht abgefragt
// (siehe routes/readings.js) und ist fuer den Import nicht erforderlich.
// "Messart" unterscheidet die Teilwerte von Stromzaehlern (verbrauch/
// einspeisung) und Waermemengenzaehlern (kwh/m3) - bei allen anderen
// Zaehlerarten bleibt die Spalte leer.
const SPALTEN = ['Zählernummer', 'Zählerart', 'Datum', 'Wert', 'Einheit', 'Messart', 'Status', 'Bemerkung'];

// Name der spaeter per AppFactory ins Projekt gelegten Original-Arbeitsmappe.
// Liegt sie unter data/vorlagen/, wird sie als Vorlage genutzt (Layout/Formatierung
// bleiben erhalten); bis dahin wird eine einfache, generierte Arbeitsmappe erzeugt.
const ORIGINAL_DATEINAME = 'Zaehlerstaende-Original.xlsx';

function originalPfad() {
  return path.join(config.TEMPLATES_DIR, ORIGINAL_DATEINAME);
}

async function ladeMesswertZeilen() {
  const rows = await knex('readings')
    .join('meters', 'readings.meter_id', 'meters.id')
    .join('meter_types', 'readings.meter_type_id', 'meter_types.id')
    .select(
      'meters.number as zaehlernummer',
      'meter_types.label as zaehlerart',
      'readings.reading_at',
      'readings.value',
      'readings.unit',
      'readings.status',
      'readings.strom_richtung',
      'readings.waerme_teil',
      'readings.bemerkung'
    )
    .orderBy('readings.reading_at');

  return rows.map((r) => {
    const dt = new Date(r.reading_at);
    const messart = r.strom_richtung || r.waerme_teil || '';
    return [r.zaehlernummer, r.zaehlerart, dt.toISOString().slice(0, 10), Number(r.value), r.unit, messart, r.status, r.bemerkung || ''];
  });
}

async function erzeugeWorkbook() {
  const zeilen = await ladeMesswertZeilen();
  const workbook = new ExcelJS.Workbook();

  if (fs.existsSync(originalPfad())) {
    // Original-Arbeitsmappe als Vorlage: eigenes Export-Blatt anhaengen/ueberschreiben,
    // bestehende Blaetter/Formatierung der Originaldatei bleiben unangetastet.
    await workbook.xlsx.readFile(originalPfad());
    const vorhanden = workbook.getWorksheet('Messwerte_Export');
    if (vorhanden) workbook.removeWorksheet(vorhanden.id);
    const sheet = workbook.addWorksheet('Messwerte_Export');
    sheet.addRow(SPALTEN);
    zeilen.forEach((z) => sheet.addRow(z));
    return workbook;
  }

  const meterSheet = workbook.addWorksheet('Zaehler');
  meterSheet.addRow(['ID', 'Zählernummer', 'Zählerart', 'Hersteller', 'Messbetreiber', 'Typ/Bezeichnung', 'Einheit', 'Eichdatum', 'Eichfrist', 'Einbaudatum', 'Ausbaudatum', 'Bemerkung', 'Aktiv']);
  const meters = await knex('meters').join('meter_types', 'meters.meter_type_id', 'meter_types.id')
    .select('meters.*', 'meter_types.label as zaehlerart_label');
  meters.forEach((m) => meterSheet.addRow([m.id, m.number, m.zaehlerart_label, m.manufacturer, m.messbetreiber, m.type_label, m.unit, m.eich_datum, m.eich_frist, m.einbau_datum, m.ausbau_datum, m.bemerkung, m.active ? 'ja' : 'nein']));

  const sheet = workbook.addWorksheet('Messwerte');
  sheet.addRow(SPALTEN);
  zeilen.forEach((z) => sheet.addRow(z));

  return workbook;
}

module.exports = { erzeugeWorkbook, originalPfad, ORIGINAL_DATEINAME, SPALTEN };
