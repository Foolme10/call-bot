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

// Fill {name}/{amount} placeholders (case-insensitive) from a contact row —
// must match client/src/smsText.js and smsSender.renderTemplate. Single-pass so
// a value containing a token isn't re-expanded; missing values -> empty string.
function renderTemplate(template, { name, amount } = {}) {
  const values = {
    name: name == null ? '' : String(name),
    amount: amount == null ? '' : String(amount),
  };
  return String(template || '').replace(/\{\s*(name|amount)\s*\}/gi, (_m, key) => values[key.toLowerCase()]);
}

module.exports = { findNonLatin, smsSegments, renderTemplate };
