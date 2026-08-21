'use strict';

const express  = require('express');
const path     = require('path');
const QRCode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  createCustomer,
  getCustomerByEmail,
  getPromotionDefaults,
} = require('../db/database');
const { generatePass } = require('../passes/passGenerator');

const router = express.Router();

// ── GET / ──────────────────────────────────────────────────────────────────────
// Public landing page: a printable QR code pointing at /register. Meant to be
// displayed or printed at the counter so customers can scan and sign up
// themselves -- no admin auth needed, this is the page the restaurant hangs
// on the wall.

router.get('/', async (req, res) => {
  try {
    const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const registerUrl = `${baseUrl}/register`;
    const orgName = process.env.ORG_NAME || 'Your Restaurant';

    const dataUrl = await QRCode.toDataURL(registerUrl, {
      width:  360,
      margin: 2,
      color:  { dark: '#B4321E', light: '#FFFFFF' },
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${orgName} — Loyalty Program</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #fdf6f0;
      color: #2d2d2d;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.08);
      padding: 40px 36px;
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; font-weight: 800; letter-spacing: -0.3px; }
    .tagline { color: #82817a; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 6px; }
    .qr-wrap {
      margin: 32px auto;
      display: inline-block;
      padding: 16px;
      border: 4px solid #B4321E;
      border-radius: 16px;
    }
    .qr-wrap img { display: block; width: 260px; height: 260px; max-width: 100%; }
    .cta { font-size: 15px; font-weight: 600; line-height: 1.5; }
    .cta .es { color: #82817a; font-weight: 500; font-size: 13px; display: block; margin-top: 4px; }
    .link { margin-top: 20px; font-size: 12px; color: #82817a; word-break: break-all; }
    .link a { color: #B4321E; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🌮 ${orgName}</h1>
    <div class="tagline">Loyalty Program · Programa de Lealtad</div>
    <div class="qr-wrap">
      <img src="${dataUrl}" alt="Scan to join the loyalty program" width="260" height="260">
    </div>
    <p class="cta">
      Scan to join and start earning stamps
      <span class="es">Escanea para unirte y empezar a ganar sellos</span>
    </p>
    <p class="link">Or visit <a href="${registerUrl}">${registerUrl}</a></p>
  </div>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('[HOME] Error generating landing page:', err);
    return res.status(500).send('Something went wrong.');
  }
});

// ── GET /register ─────────────────────────────────────────────────────────────

router.get('/register', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

// ── POST /register ────────────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const name  = (req.body.name  || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const lang  = ['es', 'pt'].includes(req.body.lang) ? req.body.lang : 'en';

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // Return existing pass if the customer is already registered
    let customer = await getCustomerByEmail(email);

    if (!customer) {
      const id           = uuidv4();
      const serialNumber = uuidv4();
      const authToken    = uuidv4().replace(/-/g, ''); // 32-char hex token
      const { stampsRequired, rewardText } = await getPromotionDefaults();

      await createCustomer({ id, name, email, serialNumber, authToken, lang, stampsRequired, rewardText });
      customer = await getCustomerByEmail(email);
    }

    // Generate the signed PKPass archive
    const passBuffer = await generatePass(customer);

    res.set({
      'Content-Type':        'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename=loyalty.pkpass',
      'Content-Length':      passBuffer.length,
    });

    return res.send(passBuffer);
  } catch (err) {
    console.error('[REGISTER] Error generating pass:', err);
    return res.status(500).json({ error: 'Could not generate pass. Please try again.' });
  }
});

module.exports = router;
