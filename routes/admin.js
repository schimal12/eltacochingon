'use strict';

const express = require('express');
const path    = require('path');

const {
  getAllCustomers,
  getCustomerById,
  getCustomerBySerial,
  addStamp,
  redeemReward,
  getRedemptionCount,
  deleteCustomer,
  getDeletedCustomers,
  restoreCustomer,
  getDevicesForSerial,
  getRegisteredSerials,
  getDevicesForSerials,
  getDeviceCount,
  getAllDevicesWithCustomer,
  setSetting,
  getPromotionDefaults,
  savePromotionDefaults,
  getPromotionHistory,
  deletePromotionHistoryEntry,
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

  return res.status(401).json({ error: 'No autorizado' });
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
      id:             c.id,
      name:           c.name,
      email:          c.email,
      stamps:         c.stamps,
      stampsRedeemed: c.stamps_redeemed,
      stampsRequired: c.stamps_required,
      rewardText:     c.reward_text,
      serialNumber:   c.serial_number,
      cardRemovedAt:  c.card_removed_at,
      createdAt:      c.created_at,
      updatedAt:      c.updated_at,
    }));
    const [deviceCount, redemptionCount] = await Promise.all([getDeviceCount(), getRedemptionCount()]);
    return res.json({ customers, deviceCount, redemptionCount });
  } catch (err) {
    console.error('[ADMIN] Error listing customers:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/settings ─────────────────────────────────────────────────────────
// Current promotion defaults. New signups snapshot these; existing customers
// keep whatever was active when they registered.

router.get('/admin/settings', adminAuth, async (_req, res) => {
  try {
    return res.json(await getPromotionDefaults());
  } catch (err) {
    console.error('[ADMIN] Error reading settings:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/settings ────────────────────────────────────────────────────────
// Body: { "stampsRequired": 10, "rewardText": "a free taco" }

router.post('/admin/settings', adminAuth, async (req, res) => {
  try {
    const stampsRequired = parseInt(req.body.stampsRequired, 10);
    const rewardText     = (req.body.rewardText || '').trim();

    if (!Number.isInteger(stampsRequired) || stampsRequired < 1) {
      return res.status(400).json({ error: 'El número de sellos debe ser un número entero positivo.' });
    }
    if (!rewardText) {
      return res.status(400).json({ error: 'La recompensa es requerida.' });
    }

    await savePromotionDefaults(stampsRequired, rewardText);

    return res.json({ success: true, stampsRequired, rewardText });
  } catch (err) {
    console.error('[ADMIN] Error saving settings:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/promotion-history ─────────────────────────────────────────────────
// Past promotions, most recent first, so the owner can reuse one.

router.get('/admin/promotion-history', adminAuth, async (_req, res) => {
  try {
    const rawHistory = await getPromotionHistory();
    const history = rawHistory.map((h) => ({
      id:             h.id,
      stampsRequired: h.stamps_required,
      rewardText:     h.reward_text,
      createdAt:      h.created_at,
    }));
    return res.json({ history });
  } catch (err) {
    console.error('[ADMIN] Error reading promotion history:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/promotion-history/:id ──────────────────────────────────────────
// Removes a log entry only -- has no effect on the current promotion default
// or any customer's already-snapshotted promotion.

router.delete('/admin/promotion-history/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Id inválido' });
    }
    const deleted = await deletePromotionHistoryEntry(id);
    if (!deleted) {
      return res.status(404).json({ error: 'No se encontró esa entrada del historial' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Error deleting promotion history entry:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/customer/:customerId ────────────────────────────────────────

router.delete('/admin/customer/:customerId', adminAuth, async (req, res) => {
  try {
    const deleted = await deleteCustomer(req.params.customerId);
    if (!deleted) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Error deleting customer:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/deleted-customers ────────────────────────────────────────────────
// Customers soft-deleted within the last 7 days, restorable via the endpoint
// below. Anything older has already been permanently purged.

router.get('/admin/deleted-customers', adminAuth, async (_req, res) => {
  try {
    const rawCustomers = await getDeletedCustomers();
    const customers = rawCustomers.map((c) => ({
      id:        c.id,
      name:      c.name,
      email:     c.email,
      stamps:    c.stamps,
      deletedAt: c.deleted_at,
    }));
    return res.json({ customers });
  } catch (err) {
    console.error('[ADMIN] Error listing deleted customers:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/customer/:customerId/restore ────────────────────────────────────

router.post('/admin/customer/:customerId/restore', adminAuth, async (req, res) => {
  try {
    const restored = await restoreCustomer(req.params.customerId);
    if (!restored) {
      return res.status(404).json({ error: 'No se encontró un cliente eliminado con ese id (puede que ya haya sido purgado o restaurado)' });
    }
    return res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'No se puede restaurar: ya existe un cliente activo con ese correo. Elimina o cambia el correo de ese cliente primero.' });
    }
    console.error('[ADMIN] Error restoring customer:', err);
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
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Block stamping past a ready-to-redeem reward -- otherwise extra taps
    // before staff remembers to hit "Canjear" get banked and carry over
    // after redemption instead of resetting to 0, which reads as a bug.
    if (customer.stamps - customer.stamps_redeemed >= customer.stamps_required) {
      return res.status(400).json({ error: 'Este cliente ya tiene una recompensa lista para canjear. Canjéala antes de agregar más sellos.' });
    }

    const updated = await addStamp(customerId);

    // Send silent push so Apple Wallet fetches the updated pass
    const devices = await getDevicesForSerial(updated.serial_number);
    if (devices.length > 0) {
      const tokens = devices.map((d) => d.push_token);
      await sendPassUpdatePush(tokens);
      console.log(`[ADMIN] Sent pass-update push for serial ${updated.serial_number} to ${tokens.length} device(s)`);
    }

    const required = updated.stamps_required;
    const progress = updated.stamps - updated.stamps_redeemed;
    const display  = Math.min(progress, required);

    return res.json({
      success: true,
      stamps:  updated.stamps,
      message: `Sello agregado. ${updated.name} ahora tiene ${display}/${required} sellos.`,
    });
  } catch (err) {
    console.error('[ADMIN] Error adding stamp:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/customer/:customerId/redeem ──────────────────────────────────────
// Marks one reward as given out: advances stamps_redeemed and logs it, so the
// pass stops showing "ready" for that reward and there's a record of when it
// was actually claimed.

router.post('/admin/customer/:customerId/redeem', adminAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const updated = await redeemReward(customerId);

    const devices = await getDevicesForSerial(updated.serial_number);
    if (devices.length > 0) {
      const tokens = devices.map((d) => d.push_token);
      await sendPassUpdatePush(tokens);
      console.log(`[ADMIN] Sent pass-update push after redemption for serial ${updated.serial_number} to ${tokens.length} device(s)`);
    }

    return res.json({
      success: true,
      message: `Recompensa canjeada para ${updated.name}.`,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: 'Este cliente no tiene suficientes sellos para canjear.' });
    }
    console.error('[ADMIN] Error redeeming reward:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/notify ────────────────────────────────────────────────────────
// Body: { "message": "Today is taco Tuesday!" }

router.post('/admin/notify', adminAuth, async (req, res) => {
  try {
    const message = (req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }

    const serials = await getRegisteredSerials();
    if (serials.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No hay dispositivos registrados.' });
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
