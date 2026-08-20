'use strict';

const express = require('express');
const path    = require('path');

const {
  getAllCustomers,
  getCustomerById,
  getCustomerBySerial,
  addStamp,
  deleteCustomer,
  getDevicesForSerial,
  getRegisteredSerials,
  getDevicesForSerials,
  getDeviceCount,
  getAllDevicesWithCustomer,
  setSetting,
  touchCustomers,
} = require('../db/database');
const { sendPassUpdatePush } = require('../passes/apnSender');

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

router.get('/admin/customers', adminAuth, async (_req, res) => {
  try {
    const rawCustomers = await getAllCustomers();
    const customers = rawCustomers.map((c) => ({
      id:           c.id,
      name:         c.name,
      email:        c.email,
      stamps:       c.stamps,
      serialNumber: c.serial_number,
      createdAt:    c.created_at,
      updatedAt:    c.updated_at,
    }));
    return res.json({ customers, deviceCount: await getDeviceCount() });
  } catch (err) {
    console.error('[ADMIN] Error listing customers:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/customer/:customerId ────────────────────────────────────────

router.delete('/admin/customer/:customerId', adminAuth, async (req, res) => {
  try {
    const deleted = await deleteCustomer(req.params.customerId);
    if (!deleted) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Error deleting customer:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/customer-by-serial/:serialNumber ───────────────────────────────
// Used by the scan-to-stamp flow: decode the pass's QR (which encodes the
// serial number), then look up who it belongs to.

router.get('/admin/customer-by-serial/:serialNumber', adminAuth, async (req, res) => {
  try {
    const customer = await getCustomerBySerial(req.params.serialNumber);
    if (!customer) {
      return res.status(404).json({ error: 'No customer found for this pass' });
    }
    return res.json({
      id:           customer.id,
      name:         customer.name,
      email:        customer.email,
      stamps:       customer.stamps,
      serialNumber: customer.serial_number,
      authToken:    customer.auth_token,
    });
  } catch (err) {
    console.error('[ADMIN] Error looking up customer by serial:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/devices ─────────────────────────────────────────────────────────
// Debug endpoint: raw device registrations joined with customer info, plus
// whether the APNs cert files this instance was started with actually exist
// on disk. Useful for diagnosing "notifications aren't working" without a
// physical device.

router.get('/admin/devices', adminAuth, async (_req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const certCheck = (envVar) => {
      const p = process.env[envVar];
      if (!p) return { envVar, set: false };
      return { envVar, set: true, path: p, exists: fs.existsSync(path.resolve(p)) };
    };

    return res.json({
      devices: await getAllDevicesWithCustomer(),
      certs: [
        certCheck('APN_CERT_PATH'),
        certCheck('APN_KEY_PATH'),
        certCheck('CERT_PATH'),
        certCheck('KEY_PATH'),
        certCheck('WWDR_PATH'),
      ],
    });
  } catch (err) {
    console.error('[ADMIN] Error listing devices:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/scan ────────────────────────────────────────────────────────────

router.get('/admin/scan', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/scan.html'));
});

// ── POST /admin/stamp/:customerId ─────────────────────────────────────────────

router.post('/admin/stamp/:customerId', adminAuth, async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = await getCustomerById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const updated = await addStamp(customerId);

    // Send silent push so Apple Wallet fetches the updated pass
    const devices = await getDevicesForSerial(updated.serial_number);
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

    const serials = await getRegisteredSerials();
    if (serials.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No registered devices.' });
    }

    // Store the message so generatePass() can stamp it onto the "announcement"
    // back field, and bump updated_at so the wallet web service doesn't
    // short-circuit the refetch with a 304 (see routes/wallet.js).
    await setSetting('announcement', message);
    await touchCustomers(serials);

    const devices = await getDevicesForSerials(serials);
    const tokens  = [...new Set(devices.map((d) => d.push_token))];

    // Wallet passes can't display arbitrary push text — this sends the
    // standard silent "refetch your pass" push, and Wallet shows the
    // message itself via the announcement field's changeMessage template.
    await sendPassUpdatePush(tokens);
    console.log(`[ADMIN] Broadcast push sent to ${tokens.length} device(s): "${message}"`);

    return res.json({ success: true, sent: tokens.length });
  } catch (err) {
    console.error('[ADMIN] Error sending broadcast push:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
