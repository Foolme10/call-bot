'use strict';

const config = require('../config');

// Turn whatever the user uploaded into a dialable string of digits.
// Rules (all configurable via .env):
//   - strip spaces, dashes, parentheses, dots and a leading "+"
//   - if DEFAULT_COUNTRY_CODE is set and the number starts with a national
//     trunk "0", replace that 0 with the country code (common E.164 fixup)
//   - prepend DIAL_PREFIX if configured
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  // Spreadsheets often turn numbers into "1.23457e+10" or add a trailing ".0".
  if (/e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  s = s.replace(/\.0+$/, '');
  // Keep digits only (drop +, spaces, dashes, parens, etc.).
  let digits = s.replace(/[^\d]/g, '');
  if (!digits) return '';

  const cc = config.dial.defaultCountryCode;
  if (cc && digits.startsWith('0') && !digits.startsWith(cc)) {
    digits = cc + digits.replace(/^0+/, '');
  }
  if (config.dial.prefix) digits = config.dial.prefix + digits;
  return digits;
}

// Loose sanity check; carriers vary, so we just bound the length.
function isValidPhone(digits) {
  return /^\d{5,15}$/.test(digits);
}

module.exports = { normalizePhone, isValidPhone };
