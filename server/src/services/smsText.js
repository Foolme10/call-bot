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

module.exports = { findNonLatin };
