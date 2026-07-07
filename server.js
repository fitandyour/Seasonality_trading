const express = require('express');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { migrate } = require('./schema');
const { pool } = require('./db');
const { seedAdmin, registerAuthRoutes } = require('./auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' },
}));
registerAuthRoutes(app);
app.use('/strategies', require('./routes/strategies').router);

app.get('/healthz', (req, res) => res.json({ ok: true }));

async function boot() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — refusing to start.');
    process.exit(1);
  }
  await migrate();
  await seedAdmin();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`trading-seasonals listening on :${port}`));
}

if (require.main === module) boot();
module.exports = { app, boot };
