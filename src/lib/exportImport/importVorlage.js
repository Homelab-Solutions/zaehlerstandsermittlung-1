const ExcelJS = require('exceljs');
const { SPALTEN } = require('./exportXlsx');

// Muster-Datei fuer den Messwert-Import: exakt dieselben Spalten wie importParse.js
// erwartet (FELD_ALIAS) und exportXlsx.js erzeugt, damit Vorlage und Parser nie
// auseinanderlaufen. Keine Uhrzeit-Spalte (Auftrag "Dashboard, Importvorlage und
// KI-Status"). Beispielzeilen zeigen alle drei Faelle: normaler Zaehler (eine
// Zeile je Ablesung), Stromzaehler (zwei Zeilen je Ablesedatum, Messart
// verbrauch/einspeisung) und Waermemengenzaehler (zwei Pflicht-Zeilen je
// Ablesedatum, Messart kwh/m3 - die Zaehlernummern sind nur Platzhalter und
// muessen vorher in der Zaehlerverwaltung angelegt sein).
async function erzeugeVorlage() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Messwerte_Vorlage');
  sheet.addRow(SPALTEN);
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(['12345678', 'Kaltwasser Haus', '2026-01-15', '123.456', 'm³', '', 'abgelesen', 'Beispielzeile normaler Zähler - vor dem Import löschen oder überschreiben']);
  sheet.addRow(['23456789', 'Strom Haus', '2026-01-15', '4567.8', 'kWh', 'verbrauch', 'abgelesen', 'Beispielzeile Stromzähler - Verbrauch (OBIS 1.8.0)']);
  sheet.addRow(['23456789', 'Strom Haus', '2026-01-15', '210.4', 'kWh', 'einspeisung', 'abgelesen', 'Beispielzeile Stromzähler - Einspeisung (OBIS 2.8.0, nur falls vorhanden)']);
  sheet.addRow(['34567890', 'Wärmemengenzähler Haus', '2026-01-15', '8901.2', 'kWh', 'kwh', 'abgelesen', 'Beispielzeile Wärmemengenzähler - kWh (Pflicht)']);
  sheet.addRow(['34567890', 'Wärmemengenzähler Haus', '2026-01-15', '456.7', 'm³', 'm3', 'abgelesen', 'Beispielzeile Wärmemengenzähler - m³ (Pflicht, gleiches Datum)']);
  sheet.columns.forEach((spalte) => { spalte.width = 22; });
  return workbook;
}

module.exports = { erzeugeVorlage };
