'use strict';

const express  = require('express');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  createCustomer,
  getCustomerByEmail,
} = require('../db/database');
const { generatePass } = require('../passes/passGenerator');

const router = express.Router();

// ── GET /register ─────────────────────────────────────────────────────────────

router.get('/register', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

// ── POST /register ────────────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const name  = (req.body.name  || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const lang  = req.body.lang === 'es' ? 'es' : 'en';

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // Return existing pass if the customer is already registered
    let customer = getCustomerByEmail(email);

    if (!customer) {
      const id           = uuidv4();
      const serialNumber = uuidv4();
      const authToken    = uuidv4().replace(/-/g, ''); // 32-char hex token

      createCustomer({ id, name, email, serialNumber, authToken, lang });
      customer = getCustomerByEmail(email);
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
