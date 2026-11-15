const express = require('express');
const multer = require('multer');
const { requireAuth, requireAdmin } = require('../lib/auth');
const audit = require('../lib/audit');
const daten = require('../lib/exportImport/daten');
const exportCsv = require('../lib/exportImport/exportCsv');
const exportXlsx = require('../lib/exportImport/exportXlsx');
const importVorlage = require('../lib/exportImport/importVorlage');
const { parseDatei } = require('../lib/exportImport/importParse');
const { validiereZeilen } = require('../lib/exportImport/importValidate');
const { commitZeilen } = require('../lib/exportImport/importCommit');
const { planeStammdatenImport } = require('../lib/exportImport/importStammdaten');
const tempStore = require('../lib/importTempStore');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Export ist admin-only (Auftrag Abschnitt 4): enthaelt saemtliche Messdaten.
router.get('/export', requireAuth, requireAdmin, (req, res) => {
  res.render('export', { titel: 'Export' });
});

router.get('/export/json', requireAuth, requireAdmin, async (req, res) => {
  const alle = await daten.gatherAll();
  await audit.log(req.user.id, 'export_json', null);
  res.setHeader('Content-Disposition', 'attachment; filename="zaehlerstandsermittlung-export.json"');
  res.json(alle);
});

router.get('/export/csv', requireAuth, requireAdmin, async (req, res) => {
  const csv = await exportCsv.readingsAlsCsv();
  await audit.log(req.user.id, 'export_csv', null);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="messwerte-export.csv"');
  res.send(csv);
});

router.get('/export/xlsx', requireAuth, requireAdmin, async (req, res) => {
  const workbook = await exportXlsx.erzeugeWorkbook();
  await audit.log(req.user.id, 'export_xlsx', null);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="messwerte-export.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Import ist bewusst admin-only: er veraendert Bestandsdaten dauerhaft.
router.get('/import', requireAuth, requireAdmin, (req, res) => {
  res.render('import', { titel: 'Import', vorschau: null, stammdatenPlan: null, token: null, fehler: null, erfolg: null });
});

router.get('/import/vorlage', requireAuth, requireAdmin, async (req, res) => {
  const workbook = await importVorlage.erzeugeVorlage();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="messwerte-import-vorlage.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Reine Zaehler-Stammdatendateien (vollstaendiger Export mit leerem
// readings-Array) gehoeren NICHT zu diesem Messwerte-Import - dafuer gibt es
// die eigenstaendige Funktion "Zähler-Stammdaten importieren" (siehe
// lib/exportImport/zaehlerStammdaten.js). Verhindert, dass dieser Import eine
// reine Zaehlerdatei faelschlich als (leeren) Messwertimport verarbeitet.
function istReineZaehlerdatei(rohZeilen, stammdaten) {
  return Boolean(stammdaten) && Array.isArray(rohZeilen) && rohZeilen.length === 0;
}
const ZAEHLERDATEI_HINWEIS = 'Diese Datei enthält keine Messwerte (nur Zähler-Stammdaten). Bitte dafür "Zähler-Stammdaten importieren" unter Administration → Import & Export verwenden.';

router.post('/import/vorschau', requireAuth, requireAdmin, upload.single('datei'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Keine Datei hochgeladen.');
    const { zeilen: rohZeilen, stammdaten } = await parseDatei(req.file.buffer, req.file.originalname);
    if (istReineZaehlerdatei(rohZeilen, stammdaten)) throw new Error(ZAEHLERDATEI_HINWEIS);
    const stammdatenPlan = stammdaten ? await planeStammdatenImport(stammdaten) : null;
    const vorschau = await validiereZeilen(rohZeilen, stammdaten);
    const token = tempStore.speichere(req.file.buffer, req.file.originalname);
    res.render('import', { titel: 'Import', vorschau, stammdatenPlan, token, fehler: null, erfolg: null });
  } catch (err) {
    console.error('Fehler in importExport.js:', err.message);
    res.status(400).render('import', { titel: 'Import', vorschau: null, stammdatenPlan: null, token: null, fehler: err.message, erfolg: null });
  }
});

router.post('/import/uebernehmen', requireAuth, requireAdmin, async (req, res) => {
  const token = req.body.token;
  try {
    const eintrag = tempStore.finde(token);
    if (!eintrag) throw new Error('Die Vorschau ist abgelaufen - bitte Datei erneut hochladen.');
    const { zeilen: rohZeilen, stammdaten } = await parseDatei(eintrag.buffer, eintrag.originalName);
    if (istReineZaehlerdatei(rohZeilen, stammdaten)) throw new Error(ZAEHLERDATEI_HINWEIS);
    const vorschau = await validiereZeilen(rohZeilen, stammdaten);
    const ergebnis = await commitZeilen(vorschau.zeilen, req.user.id, stammdaten);
    tempStore.loesche(token);
    await audit.log(req.user.id, 'import_uebernommen', ergebnis);
    const stammdatenText = (ergebnis.neueGruppen || ergebnis.neueTypen || ergebnis.neueZaehler)
      ? ` Stammdaten ergänzt: ${ergebnis.neueGruppen} Zählergruppe(n), ${ergebnis.neueTypen} Zählerart(en), ${ergebnis.neueZaehler} Zähler.`
      : '';
    res.render('import', {
      titel: 'Import',
      vorschau: null,
      stammdatenPlan: null,
      token: null,
      fehler: null,
      erfolg: `${ergebnis.eingefuegt} Messwert(e) importiert, ${ergebnis.uebersprungen} übersprungen (Fehler/Dubletten).${stammdatenText}`,
    });
  } catch (err) {
    console.error('Fehler in importExport.js:', err.message);
    res.status(400).render('import', { titel: 'Import', vorschau: null, stammdatenPlan: null, token: null, fehler: err.message, erfolg: null });
  }
});

module.exports = router;
