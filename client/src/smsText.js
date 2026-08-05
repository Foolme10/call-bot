// SMS must be plain Latin (printable ASCII + basic whitespace). Non-Latin
// scripts / emoji / smart quotes force costly unicode encoding and can be
// blocked by networks. Returns the unique disallowed characters (empty = OK).
// Iterates by code point so emoji count as a single character.
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
