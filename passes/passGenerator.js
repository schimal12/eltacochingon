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
    rewardReady:       (reward) => `You won ${reward}!`,
    rewardRemaining:   (n, reward) => `${n} more stamp${n === 1 ? '' : 's'} for ${reward}`,
    termsLabel:        'Terms & Conditions',
    termsValue:        'One stamp per visit. Reward valid for 30 days after earning. Not transferable. Management reserves the right to modify or discontinue this program at any time.',
    websiteLabel:      'Website',
    contactLabel:      'Contact',
    addressLabel:      'Location',
    infoLabel:         'Info',
    infoValue:         'Welcome to our loyalty program!',
    barcodeAlt:        'Loyalty Card',
  },
  es: {
    description:      'Tarjeta de Lealtad',
    customerLabel:     'Cliente',
    stampsLabel:       'Sellos',
    rewardLabel:       'Próxima Recompensa',
    rewardReady:       (reward) => `¡Ganaste ${reward}!`,
    rewardRemaining:   (n, reward) => `${n} sello${n === 1 ? '' : 's'} más para ${reward}`,
    termsLabel:        'Términos y Condiciones',
    termsValue:        'Un sello por visita. La recompensa es válida por 30 días después de obtenerla. No transferible. La administración se reserva el derecho de modificar o descontinuar este programa en cualquier momento.',
    websiteLabel:      'Sitio Web',
    contactLabel:      'Contacto',
    addressLabel:      'Ubicación',
    infoLabel:         'Aviso',
    infoValue:         '¡Bienvenido a nuestro programa de lealtad!',
    barcodeAlt:        'Tarjeta de Lealtad',
  },
};

function translationsFor(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

/**
 * True once a customer has completed a full stamp cycle and hasn't started
 * the next one yet (e.g. exactly 10, 20, 30... stamps for a 10-stamp card).
 */
function isRewardReady(stamps, stampsRequired) {
  return stamps > 0 && stamps % stampsRequired === 0;
}

/**
 * Compute a human-friendly "next reward" string from the current stamp count.
 */
function nextRewardText(stamps, stampsRequired, rewardText, t) {
  if (isRewardReady(stamps, stampsRequired)) return t.rewardReady(rewardText);
  const remaining = stampsRequired - (stamps % stampsRequired);
  return t.rewardRemaining(remaining, rewardText);
}

/**
 * Render the current stamp cycle as filled/empty taco emoji.
 */
function stampVisual(stamps, stampsRequired) {
  const cycle  = stamps % stampsRequired;
  const filled = cycle === 0 && stamps > 0 ? stampsRequired : cycle;
  return '🌮'.repeat(filled) + '◯'.repeat(stampsRequired - filled);
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
    // Apple's Wallet protocol appends "/v1/devices/..." to webServiceURL
    // itself -- the "v1" is Apple's own protocol version, not ours to add.
    // (Confirmed against live device traffic: with "${baseUrl}/v1" here,
    // real requests came in as "/v1/v1/devices/..." and 404'd.)
    webServiceURL:       baseUrl,
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
  // Note: primaryFields renders as large overlay text directly on top of the
  // strip image, which is why customer name/stamps live in secondaryFields
  // instead (see git history) -- primaryFields is only used below, and only
  // for the reward-ready celebration banner.

  // secondaryFields: customer name + stamp count (taco emoji)
  const nameField = pass.secondaryFields.find((f) => f.key === 'name');
  if (nameField) {
    nameField.label = t.customerLabel;
    nameField.value = customer.name;
  }

  const stampsRequired = customer.stamps_required;
  const rewardText     = customer.reward_text;
  const ready           = isRewardReady(customer.stamps, stampsRequired);

  const stampsField = pass.secondaryFields.find((f) => f.key === 'stamps');
  if (stampsField) {
    stampsField.label = t.stampsLabel;
    stampsField.value = stampVisual(customer.stamps, stampsRequired);
  }

  // auxiliaryFields[0] → next reward message
  if (pass.auxiliaryFields.length > 0) {
    pass.auxiliaryFields[0].label = t.rewardLabel;
    pass.auxiliaryFields[0].value = nextRewardText(customer.stamps, stampsRequired, rewardText, t);
  }

  // primaryFields render as large overlay text on top of the strip image
  // (see the git history on why storeCard normally avoids that slot) --
  // repurposed here as a celebratory banner, shown only when a reward is
  // ready so it never collides with the customer's name.
  const celebration = pass.primaryFields.find((f) => f.key === 'celebration');
  if (celebration) {
    celebration.value = ready ? `🌮 ${t.rewardReady(rewardText)}` : '';
  }

  // backFields: terms/website/contact/address labels and values.
  const terms = pass.backFields.find((f) => f.key === 'terms');
  if (terms) {
    terms.label = t.termsLabel;
    terms.value = t.termsValue;
  }

  const website = pass.backFields.find((f) => f.key === 'website');
  if (website) {
    website.label = t.websiteLabel;
    website.value = process.env.INSTAGRAM_URL || 'https://www.instagram.com/eltacochingon/';
  }

  const contact = pass.backFields.find((f) => f.key === 'contact');
  if (contact) {
    contact.label = t.contactLabel;
    contact.value = process.env.CONTACT_PHONE || '925 666 685';
  }

  const address = pass.backFields.find((f) => f.key === 'address');
  if (address) {
    address.label = t.addressLabel;
    address.value = process.env.MAPS_URL || 'https://maps.app.goo.gl/ZyA3LPzwp2U5BKuh8';
  }

  // Small, low-key field whose only job is carrying /admin/notify broadcast
  // text -- Wallet only shows a lock-screen banner for a push when some
  // field's value visibly changed, via this field's changeMessage template.
  const info = pass.backFields.find((f) => f.key === 'info');
  if (info) {
    info.label = t.infoLabel;
    info.value = (await getSetting('announcement')) || t.infoValue;
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
