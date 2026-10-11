// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createShellLibraryIdSource } from '../src/offline/native-shell-library-id.js';

function bridgeWith(result: unknown) {
  return { nativePromise: vi.fn(async () => result) };
}

describe('the shell library identity source', () => {
  it('asks the bridge once and remembers the answer', async () => {
    const bridge = bridgeWith({ paired: true, libraryId: 'library-a' });
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => true });
    expect(await source.read()).toBe('library-a');
    expect(await source.read()).toBe('library-a');
    expect(await source.read()).toBe('library-a');
    expect(bridge.nativePromise).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read between callers', async () => {
    let release!: (value: unknown) => void;
    const bridge = { nativePromise: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => true });
    const first = source.read();
    const second = source.read();
    release({ paired: true, libraryId: 'library-b' });
    expect(await Promise.all([first, second])).toEqual(['library-b', 'library-b']);
    expect(bridge.nativePromise).toHaveBeenCalledTimes(1);
  });

  it('forgets the identity when pairing may have changed', async () => {
    const bridge = bridgeWith({ paired: true, libraryId: 'library-a' });
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => true });
    await source.read();
    source.invalidate();
    await source.read();
    expect(bridge.nativePromise).toHaveBeenCalledTimes(2);
  });

  it('never remembers an answer it did not get', async () => {
    const bridge = { nativePromise: vi.fn(async () => { throw new Error('bridge unavailable'); }) };
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => true });
    expect(await source.read()).toBeNull();
    expect(await source.read()).toBeNull();
    expect(bridge.nativePromise).toHaveBeenCalledTimes(2);
  });

  it('does not call the bridge outside the native shell', async () => {
    const bridge = bridgeWith({ paired: true, libraryId: 'library-a' });
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => false });
    expect(await source.read()).toBeNull();
    expect(bridge.nativePromise).not.toHaveBeenCalled();
  });

  it('reports an unpaired shell as no identity', async () => {
    const bridge = bridgeWith({ paired: false });
    const source = createShellLibraryIdSource({ bridge, isNativeShell: () => true });
    expect(await source.read()).toBeNull();
  });
});
