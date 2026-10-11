// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CoverComposition from '../src/components/CoverComposition.vue';

const refs = (count: number) => Array.from({ length: count }, (_, index) => `/cover-${index + 1}.webp`);

function tracks(variant: 'author-card' | 'author-detail' | 'collection', count: number) {
  const wrapper = mount(CoverComposition, {
    props: {
      variant,
      coverRefs: refs(count),
      alt: 'Example',
      assetUrl: (ref: string) => ref,
    },
  });
  const element = wrapper.element as HTMLElement;
  return {
    columns: element.style.gridTemplateColumns,
    rows: element.style.gridTemplateRows,
    images: wrapper.findAll('img').length,
    placeholders: wrapper.findAll('.mini-placeholder').length,
  };
}

describe('CoverComposition', () => {
  it('derives complete Author and Collection tracks from the visible cover count', () => {
    expect(tracks('author-card', 1)).toMatchObject({
      columns: 'repeat(1, minmax(0, 1fr))',
      rows: 'repeat(1, minmax(0, 1fr))',
      images: 1,
    });
    expect(tracks('author-card', 4)).toMatchObject({
      columns: 'repeat(2, minmax(0, 1fr))',
      rows: 'repeat(2, minmax(0, 1fr))',
      images: 4,
    });
    expect(tracks('author-detail', 5)).toMatchObject({
      columns: 'repeat(2, minmax(0, 1fr))',
      rows: 'repeat(2, minmax(0, 1fr))',
      images: 4,
    });

    expect(tracks('collection', 1)).toMatchObject({
      columns: 'repeat(1, minmax(0, 1fr))',
      rows: 'repeat(1, minmax(0, 1fr))',
      images: 1,
      placeholders: 0,
    });
    expect(tracks('collection', 2)).toMatchObject({
      columns: 'repeat(2, minmax(0, 1fr))',
      rows: 'repeat(1, minmax(0, 1fr))',
      images: 2,
      placeholders: 0,
    });
    expect(tracks('collection', 4)).toMatchObject({
      columns: 'repeat(3, minmax(0, 1fr))',
      rows: 'repeat(1, minmax(0, 1fr))',
      images: 3,
      placeholders: 0,
    });
    expect(tracks('collection', 0)).toMatchObject({
      columns: 'repeat(1, minmax(0, 1fr))',
      rows: 'repeat(1, minmax(0, 1fr))',
      images: 0,
      placeholders: 1,
    });
  });
});
