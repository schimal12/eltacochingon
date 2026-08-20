'use strict';

/**
 * Apple Wallet Web Service endpoints.
 *
 * Reference: https://developer.apple.com/documentation/walletpasses/adding_a_web_service_to_update_passes
 *
 * All endpoints are under /v1/ as required by the Wallet Web Service protocol.
 * Apple sends an "Authorization: ApplePass {authenticationToken}" header with
 * every request — we verify it against the stored token for the serial number.
 */

const express = require('express');

const {
  getCustomerBySerial,
  registerDevice,
  unregisterDevice,
  getSerialsUpdatedSince,
} = require('../db/database');
const { generatePass } = require('../passes/passGenerator');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

/**
 * Verify the ApplePass authentication token.
 * Attaches `req.customer` on success.
 */
async function verifyPassAuth(req, res, next) {
  try {
    const { serialNumber } = req.params;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^ApplePass\s+/i, '').trim();

    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const customer = await getCustomerBySerial(serialNumber);
    if (!customer) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    if (customer.auth_token !== token) {
      return res.status(401).json({ error: 'Invalid authorization token' });
    }

    req.customer = customer;
    return next();
  } catch (err) {
    return next(err);
  }
}

// ── POST /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
//
// Called by Apple Wallet when a pass is added to the user's device.
// Body: { "pushToken": "..." }

router.post(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  verifyPassAuth,
  async (req, res) => {
    try {
      const { deviceLibraryIdentifier, serialNumber } = req.params;
      const { pushToken } = req.body;

      if (!pushToken) {
        return res.status(400).json({ error: 'pushToken is required' });
      }

      // node-apn / Apple expect a hex push token
      await registerDevice({
        deviceLibraryId: deviceLibraryIdentifier,
        pushToken,
        serialNumber,
      });

      // 201 if newly registered, 200 if updated
      return res.status(201).send();
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  },
);

// ── DELETE /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
//
// Called by Apple Wallet when a pass is removed from the device.

router.delete(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  verifyPassAuth,
  async (req, res) => {
    try {
      const { deviceLibraryIdentifier, serialNumber } = req.params;

      await unregisterDevice({ deviceLibraryId: deviceLibraryIdentifier, serialNumber });

      return res.status(200).send();
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  },
);

// ── GET /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier
//
// Called by Apple Wallet to find out which passes have changed since a given
// date. Query param: ?passesUpdatedSince=<ISO-8601 date>
// Response: { "lastUpdated": "<timestamp>", "serialNumbers": ["..."] }

router.get(
  '/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier',
  async (req, res) => {
    try {
      const { passTypeIdentifier } = req.params;
      const { passesUpdatedSince } = req.query;

      const serials = await getSerialsUpdatedSince(passTypeIdentifier, passesUpdatedSince || null);

      if (serials.length === 0) {
        // 204 means "nothing has changed"
        return res.status(204).send();
      }

      return res.status(200).json({
        lastUpdated:   new Date().toISOString(),
        serialNumbers: serials,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  },
);

// ── GET /v1/passes/:passTypeIdentifier/:serialNumber
//
// Called by Apple Wallet to download the latest version of a pass.
// Returns the signed .pkpass archive.

router.get(
  '/v1/passes/:passTypeIdentifier/:serialNumber',
  verifyPassAuth,
  async (req, res) => {
    try {
      const customer = req.customer;

      // Respect If-Modified-Since caching
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince) {
        const since    = new Date(ifModifiedSince);
        const updated  = new Date(customer.updated_at);
        if (updated <= since) {
          return res.status(304).send();
        }
      }

      const passBuffer = await generatePass(customer);

      res.set({
        'Content-Type':   'application/vnd.apple.pkpass',
        'Last-Modified':  new Date(customer.updated_at).toUTCString(),
        'Content-Length': passBuffer.length,
      });

      return res.send(passBuffer);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  },
);

// ── POST /v1/log
//
// Apple Wallet logs errors here. Accept and discard gracefully.

router.post('/v1/log', (req, res) => {
  const { logs } = req.body || {};
  if (logs && Array.isArray(logs)) {
    logs.forEach((entry) => console.log('[APPLE WALLET LOG]', entry));
  }
  return res.status(200).send();
});

module.exports = router;
