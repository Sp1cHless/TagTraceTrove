// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { retireNativeShellServiceWorker } from '../src/offline/native-shell-service-worker.js';

describe('native shell service worker retirement', () => {
  it('unregisters stale workers, deletes only shell caches, and reloads once', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const deleted: string[] = [];
    const storage = new Map<string, string>();
    const reload = vi.fn();
    const dependencies = {
      registrations: async () => [{ unregister }],
      cacheKeys: async () => ['t3-shell-v4', 't3-offline-media-v1', 'other-cache'],
      deleteCache: async (name: string) => {
        deleted.push(name);
        return true;
      },
      hasController: true,
      getSessionItem: (key: string) => storage.get(key) ?? null,
      setSessionItem: (key: string, value: string) => storage.set(key, value),
      reload,
    };

    await retireNativeShellServiceWorker(dependencies);
    await retireNativeShellServiceWorker(dependencies);

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual(['t3-shell-v4', 't3-shell-v4']);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
