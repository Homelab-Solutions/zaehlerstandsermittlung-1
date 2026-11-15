const express = require('express');
const settings = require('../lib/settings');

const router = express.Router();

// Oeffentlich erreichbar OHNE Anmeldung (Auftrag Abschnitt 7: "Inhalte
// oeffentlich und leicht erreichbar anzeigen") - bewusst kein requireAuth.
router.get('/rechtliches', async (req, res) => {
  const all = await settings.getAll();
  res.render('rechtliches', {
    titel: 'Rechtliches',
    impressum: all.recht_impressum || '',
    datenschutz: all.recht_datenschutz || '',
    sonstiges: all.recht_sonstiges || '',
  });
});

module.exports = router;
