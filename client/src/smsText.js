// SMS must be plain Latin (printable ASCII + basic whitespace). Non-Latin
// scripts / emoji / smart quotes force costly unicode encoding and can be
// blocked by networks. Returns the unique disallowed characters (empty = OK).
// Iterates by code point so emoji count as a single character.
// Fill {name}/{amount} placeholders (case-insensitive) from a row, single-pass
// so a value containing a token isn't re-expanded. Missing -> empty string.
export function renderTemplate(template, { name, amount } = {}) {
  const values = {
    name: name == null ? '' : String(name),
    amount: amount == null ? '' : String(amount),
  };
  return String(template || '').replace(/\{\s*(name|amount)\s*\}/gi, (_m, key) => values[key.toLowerCase()]);
}

// Rough SMS segment estimate. Unicode (non-GSM) messages pack fewer chars.
// `prefixChars` reserves space for text prepended before the body (e.g. the
// "DCA: " identifier + the gateway sender label) so the count reflects what's
// actually sent.
export function smsSegments(text, prefixChars = 0) {
  const bodyLen = text.length;
  const totalLen = bodyLen + Math.max(0, prefixChars);
  if (totalLen === 0) return { bodyLen, totalLen, segments: 0, unicode: false };
  const unicode = /[^\x00-\x7F]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = totalLen <= single ? 1 : Math.ceil(totalLen / multi);
  return { bodyLen, totalLen, segments, unicode };
}

export function findNonLatin(text) {
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
