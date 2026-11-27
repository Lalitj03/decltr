// Which browser this is, in words people recognise: "Google Chrome", "Microsoft Edge", "Brave", ...
// Used to label export files and, when sharing, to say which browser a session came from.

const GENERIC = /^(chromium|not.?a.?brand|.*not.*brand.*)$/i;

export function detectBrowserName(nav = globalThis.navigator) {
  if (!nav) return 'Chromium';
  if (nav.brave) return 'Brave';
  const brand = (nav.userAgentData?.brands ?? []).map((b) => b.brand).find((b) => b && !GENERIC.test(b.trim()));
  if (brand) return brand.trim();
  const ua = String(nav.userAgent ?? '');
  if (/\bEdg\//.test(ua)) return 'Microsoft Edge';
  if (/\bOPR\//.test(ua)) return 'Opera';
  if (/\bVivaldi\//.test(ua)) return 'Vivaldi';
  if (/\bYaBrowser\//.test(ua)) return 'Yandex Browser';
  return /\bChrome\//.test(ua) ? 'Chromium' : 'Browser';
}

/** "Decltr 0.7.0" */
export const appName = () => `Decltr ${globalThis.chrome?.runtime?.getManifest?.().version ?? ''}`.trim();
