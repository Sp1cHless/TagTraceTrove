import { describe, expect, it } from 'vitest';
import {
  createCollectionFilterState,
  removeTagFilter,
  toggleTagFilter,
} from '../src/stores/collection-filter.js';

const romance = { fieldKey: 'genre', tagKey: 'romance', label: 'Romance' };

describe('collection filter state', () => {
  it('supports direct include, exclude, and removal actions without dialogs', () => {
    const initial = createCollectionFilterState();
    const included = toggleTagFilter(initial, romance, 'include');
    const excluded = toggleTagFilter(included, romance, 'exclude');
    const removed = removeTagFilter(excluded, romance);

    expect(included).toMatchObject({ include: [romance], exclude: [] });
    expect(excluded).toMatchObject({ include: [], exclude: [romance] });
    expect(removed).toMatchObject({ include: [], exclude: [] });
  });

  it('toggles an already active filter off', () => {
    const included = toggleTagFilter(createCollectionFilterState(), romance, 'include');

    expect(toggleTagFilter(included, romance, 'include').include).toEqual([]);
  });
});