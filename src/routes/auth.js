const express = require('express');
const knex = require('../db/knex');
const { verifyPassword } = require('../lib/auth');
const audit = require('../lib/audit');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { titel: 'Anmelden', fehler: null });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const passwort = String(req.body.passwort || '');
  const user = await knex('users').whereRaw('lower(email) = ?', [email]).first();

  const ok = user && user.active && (await verifyPassword(passwort, user.password_hash));
  if (!ok) {
    await audit.log(user ? user.id : null, 'login_fehlgeschlagen', { email });
    return res.status(401).render('login', { titel: 'Anmelden', fehler: 'E-Mail oder Passwort ist falsch, oder das Konto ist deaktiviert.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', { titel: 'Anmelden', fehler: 'Anmeldung fehlgeschlagen, bitte erneut versuchen.' });
    req.session.userId = user.id;
    audit.log(user.id, 'login', null);
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  const userId = req.user ? req.user.id : null;
  req.session.destroy(() => {
    audit.log(userId, 'logout', null);
    res.redirect('/login');
  });
});

module.exports = router;
