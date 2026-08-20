'use strict';

const { PKPass } = require('passkit-generator');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('../db/database');

// passkit-generator v3 requires the model folder to end with .pass
const TEMPLATE_DIR = path.join(__dirname, 'loyalty.pass');

/**
 * Read a certificate file.
 * Returns undefined if the path is not set or the file does not exist,
 * so passkit-generator can throw a descriptive error rather than an ENOENT crash.
 */
function readCert(envPath) {
  if (!envPath) return undefined;
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) {
    console.warn(`[PASS] Certificate not found at ${resolved}`);
    return undefined;
  }
  return fs.readFileSync(resolved);
}

/**
 * Compute a human-friendly "next reward" string from the current stamp count.
 */
function nextRewardText(stamps) {
  const remaining = Math.max(0, 10 - (stamps % 10));
  if (remaining === 0) return 'Collect your free taco!';
  return `${remaining} more stamp${remaining === 1 ? '' : 's'} for a free taco`;
}

/**
 * Render the current 10-stamp cycle as filled/empty taco emoji.
 */
function stampVisual(stamps) {
  const cycle  = stamps % 10;
  const filled = cycle === 0 && stamps > 0 ? 10 : cycle;
  return '🌮'.repeat(filled) + '◯'.repeat(10 - filled);
}

/**
 * Generate a signed PKPass buffer for the given customer.
 *
 * @param {object} customer - A customer row from the database.
 * @returns {Promise<Buffer>} The raw .pkpass archive as a Buffer.
 */
async function generatePass(customer) {
  const wwdr       = readCert(process.env.WWDR_PATH);
  const signerCert = readCert(process.env.CERT_PATH);
  const signerKey  = readCert(process.env.KEY_PATH);
  const passphrase = process.env.CERT_PASSPHRASE || undefined;

  const baseUrl = (process.env.BASE_URL || 'https://yourdomain.com').replace(/\/$/, '');

  // These props are merged / override the values in loyalty.pass/pass.json
  const overrides = {
    serialNumber:        customer.serial_number,
    authenticationToken: customer.auth_token,
    webServiceURL:       `${baseUrl}/v1/`,
    organizationName:    process.env.ORG_NAME     || 'Your Restaurant',
    passTypeIdentifier:  process.env.PASS_TYPE_ID || 'pass.com.yourrestaurant.loyalty',
    teamIdentifier:      process.env.TEAM_ID      || 'YOURTEAMID',
    description:         'Loyalty Card',
  };

  const pass = await PKPass.from(
    {
      model:        TEMPLATE_DIR,
      certificates: { wwdr, signerCert, signerKey, signerKeyPassphrase: passphrase },
    },
    overrides,
  );

  // ── Field values ────────────────────────────────────────────────────────────
  // The getters return live references to the field arrays from pass.json.
  // Mutating the objects in-place is the v3 way of setting field values.

  // primaryFields[0] → customer name
  if (pass.primaryFields.length > 0) {
    pass.primaryFields[0].value = customer.name;
  }

  // secondaryFields[0] → stamp count, rendered as filled/empty taco emoji
  if (pass.secondaryFields.length > 0) {
    pass.secondaryFields[0].value = stampVisual(customer.stamps);
  }

  // auxiliaryFields[0] → next reward message
  if (pass.auxiliaryFields.length > 0) {
    pass.auxiliaryFields[0].value = nextRewardText(customer.stamps);
  }

  // backFields "announcement" → latest broadcast message from /admin/notify
  const announcement = pass.backFields.find((f) => f.key === 'announcement');
  if (announcement) {
    announcement.value = getSetting('announcement') || announcement.value;
  }

  // Barcode encodes the serial number so a POS scanner can look up the customer
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         customer.serial_number,
    messageEncoding: 'iso-8859-1',
    altText:         'Loyalty Card',
  });

  return pass.getAsBuffer();
}

module.exports = { generatePass };
