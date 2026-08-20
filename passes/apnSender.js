'use strict';

const apn = require('node-apn');
const fs = require('fs');
const path = require('path');

let provider = null;

/**
 * Lazily create and cache the APN provider.
 * Uses the Pass Type certificate/key pair (NOT an app push cert).
 */
function getProvider() {
  if (provider) return provider;

  const certPath = process.env.APN_CERT_PATH;
  const keyPath  = process.env.APN_KEY_PATH;

  if (!certPath || !keyPath) {
    console.warn('[APN] APN_CERT_PATH or APN_KEY_PATH not set — push notifications disabled');
    return null;
  }

  const resolvedCert = path.resolve(certPath);
  const resolvedKey  = path.resolve(keyPath);

  if (!fs.existsSync(resolvedCert) || !fs.existsSync(resolvedKey)) {
    console.warn('[APN] APN certificate files not found — push notifications disabled');
    return null;
  }

  // Wallet pass push certificates only work against Apple's production APNs
  // gateway — unlike regular app push, there's no sandbox/dev environment
  // for Passbook/Wallet updates, so this must never be conditional on
  // NODE_ENV or similar.
  provider = new apn.Provider({
    cert:        resolvedCert,
    key:         resolvedKey,
    passphrase:  process.env.CERT_PASSPHRASE || undefined,
    production:  true,
  });

  return provider;
}

/**
 * Send a silent "please update your pass" push to Apple Wallet.
 * Apple Wallet will then call GET /v1/passes/:passTypeId/:serialNumber to
 * fetch the refreshed pass.
 *
 * @param {string[]} pushTokens - Array of device push tokens.
 */
async function sendPassUpdatePush(pushTokens) {
  const p = getProvider();
  if (!p || pushTokens.length === 0) return;

  const note = new apn.Notification();
  note.topic = process.env.PASS_TYPE_ID || 'pass.com.yourrestaurant.loyalty';
  // Empty payload — Apple Wallet interprets this as "fetch updated pass"
  note.payload = {};

  const results = await p.send(note, pushTokens);

  if (results.failed && results.failed.length > 0) {
    results.failed.forEach((f) => {
      console.error('[APN] Push failed for token', f.device, ':', f.error || f.response);
    });
  }

  return results;
}

/**
 * Close the APN provider connection (call on graceful shutdown).
 */
function shutdownProvider() {
  if (provider) {
    provider.shutdown();
    provider = null;
  }
}

module.exports = { sendPassUpdatePush, shutdownProvider };
