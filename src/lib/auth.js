const bcrypt = require('bcryptjs');
const knex = require('../db/knex');

const HASH_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, HASH_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function loadUserForSession(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const user = await knex('users').where({ id: req.session.userId }).first();
    if (user && user.active) {
      req.user = user;
    } else {
      req.session.destroy(() => {});
    }
  }
  res.locals.user = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'nicht angemeldet' });
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'keine Berechtigung' });
    return res.status(403).render('fehler', { titel: 'Keine Berechtigung', nachricht: 'Diese Seite ist nur fuer Administratoren.' });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, loadUserForSession, requireAuth, requireAdmin, HASH_ROUNDS };
