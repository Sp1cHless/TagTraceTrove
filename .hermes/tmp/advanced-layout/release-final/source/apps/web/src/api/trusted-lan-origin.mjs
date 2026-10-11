// Shared by the Android pairing bootstrap and native-shell API routing.
// Dependency-free: prepare-web embeds the function source into WebView HTML.
export function normalizeTrustedLanHttpOrigin(value) {
  if (typeof value !== 'string') return null;
  const match = /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::([1-9]\d{0,4}))?\/?$/u.exec(value.trim());
  if (!match) return null;
  const [a, b, c, d] = match[1].split('.').map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return null;
  if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168)) return null;
  if (match[2] && Number(match[2]) > 65535) return null;
  try { return new globalThis.URL(value.trim()).origin; } catch { return null; }
}
