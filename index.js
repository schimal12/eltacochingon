'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const { initDatabase } = require('./db/database');
const registerRoutes = require('./routes/register');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/', registerRoutes);
app.use('/', walletRoutes);
app.use('/', adminRoutes);

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Public config for static pages (register.html etc.) ────────────────────────

app.get('/config', (_req, res) => {
  res.json({
    orgName: process.env.ORG_NAME || 'Your Restaurant',
    baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
  });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message, err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDatabase();
    console.log('[DB] Database initialised');

    app.listen(PORT, () => {
      console.log(`[SERVER] Listening on http://localhost:${PORT}`);
      console.log(`[SERVER] Registration page : http://localhost:${PORT}/register`);
      console.log(`[SERVER] Admin dashboard   : http://localhost:${PORT}/admin`);
    });
  } catch (err) {
    console.error('[FATAL] Could not start server:', err);
    process.exit(1);
  }
}

start();
