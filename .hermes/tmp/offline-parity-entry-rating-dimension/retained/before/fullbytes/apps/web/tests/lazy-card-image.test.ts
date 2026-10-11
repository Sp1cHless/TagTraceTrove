// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import LazyCardImage from '../src/components/LazyCardImage.vue';
import { cachedMediaObjectUrls } from '../src/offline/cached-media-object-urls.js';

describe('LazyCardImage', () => {
  afterEach(() => {
    cachedMediaObjectUrls.clear();
    vi.unstubAllGlobals();
  });

  it('waits until the card is near the viewport before assigning the image URL', async () => {
    let notify: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();

    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = '240px 0px';
      thresholds = [0];
    }

    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const wrapper = mount(LazyCardImage, {
      props: { src: '/api/assets/entries/1/cover.webp', alt: 'Cover' },
    });

    expect(observe).toHaveBeenCalledOnce();
    expect(wrapper.get('img').attributes('src')).toBeUndefined();

    notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await nextTick();

    expect(wrapper.get('img').attributes('src')).toBe('/api/assets/entries/1/cover.webp');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a pending bitmap invisible and requests it eagerly after intersection', async () => {
    let notify: IntersectionObserverCallback | undefined;

    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = '240px 0px';
      thresholds = [0];
    }

    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const wrapper = mount(LazyCardImage, {
      props: { src: '/api/assets/entries/1/cover.webp', alt: 'Cover' },
    });
    const image = wrapper.get('img');

    expect(image.attributes('style') ?? '').toContain('visibility: hidden');
    notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await nextTick();

    expect(image.attributes('loading')).toBe('eager');
    expect(image.attributes('style') ?? '').toContain('visibility: hidden');

    await image.trigger('load');
    expect(image.attributes('style')).toContain('visibility: visible');
  });

  it('hides the bitmap and alt text again if a loaded image later errors', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const wrapper = mount(LazyCardImage, {
      props: { src: '/api/assets/entries/1/cover.webp', alt: 'Cover title' },
    });
    const image = wrapper.get('img');

    expect(image.attributes('alt')).toBe('');
    await image.trigger('load');
    expect(image.attributes('alt')).toBe('Cover title');
    expect(image.attributes('style')).toContain('visibility: visible');

    await image.trigger('error');
    expect(image.attributes('alt')).toBe('');
    expect(image.attributes('style')).toContain('visibility: hidden');
  });

  it('uses Cache Storage before network and reuses the loaded object URL after remount', async () => {
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { void callback; }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = '240px 0px';
      thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const NativeURL = URL;
    class FakeURL extends NativeURL {
      static createObjectURL = vi.fn(() => 'blob:t3-cached-cover');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', FakeURL);
    const source = 'https://t3.local/api/thumbnails/entries/1/cover.webp';
    const immutable = 'https://t3.local/api/assets/entries/1/thumbnails/cover.0123456789abcdef.webp';
    const stored = new Map<string, Response>([
      [source, new Response(null, { status: 302, headers: { location: immutable } })],
      [immutable, new Response('cached-image', { status: 200, headers: { 'content-type': 'image/webp' } })],
    ]);
    vi.stubGlobal('caches', {
      async open() {
        return { async match(request: RequestInfo | URL) { return stored.get(String(request)); } };
      },
    });
    const wrapper = mount(LazyCardImage, { props: { src: source, alt: 'Cover title' } });
    const image = wrapper.get('img');

    await flushPromises();
    expect(image.attributes('src')).toBe('blob:t3-cached-cover');
    await image.trigger('load');
    expect(image.attributes('alt')).toBe('Cover title');
    expect(image.attributes('style')).toContain('visibility: visible');
    wrapper.unmount();

    const remounted = mount(LazyCardImage, { props: { src: source, alt: 'Cover title' } });
    await flushPromises();

    expect(remounted.get('img').attributes('src')).toBe('blob:t3-cached-cover');
    expect(remounted.get('img').attributes('style')).toContain('visibility: visible');
    expect(FakeURL.createObjectURL).toHaveBeenCalledOnce();
  });
});
