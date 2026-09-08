// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import LazyCardImage from '../src/components/LazyCardImage.vue';

describe('LazyCardImage', () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
