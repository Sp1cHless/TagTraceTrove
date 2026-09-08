import { ref, watch } from 'vue';
import type { ViewLaterState } from '@t3/shared';
import type { GalleryApi } from '../api/gallery.js';

const STORAGE_KEY = 't3.showNsfw';

function restore(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Show-NSFW is a display preference (never persisted to the database): the
 * partition of a Gallery lives in gallery_settings, this switch only controls
 * whether NSFW galleries and authors are visible in the UI.
 */
export const showNsfw = ref<boolean>(restore());

watch(showNsfw, (value) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Storage unavailable — the preference just won't survive a reload.
  }
});

const VIEW_LATER_KEY = 't3.view-later';

type ViewLaterApi = Pick<GalleryApi,
  | 'getViewLaterState'
  | 'addViewLaterEntry'
  | 'removeViewLaterEntry'
  | 'mergeViewLaterEntries'
  | 'addViewLaterAuthor'
  | 'removeViewLaterAuthor'>;

function normalizeViewLaterIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => (
    typeof id === 'number' && Number.isInteger(id) && id > 0
  )))];
}

function restoreLegacyViewLater(): number[] {
  try {
    const raw = window.localStorage.getItem(VIEW_LATER_KEY);
    return normalizeViewLaterIds(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function forgetLegacyViewLater(): void {
  try {
    window.localStorage.removeItem(VIEW_LATER_KEY);
  } catch {
    // Storage unavailable — server state is still authoritative.
  }
}

/**
 * Shared library data. The initial browser-local Entry list is merged once so
 * an upgrade cannot silently discard saved items; afterwards both Entry and
 * Author lists use the SQLite-backed server state as their authority.
 */
export const viewLaterIds = ref<number[]>(restoreLegacyViewLater());
export const viewLaterAuthorIds = ref<number[]>([]);

let viewLaterQueue: Promise<unknown> = Promise.resolve();

function enqueueViewLater(operation: () => Promise<void>): Promise<void> {
  const result = viewLaterQueue.then(operation, operation);
  viewLaterQueue = result.then(() => undefined, () => undefined);
  return result;
}

function applyViewLaterState(state: ViewLaterState): void {
  viewLaterIds.value = normalizeViewLaterIds(state.entryIds);
  viewLaterAuthorIds.value = normalizeViewLaterIds(state.producerIds);
}

export function initializeViewLater(api: ViewLaterApi): Promise<void> {
  return enqueueViewLater(async () => {
    const legacyIds = restoreLegacyViewLater();
    applyViewLaterState(
      legacyIds.length > 0
        ? await api.mergeViewLaterEntries(legacyIds)
        : await api.getViewLaterState(),
    );
    forgetLegacyViewLater();
  });
}

export function refreshViewLater(api: ViewLaterApi): Promise<void> {
  return enqueueViewLater(async () => {
    applyViewLaterState(await api.getViewLaterState());
  });
}

export function toggleViewLater(api: ViewLaterApi, entryId: number): Promise<void> {
  return enqueueViewLater(async () => {
    applyViewLaterState(
      viewLaterIds.value.includes(entryId)
        ? await api.removeViewLaterEntry(entryId)
        : await api.addViewLaterEntry(entryId),
    );
  });
}

export function toggleAuthorViewLater(api: ViewLaterApi, authorId: number): Promise<void> {
  return enqueueViewLater(async () => {
    applyViewLaterState(
      viewLaterAuthorIds.value.includes(authorId)
        ? await api.removeViewLaterAuthor(authorId)
        : await api.addViewLaterAuthor(authorId),
    );
  });
}

export function addEntriesToViewLater(api: ViewLaterApi, entryIds: number[]): Promise<void> {
  const ids = normalizeViewLaterIds(entryIds);
  if (ids.length === 0) return Promise.resolve();
  return enqueueViewLater(async () => {
    applyViewLaterState(await api.mergeViewLaterEntries(ids));
  });
}

export function removeEntryFromViewLater(api: ViewLaterApi, entryId: number): Promise<void> {
  return enqueueViewLater(async () => {
    applyViewLaterState(await api.removeViewLaterEntry(entryId));
  });
}

export function removeAuthorFromViewLater(api: ViewLaterApi, authorId: number): Promise<void> {
  return enqueueViewLater(async () => {
    applyViewLaterState(await api.removeViewLaterAuthor(authorId));
  });
}

const ROWS_KEY = 't3.rows-per-page';
export const rowsPerPageOptions = [3, 5, 8] as const;

function restoreRowsPerPage(): number {
  try {
    const parsed = Number(window.localStorage.getItem(ROWS_KEY));
    return (rowsPerPageOptions as readonly number[]).includes(parsed) ? parsed : 5;
  } catch {
    return 5;
  }
}

/**
 * Card-grid pagination density (homepage/UI unification): a page shows at
 * most rowsPerPage rows of cards. Pure display preference, local storage
 * only; the page size itself is rows × the grid's real column count.
 */
export const rowsPerPage = ref<number>(restoreRowsPerPage());

watch(rowsPerPage, (value) => {
  try {
    window.localStorage.setItem(ROWS_KEY, String(value));
  } catch {
    // Storage unavailable — the preference just won't survive a reload.
  }
});

// ---------------------------------------------------------------------------
// Accent color. The unified theming interface: every component reads the
// --accent / --accent-hover variables from theme.css, and the whole app
// follows the data-accent attribute on the app root. Pure display preference,
// stored locally like the rest.
// ---------------------------------------------------------------------------
export type AccentId = 'blue' | 'teal' | 'violet' | 'rose' | 'amber' | 'green';

export const accentPresets: readonly AccentId[] = ['blue', 'teal', 'violet', 'rose', 'amber', 'green'];

/** Swatch preview colors (light-theme values) for the settings buttons. */
export const accentSwatchColors: Record<AccentId, string> = {
  blue: '#5361d5',
  teal: '#0f766e',
  violet: '#7c3aed',
  rose: '#be123c',
  amber: '#b45309',
  green: '#15803d',
};

const ACCENT_STORAGE_KEY = 't3.accent';

function restoreAccent(): AccentId {
  try {
    const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return accentPresets.includes(stored as AccentId) ? (stored as AccentId) : 'blue';
  } catch {
    return 'blue';
  }
}

export const accent = ref<AccentId>(restoreAccent());

watch(accent, (value) => {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, value);
  } catch {
    // Storage unavailable — the preference just won't survive a reload.
  }
});
