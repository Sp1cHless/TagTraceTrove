// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

describe('shared View later store', () => {
  it('merges the legacy browser list into the server once without losing either side', async () => {
    window.localStorage.setItem('t3.view-later', JSON.stringify([1, 1, 2]));
    const api = {
      getViewLaterState: vi.fn(async () => ({ entryIds: [3], producerIds: [8] })),
      mergeViewLaterEntries: vi.fn(async () => ({ entryIds: [3, 1, 2], producerIds: [8] })),
      addViewLaterEntry: vi.fn(async () => ({ entryIds: [3, 1, 2], producerIds: [8] })),
      removeViewLaterEntry: vi.fn(async () => ({ entryIds: [3, 2], producerIds: [8] })),
      addViewLaterAuthor: vi.fn(async () => ({ entryIds: [3, 1, 2], producerIds: [8] })),
      removeViewLaterAuthor: vi.fn(async () => ({ entryIds: [3, 1, 2], producerIds: [] })),
    };
    const store = await import('../src/stores/preferences.js');

    await store.initializeViewLater(api);

    expect(api.mergeViewLaterEntries).toHaveBeenCalledWith([1, 2]);
    expect(api.getViewLaterState).not.toHaveBeenCalled();
    expect(store.viewLaterIds.value).toEqual([3, 1, 2]);
    expect(store.viewLaterAuthorIds.value).toEqual([8]);
    expect(window.localStorage.getItem('t3.view-later')).toBeNull();
  });

  it('serializes startup, refreshes, and mutations so stale responses cannot overwrite newer state', async () => {
    let resolveList!: (state: { entryIds: number[]; producerIds: number[] }) => void;
    const api = {
      getViewLaterState: vi.fn(() => new Promise<{ entryIds: number[]; producerIds: number[] }>((resolve) => { resolveList = resolve; })),
      mergeViewLaterEntries: vi.fn(async () => ({ entryIds: [], producerIds: [] })),
      addViewLaterEntry: vi.fn(async () => ({ entryIds: [1], producerIds: [] })),
      removeViewLaterEntry: vi.fn(async () => ({ entryIds: [], producerIds: [] })),
      addViewLaterAuthor: vi.fn(async () => ({ entryIds: [], producerIds: [] })),
      removeViewLaterAuthor: vi.fn(async () => ({ entryIds: [], producerIds: [] })),
    };
    const store = await import('../src/stores/preferences.js');

    const initialization = store.initializeViewLater(api);
    const mutation = store.toggleViewLater(api, 1);
    await Promise.resolve();
    expect(api.addViewLaterEntry).not.toHaveBeenCalled();

    resolveList({ entryIds: [], producerIds: [] });
    await Promise.all([initialization, mutation]);
    expect(api.addViewLaterEntry).toHaveBeenCalledWith(1);
    expect(store.viewLaterIds.value).toEqual([1]);
  });

  it('uses server mutations as the authority for both Entries and Authors', async () => {
    const api = {
      getViewLaterState: vi.fn(async () => ({ entryIds: [2], producerIds: [8] })),
      mergeViewLaterEntries: vi.fn(async () => ({ entryIds: [], producerIds: [] })),
      addViewLaterEntry: vi.fn(async () => ({ entryIds: [2, 1], producerIds: [8] })),
      removeViewLaterEntry: vi.fn(async () => ({ entryIds: [1], producerIds: [8] })),
      addViewLaterAuthor: vi.fn(async () => ({ entryIds: [1], producerIds: [8, 9] })),
      removeViewLaterAuthor: vi.fn(async () => ({ entryIds: [1], producerIds: [9] })),
    };
    const store = await import('../src/stores/preferences.js');

    await store.initializeViewLater(api);
    expect(store.viewLaterIds.value).toEqual([2]);
    expect(store.viewLaterAuthorIds.value).toEqual([8]);

    await store.toggleViewLater(api, 1);
    expect(api.addViewLaterEntry).toHaveBeenCalledWith(1);
    expect(store.viewLaterIds.value).toEqual([2, 1]);

    await store.toggleViewLater(api, 2);
    expect(api.removeViewLaterEntry).toHaveBeenCalledWith(2);
    expect(store.viewLaterIds.value).toEqual([1]);

    await store.toggleAuthorViewLater(api, 9);
    expect(api.addViewLaterAuthor).toHaveBeenCalledWith(9);
    expect(store.viewLaterAuthorIds.value).toEqual([8, 9]);

    await store.toggleAuthorViewLater(api, 8);
    expect(api.removeViewLaterAuthor).toHaveBeenCalledWith(8);
    expect(store.viewLaterAuthorIds.value).toEqual([9]);
  });
});
