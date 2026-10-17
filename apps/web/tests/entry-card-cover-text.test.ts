// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import EntryCard from '../src/components/EntryCard.vue';

const api = { assetUrl: (path: string) => path };

function card(entry: {
  title: string;
  coverRef?: string | null;
  previewRefs?: string[];
  coverText?: string | null;
}) {
  return mount(EntryCard, {
    props: {
      api,
      entry: {
        id: 1,
        title: entry.title,
        type: 'comic',
        coverRef: entry.coverRef ?? null,
        previewRefs: entry.previewRefs ?? [],
        coverText: entry.coverText,
      },
    },
  });
}

/**
 * The default cover: a work with no image shows the text it carries. Without one it keeps the
 * title's first letter, which is what every cover-less card showed before.
 */
describe('work card default cover', () => {
  it('shows the work’s own text in the cover slot when it has no image', () => {
    const wrapper = card({ title: 'Lighthouse', coverText: '一个关于灯塔看守人的安静故事。' });
    expect(wrapper.find('[data-testid="entry-cover-text"]').text()).toBe('一个关于灯塔看守人的安静故事。');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('keeps the title’s first letter when the work carries nothing readable', () => {
    const wrapper = card({ title: 'Lighthouse', coverText: null });
    expect(wrapper.find('[data-testid="entry-cover-text"]').exists()).toBe(false);
    expect(wrapper.find('.entry-placeholder').text()).toBe('L');
  });

  it('keeps the letter when the list predates the field', () => {
    const wrapper = card({ title: 'Lighthouse' });
    expect(wrapper.find('.entry-placeholder').text()).toBe('L');
  });

  it('shows no text at all once the work has an image', () => {
    const wrapper = card({ title: 'Lighthouse', coverRef: '/api/assets/entries/1/cover.webp', coverText: '一个故事' });
    expect(wrapper.find('.entry-placeholder').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(true);
  });
});
