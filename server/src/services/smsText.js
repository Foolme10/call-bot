'use strict';

// SMS must be plain Latin text (printable ASCII + basic whitespace). Non-Latin
// scripts / emoji / smart quotes force costly unicode (UCS-2) encoding and are
// blocked by some networks. Returns the unique disallowed characters found
// (empty array = OK). Iterates by code point so emoji count as one char.
function findNonLatin(text) {
  const bad = [];
  const seen = new Set();
  for (const ch of String(text == null ? '' : text)) {
    const code = ch.codePointAt(0);
    const ok = (code >= 0x20 && code <= 0x7e) || code === 0x0a || code === 0x0d || code === 0x09;
    if (ok || seen.has(ch)) continue;
    seen.add(ch);
    bad.push(ch);
  }
  return bad;
}

// SMS segment estimate — must match client/src/smsText.js. `prefixChars`
// reserves space for text prepended before the body (the "DCA: " identifier +
// the gateway sender label) so the count reflects what's actually sent.
function smsSegments(text, prefixChars = 0) {
  const body = String(text == null ? '' : text);
  const totalLen = body.length + Math.max(0, prefixChars);
  if (totalLen === 0) return { totalLen, segments: 0, unicode: false };
  const unicode = /[^\x00-\x7F]/.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = totalLen <= single ? 1 : Math.ceil(totalLen / multi);
  return { totalLen, segments, unicode };
}

// Fill {variable} placeholders from a contact's values. Variables are dynamic:
// any key in `values` (e.g. an uploaded spreadsheet header like {name}, {amount},
// {due_date}, {ref}) is substituted, matched case-insensitively and ignoring
// surrounding whitespace. A token with no matching value is left as-is (so a typo
// like {amont} is visible rather than silently blanked). Single-pass so a value
// that itself contains a token isn't re-expanded. Must match client/src/smsText.js
// and smsSender.renderTemplate.
function renderTemplate(template, values = {}) {
  const lookup = Object.create(null);
  for (const [k, v] of Object.entries(values || {})) {
    lookup[String(k).trim().toLowerCase()] = v == null ? '' : String(v);
  }
  return String(template || '').replace(/\{\s*([^{}]+?)\s*\}/g, (m, rawKey) => {
    const key = String(rawKey).trim().toLowerCase();
    return key in lookup ? lookup[key] : m;
  });
}

// A contacts/call_logs row's `fields` column is JSON. mysql2 usually hands it
// back already parsed, but tolerate a raw string (or null) too.
function asFields(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch (_e) {
    return {};
  }
}

// Build the variable set for rendering one recipient's message: every uploaded
// column (from `fields`), with the mapped name/amount columns taking precedence
// when they hold a value (so {name}/{amount} follow the column the user picked,
// not a stray same-named header).
function contactValues(row) {
  const values = { ...asFields(row && row.fields) };
  if (row && row.name != null && row.name !== '') values.name = row.name;
  if (row && row.amount != null && row.amount !== '') values.amount = row.amount;
  return values;
}

module.exports = { findNonLatin, smsSegments, renderTemplate, asFields, contactValues };
