const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not set — no login account seeded.');
    return;
  }
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length === 0) {
    await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      [email, bcrypt.hashSync(password, 10)]);
    console.log('Seeded admin user.');
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function registerAuthRoutes(app) {
  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email || '']);
    if (rows.length === 1 && bcrypt.compareSync(password || '', rows[0].password_hash)) {
      req.session.userId = rows[0].id;
      return res.redirect('/');
    }
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
}

module.exports = { seedAdmin, requireAuth, registerAuthRoutes };
