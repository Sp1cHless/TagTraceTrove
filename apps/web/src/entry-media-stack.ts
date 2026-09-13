export interface EntryStackMedia {
  coverRef: string | null;
  previewRefs: readonly string[];
}

const MAX_VISIBLE_LAYERS = 4;
const MANAGED_ENTRY_ASSET_PREFIX = '/api/assets/entries/';

export function entryCardMediaRef(ref: string): string {
  return ref.startsWith(MANAGED_ENTRY_ASSET_PREFIX)
    ? ref.replace(MANAGED_ENTRY_ASSET_PREFIX, '/api/thumbnails/entries/')
    : ref;
}

export function entryStackLayers(entry: EntryStackMedia): string[] {
  return [...new Set([
    ...(entry.coverRef ? [entry.coverRef] : []),
    ...entry.previewRefs,
  ])].slice(0, MAX_VISIBLE_LAYERS);
}

export function entryStackLayerStyle(index: number, count: number): Record<string, string> {
  if (count <= 1) {
    return {
      left: '0%',
      top: '0%',
      width: '100%',
      height: '100%',
      maxWidth: '100%',
      objectFit: 'contain',
      background: 'transparent',
      transform: 'none',
      transformOrigin: '50% 50%',
      backfaceVisibility: 'hidden',
      zIndex: '1',
    };
  }

  const visibleCount = Math.max(1, Math.min(count, MAX_VISIBLE_LAYERS));
  const layerIndex = Math.max(0, Math.min(index, visibleCount - 1));
  const totalSpread = visibleCount > 1 ? Math.min(34, (visibleCount - 1) * 17) : 0;
  const step = visibleCount > 1 ? totalSpread / (visibleCount - 1) : 0;

  return {
    left: `${43 - (layerIndex * step)}%`,
    top: `${2 + (layerIndex * 2.5)}%`,
    width: 'auto',
    height: `${94 - (layerIndex * 7)}%`,
    maxWidth: '82%',
    objectFit: 'contain',
    background: 'transparent',
    transform: 'rotateY(30deg)',
    transformOrigin: '50% 50%',
    backfaceVisibility: 'hidden',
    zIndex: String(visibleCount - layerIndex),
  };
}
