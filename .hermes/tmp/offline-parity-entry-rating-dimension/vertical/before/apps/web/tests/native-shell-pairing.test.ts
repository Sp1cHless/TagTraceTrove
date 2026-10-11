import { describe, expect, it } from 'vitest';
import { normalizeTrustedLanHttpOrigin } from '../../../spikes/001-android-webview-shell/pairing-origin.mjs';

describe('Android spike pairing URL', () => {
  it('retains only a literal private IPv4 HTTP origin', () => {
    expect(normalizeTrustedLanHttpOrigin('http://192.168.1.20:8765')).toBe('http://192.168.1.20:8765');
    expect(normalizeTrustedLanHttpOrigin('http://10.3.4.5')).toBe('http://10.3.4.5');
    expect(normalizeTrustedLanHttpOrigin('http://172.31.0.9:8765/')).toBe('http://172.31.0.9:8765');
  });

  it.each([
    'http://user:pass@192.168.1.20:8765',
    'http://192.168.1.20:8765/api',
    'http://192.168.1.20:8765/?token=secret',
    'http://192.168.1.20:8765/#x',
    'http://192.168.1.20:8765\\@example.com',
    'http://127.0.0.1:8765',
    'http://localhost:8765',
    'http://169.254.0.1:8765',
    'https://192.168.1.20:8765',
    'http://192.168.1.20.evil.com:8765',
    'http://0xc0a80114:8765',
    'http://192.168.1.20:0',
  ])('rejects unsafe, noncanonical or ambiguous origin %s', (value) => {
    expect(normalizeTrustedLanHttpOrigin(value)).toBeNull();
  });
});
