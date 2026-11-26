/** "gemini", "vertex", or null when a Google API key is in a format we do not recognise. */
export function detectKeyType(key) {
  if (typeof key !== 'string') return null;
  if (/^AIza[A-Za-z0-9_-]{30,}$/.test(key)) return 'gemini';
  if (/^AQ\.[A-Za-z0-9._-]{20,}$/.test(key)) return 'vertex';
  return null;
}
