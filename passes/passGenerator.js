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

// ── Translations ─────────────────────────────────────────────────────────────

const TRANSLATIONS = {
  en: {
    description:      'Loyalty Card',
    customerLabel:     'Customer',
    stampsLabel:       'Stamps',
    rewardLabel:       'Next Reward',
    rewardReady:       'Collect your free taco!',
    rewardRemaining:   (n) => `${n} more stamp${n === 1 ? '' : 's'} for a free taco`,
    termsLabel:        'Terms & Conditions',
    termsValue:        'One stamp per visit. Reward valid for 30 days after earning. Not transferable. Management reserves the right to modify or discontinue this program at any time.',
    websiteLabel:      'Website',
    contactLabel:      'Contact',
    announcementLabel: 'Latest Update',
    announcementValue: 'Welcome to our loyalty program!',
    barcodeAlt:        'Loyalty Card',
  },
  es: {
    description:      'Tarjeta de Lealtad',
    customerLabel:     'Cliente',
    stampsLabel:       'Sellos',
    rewardLabel:       'Próxima Recompensa',
    rewardReady:       '¡Reclama tu taco gratis!',
    rewardRemaining:   (n) => `${n} sello${n === 1 ? '' : 's'} más para un taco gratis`,
    termsLabel:        'Términos y Condiciones',
    termsValue:        'Un sello por visita. La recompensa es válida por 30 días después de obtenerla. No transferible. La administración se reserva el derecho de modificar o descontinuar este programa en cualquier momento.',
    websiteLabel:      'Sitio Web',
    contactLabel:      'Contacto',
    announcementLabel: 'Última Actualización',
    announcementValue: '¡Bienvenido a nuestro programa de lealtad!',
    barcodeAlt:        'Tarjeta de Lealtad',
  },
};

function translationsFor(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

/**
 * Compute a human-friendly "next reward" string from the current stamp count.
 */
function nextRewardText(stamps, t) {
  const remaining = Math.max(0, 10 - (stamps % 10));
  return remaining === 0 ? t.rewardReady : t.rewardRemaining(remaining);
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
  const t       = translationsFor(customer.lang);

  // These props are merged / override the values in loyalty.pass/pass.json
  const overrides = {
    serialNumber:        customer.serial_number,
    authenticationToken: customer.auth_token,
    webServiceURL:       `${baseUrl}/v1`,
    organizationName:    process.env.ORG_NAME     || 'Your Restaurant',
    passTypeIdentifier:  process.env.PASS_TYPE_ID || 'pass.com.yourrestaurant.loyalty',
    teamIdentifier:      process.env.TEAM_ID      || 'YOURTEAMID',
    description:         t.description,
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
  //
  // Note: storeCard has no primaryFields on purpose — that slot renders as
  // large overlay text directly on top of the strip image, which collided
  // with the wordmark artwork. Name and stamps live in secondaryFields
  // instead, which render normally in the field grid below the strip.

  // secondaryFields: customer name + stamp count (taco emoji)
  const nameField = pass.secondaryFields.find((f) => f.key === 'name');
  if (nameField) {
    nameField.label = t.customerLabel;
    nameField.value = customer.name;
  }

  const stampsField = pass.secondaryFields.find((f) => f.key === 'stamps');
  if (stampsField) {
    stampsField.label = t.stampsLabel;
    stampsField.value = stampVisual(customer.stamps);
  }

  // auxiliaryFields[0] → next reward message
  if (pass.auxiliaryFields.length > 0) {
    pass.auxiliaryFields[0].label = t.rewardLabel;
    pass.auxiliaryFields[0].value = nextRewardText(customer.stamps, t);
  }

  // backFields: terms/website/contact labels, and the latest broadcast
  // message from /admin/notify on the "announcement" field.
  const terms = pass.backFields.find((f) => f.key === 'terms');
  if (terms) {
    terms.label = t.termsLabel;
    terms.value = t.termsValue;
  }

  const website = pass.backFields.find((f) => f.key === 'website');
  if (website) {
    website.label = t.websiteLabel;
    website.value = baseUrl;
  }

  const contact = pass.backFields.find((f) => f.key === 'contact');
  if (contact) {
    contact.label = t.contactLabel;
    contact.value = process.env.CONTACT_EMAIL || 'hola@eltacochingon.com';
  }

  const announcement = pass.backFields.find((f) => f.key === 'announcement');
  if (announcement) {
    announcement.label = t.announcementLabel;
    announcement.value = getSetting('announcement') || t.announcementValue;
  }

  // Barcode encodes the serial number so a POS scanner can look up the customer
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         customer.serial_number,
    messageEncoding: 'iso-8859-1',
    altText:         t.barcodeAlt,
  });

  return pass.getAsBuffer();
}

module.exports = { generatePass };
