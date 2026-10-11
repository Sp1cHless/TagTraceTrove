// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from '../src/offline/random-id.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('secure-context-free random id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the platform randomUUID when the context exposes it', () => {
    const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('crypto', { randomUUID });

    expect(randomUuid()).toBe('11111111-1111-4111-8111-111111111111');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('builds a version 4 UUID from getRandomValues on an insecure origin', () => {
    // http://192.168.x.x:8765 exposes getRandomValues, but neither randomUUID
    // nor subtle: Chrome gates those two on a secure context.
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });

    expect(randomUuid()).toMatch(uuidPattern);
  });

  it('stays unique when no Crypto interface exists at all', () => {
    vi.stubGlobal('crypto', undefined);

    const values = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(values.size).toBe(50);
    for (const value of values) {
      expect(value).toMatch(uuidPattern);
    }
  });
});
