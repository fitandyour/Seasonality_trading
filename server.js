const express = require('express');
const path = require('path');
const { migrate } = require('./schema');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

async function boot() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — refusing to start.');
    process.exit(1);
  }
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`trading-seasonals listening on :${port}`));
}

if (require.main === module) boot();
module.exports = { app, boot };
