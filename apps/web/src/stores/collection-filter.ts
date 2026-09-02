export interface FilterChip {
  fieldKey: string;
  tagKey: string;
  label: string;
}

export interface RatingFilter {
  fieldKey: string;
  minimum?: number;
  maximum?: number;
}

export interface CollectionFilterState {
  include: FilterChip[];
  exclude: FilterChip[];
  ratings: RatingFilter[];
  query: string;
}

export type TagFilterMode = 'include' | 'exclude';

export function createCollectionFilterState(): CollectionFilterState {
  return { include: [], exclude: [], ratings: [], query: '' };
}

function isSameFilter(left: FilterChip, right: FilterChip): boolean {
  return left.fieldKey === right.fieldKey && left.tagKey === right.tagKey;
}

export function removeTagFilter(
  state: CollectionFilterState,
  chip: FilterChip,
): CollectionFilterState {
  return {
    ...state,
    include: state.include.filter((candidate) => !isSameFilter(candidate, chip)),
    exclude: state.exclude.filter((candidate) => !isSameFilter(candidate, chip)),
  };
}

export function toggleTagFilter(
  state: CollectionFilterState,
  chip: FilterChip,
  mode: TagFilterMode,
): CollectionFilterState {
  const withoutChip = removeTagFilter(state, chip);
  const wasActive = state[mode].some((candidate) => isSameFilter(candidate, chip));

  if (wasActive) {
    return withoutChip;
  }

  return {
    ...withoutChip,
    [mode]: [...withoutChip[mode], chip],
  };
}