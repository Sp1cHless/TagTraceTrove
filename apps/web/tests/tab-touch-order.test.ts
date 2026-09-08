// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecentViewPage from '../src/RecentViewPage.vue';
import ViewLaterPage from '../src/ViewLaterPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
import { showNsfw } from '../src/stores/preferences.js';

function createApi(): GalleryApi {
  return {
    listGalleries: vi.fn(async () => [
      { type: 'game', entryCount: 0, nsfw: false },
      { type: 'nsfw', entryCount: 0, nsfw: true },
      { type: 'manga', entryCount: 0, nsfw: false },
    ]),
    listEntries: vi.fn(async () => []),
    listAuthors: vi.fn(async () => []),
    assetUrl: (assetRef: string) => assetRef,
  } as unknown as GalleryApi;
}

function visibleTabOrder(wrapper: ReturnType<typeof mount>, attribute: string): string[] {
  return wrapper.findAll(`[${attribute}]`).map((tab) => tab.attributes(attribute) ?? '');
}

describe('touch Gallery-tab ordering', () => {
  beforeEach(() => {
    window.localStorage.clear();
    showNsfw.value = false;
    setLocale('en');
  });

  it('moves the active Recently viewed tab with named touch controls and preserves hidden tabs', async () => {
    const wrapper = mount(RecentViewPage, { props: { api: createApi() } });
    await flushPromises();

    await wrapper.get('[data-recent-tab="manga"]').trigger('click');
    expect(wrapper.find('[data-testid="recent-tab-order-toggle"] .app-icon').exists()).toBe(true);
    await wrapper.get('[data-testid="recent-tab-order-toggle"]').trigger('click');
    expect(wrapper.find('[data-testid="recent-tab-order-toggle"]').exists()).toBe(false);
    expect(wrapper.find('.tab-order-tools').exists()).toBe(false);
    expect(wrapper.get('.recent-mode-switch').findAll('button')).toHaveLength(6);
    await wrapper.get('[data-testid="recent-tab-move-earlier"]').trigger('click');

    expect(visibleTabOrder(wrapper, 'data-recent-tab')).toEqual(['manga', 'game']);
    expect(JSON.parse(window.localStorage.getItem('t3.recent-tabs.order') ?? '[]')).toEqual([
      'manga',
      'game',
      'nsfw',
    ]);
    expect(wrapper.get('[data-testid="recent-tab-move-earlier"]').attributes('aria-label')).toContain('manga');

    await wrapper.get('[data-recent-tab="manga"]').trigger('dragstart');
    await wrapper.get('[data-recent-tab="game"]').trigger('drop');
    expect(visibleTabOrder(wrapper, 'data-recent-tab')).toEqual(['game', 'manga']);
  });

  it('moves the active View later tab without requiring HTML drag events', async () => {
    const wrapper = mount(ViewLaterPage, { props: { api: createApi() } });
    await flushPromises();

    await wrapper.get('[data-view-later-tab="manga"]').trigger('click');
    expect(wrapper.find('[data-testid="view-later-tab-order-toggle"] .app-icon').exists()).toBe(true);
    await wrapper.get('[data-testid="view-later-tab-order-toggle"]').trigger('click');
    expect(wrapper.find('[data-testid="view-later-tab-order-toggle"]').exists()).toBe(false);
    expect(wrapper.find('.tab-order-tools').exists()).toBe(false);
    expect(wrapper.get('.recent-mode-switch').findAll('button')).toHaveLength(6);
    await wrapper.get('[data-testid="view-later-tab-move-earlier"]').trigger('click');

    expect(visibleTabOrder(wrapper, 'data-view-later-tab')).toEqual(['manga', 'game']);
    expect(JSON.parse(window.localStorage.getItem('t3.view-later-tabs.order') ?? '[]')).toEqual([
      'manga',
      'game',
      'nsfw',
    ]);
    expect(wrapper.get('[data-testid="view-later-tab-move-earlier"]').attributes('aria-label')).toContain('manga');

    const restored = mount(ViewLaterPage, { props: { api: createApi() } });
    await flushPromises();
    expect(visibleTabOrder(restored, 'data-view-later-tab')).toEqual(['manga', 'game']);
    expect(restored.get('[data-view-later-tab="manga"]').attributes('aria-selected')).toBe('true');
    restored.unmount();

    await wrapper.get('[data-view-later-tab="manga"]').trigger('dragstart');
    await wrapper.get('[data-view-later-tab="game"]').trigger('drop');
    expect(visibleTabOrder(wrapper, 'data-view-later-tab')).toEqual(['game', 'manga']);
  });
});
