import { describe, expect, it } from 'vitest';
import { resolveServerBinding } from '../../src/http/server-launch-config.js';

describe('server launch binding guard', () => {
  it('defaults to localhost-only binding', () => {
    expect(resolveServerBinding({})).toEqual({ hostname: '127.0.0.1', enableLan: false });
  });

  it('rejects non-loopback binding without explicit LAN permission', () => {
    expect(() => resolveServerBinding({ T3_HOST: '0.0.0.0' })).toThrow(
      'Set T3_ENABLE_LAN=true before binding the API outside localhost',
    );
  });

  it('allows all-interface binding only with explicit LAN permission', () => {
    expect(resolveServerBinding({ T3_HOST: '0.0.0.0', T3_ENABLE_LAN: 'true' })).toEqual({
      hostname: '0.0.0.0',
      enableLan: true,
    });
  });
});
