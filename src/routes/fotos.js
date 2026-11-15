const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const knex = require('../db/knex');
const { requireAuth } = require('../lib/auth');
const audit = require('../lib/audit');
const ai = require('../lib/ai');
const aiStatus = require('../lib/ai/status');

const router = express.Router();

// Reine Hintergrundpruefung der KI-Erreichbarkeit/Konfiguration (Auftrag
// Abschnitt 5): kein Foto-Upload, keine Bildanalyse, nur eine guenstige
// Modellliste des konfigurierten Anbieters, zwischengespeichert.
router.get('/api/ki/status', requireAuth, async (req, res) => {
  const ergebnis = await aiStatus.status();
  res.json(ergebnis);
});

const ERLAUBTE_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ERLAUBTE_MIME[file.mimetype])),
});

// Foto wird zunaechst nur in einem temporaeren Bereich abgelegt. Dauerhaft
// gespeichert wird es erst, wenn der Nutzer das beim Speichern des Messwerts
// ausdruecklich waehlt (siehe routes/readings.js).
router.post('/api/fotos/analysieren', requireAuth, upload.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein gueltiges Bild (erlaubt: JPEG, PNG, WebP, max. 8 MB).' });

  const ext = ERLAUBTE_MIME[req.file.mimetype];
  const tempId = crypto.randomUUID();
  const tempPath = path.join(config.TMP_UPLOADS_DIR, tempId + ext);
  fs.mkdirSync(config.TMP_UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(tempPath, req.file.buffer);

  const antwort = { tempId, vorschlag: null, kiStatus: 'nicht_konfiguriert', meldung: null };
  try {
    const ergebnis = await ai.fotoAnalysieren({ imageBase64: req.file.buffer.toString('base64'), mime: req.file.mimetype });
    if (ergebnis.ok) {
      antwort.kiStatus = 'ok';
      antwort.vorschlag = ergebnis.ergebnis;
    } else {
      antwort.kiStatus = 'fehler';
      antwort.meldung = ergebnis.fehler;
    }
  } catch (err) {
    antwort.kiStatus = 'fehler';
    antwort.meldung = 'KI-Fotoerkennung fehlgeschlagen.';
    console.error(err);
  }

  res.json(antwort);
});

router.delete('/api/fotos/tmp/:tempId', requireAuth, (req, res) => {
  const safe = String(req.params.tempId).replace(/[^a-zA-Z0-9-]/g, '');
  const dir = config.TMP_UPLOADS_DIR;
  const treffer = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.startsWith(safe + '.')) : null;
  if (treffer) fs.unlinkSync(path.join(dir, treffer));
  res.json({ ok: true });
});

// Dauerhaft gespeichertes Foto loeschen (Nutzer-Wunsch, jederzeit moeglich).
router.delete('/api/fotos/:id', requireAuth, async (req, res) => {
  const foto = await knex('photos').where({ id: req.params.id }).first();
  if (!foto) return res.status(404).json({ error: 'Foto nicht gefunden.' });
  const istEigentuemer = foto.created_by === req.user.id;
  if (!istEigentuemer && req.user.role !== 'admin') return res.status(403).json({ error: 'keine Berechtigung' });

  const dateipfad = path.join(config.UPLOADS_DIR, foto.filename);
  if (fs.existsSync(dateipfad)) fs.unlinkSync(dateipfad);
  await knex('photos').where({ id: foto.id }).del();
  await audit.log(req.user.id, 'foto_geloescht', { foto_id: foto.id, reading_id: foto.reading_id });
  res.json({ ok: true });
});

router.get('/fotos/:id', requireAuth, async (req, res) => {
  const foto = await knex('photos').where({ id: req.params.id }).first();
  if (!foto) return res.status(404).send('nicht gefunden');
  const dateipfad = path.join(config.UPLOADS_DIR, foto.filename);
  if (!fs.existsSync(dateipfad)) return res.status(404).send('Datei fehlt');
  res.sendFile(dateipfad);
});

module.exports = router;
