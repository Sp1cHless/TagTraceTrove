/**
 * `crypto.randomUUID` is only exposed in a secure context. A phone opening T3
 * through its LAN address (`http://192.168.x.x:8765`) is not one, so the whole
 * offline stack must start without it. `getRandomValues` stays available on
 * insecure origins; `Math.random` is the last resort for a runtime without the
 * Crypto interface at all.
 */
export function randomUuid(): string {
  const cryptoApi: Partial<Crypto> | undefined = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 version 4 / variant 1, so the value is a well-formed UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
