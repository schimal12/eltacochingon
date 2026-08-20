'use strict';

const express = require('express');
const path    = require('path');
const QRCode  = require('qrcode');

const {
  getAllCustomers,
  getCustomerById,
  addStamp,
  getDevicesForSerial,
  getRegisteredSerials,
  getDevicesForSerials,
} = require('../db/database');
const { sendPassUpdatePush, sendBroadcastPush } = require('../passes/apnSender');

const router = express.Router();

// ── Admin auth middleware ──────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN || 'changeme123';

  // Support both Bearer header and ?token= query param
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const queryToken  = req.query.token || '';

  if (bearerToken === adminToken || queryToken === adminToken) {
    return next();
  }

  // If the request is for the HTML dashboard page, redirect instead of 401
  if (req.path === '/admin' && req.method === 'GET') {
    return next(); // Dashboard HTML handles its own auth via JS
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// ── GET /admin ─────────────────────────────────────────────────────────────────

router.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ── GET /admin/customers ──────────────────────────────────────────────────────

router.get('/admin/customers', adminAuth, (_req, res) => {
  try {
    const customers = getAllCustomers().map((c) => ({
      id:           c.id,
      name:         c.name,
      email:        c.email,
      stamps:       c.stamps,
      serialNumber: c.serial_number,
      createdAt:    c.created_at,
      updatedAt:    c.updated_at,
    }));
    return res.json({ customers });
  } catch (err) {
    console.error('[ADMIN] Error listing customers:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/stamp/:customerId ─────────────────────────────────────────────

router.post('/admin/stamp/:customerId', adminAuth, async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = getCustomerById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const updated = addStamp(customerId);

    // Send silent push so Apple Wallet fetches the updated pass
    const devices = getDevicesForSerial(updated.serial_number);
    if (devices.length > 0) {
      const tokens = devices.map((d) => d.push_token);
      await sendPassUpdatePush(tokens);
      console.log(`[ADMIN] Sent pass-update push for serial ${updated.serial_number} to ${tokens.length} device(s)`);
    }

    return res.json({
      success: true,
      stamps:  updated.stamps,
      message: `Stamp added. ${updated.name} now has ${updated.stamps}/10 stamps.`,
    });
  } catch (err) {
    console.error('[ADMIN] Error adding stamp:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/notify ────────────────────────────────────────────────────────
// Body: { "message": "Today is taco Tuesday!" }

router.post('/admin/notify', adminAuth, async (req, res) => {
  try {
    const message = (req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const serials = getRegisteredSerials();
    if (serials.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No registered devices.' });
    }

    const devices = getDevicesForSerials(serials);
    const tokens  = [...new Set(devices.map((d) => d.push_token))];

    await sendBroadcastPush(tokens, message);
    console.log(`[ADMIN] Broadcast push sent to ${tokens.length} device(s): "${message}"`);

    return res.json({ success: true, sent: tokens.length });
  } catch (err) {
    console.error('[ADMIN] Error sending broadcast push:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/qr ─────────────────────────────────────────────────────────────

router.get('/admin/qr', adminAuth, async (req, res) => {
  try {
    const baseUrl  = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const registerUrl = `${baseUrl}/register`;

    const format = req.query.format || 'png'; // 'png' or 'svg'

    if (format === 'svg') {
      const svg = await QRCode.toString(registerUrl, { type: 'svg' });
      res.set('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }

    // Default: PNG data URL wrapped in simple HTML for easy display
    const dataUrl = await QRCode.toDataURL(registerUrl, {
      width:  300,
      margin: 2,
      color:  { dark: '#B4321E', light: '#FFFFFF' },
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Registration QR Code</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #fdf6f0; }
    img  { border: 4px solid #B4321E; border-radius: 8px; }
    p    { color: #333; margin-top: 16px; font-size: 14px; }
    a    { color: #B4321E; }
  </style>
</head>
<body>
  <h1>${process.env.ORG_NAME || 'Your Restaurant'} — Loyalty Sign-Up</h1>
  <img src="${dataUrl}" alt="Registration QR Code" width="300" height="300">
  <p>Scan to register for our loyalty card.<br>
  Or visit <a href="${registerUrl}">${registerUrl}</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    return res.send(html);
  } catch (err) {
    console.error('[ADMIN] Error generating QR code:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
