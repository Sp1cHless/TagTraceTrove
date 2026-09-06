import { ref, watch } from 'vue';

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

function restoreViewLater(): number[] {
  try {
    const raw = window.localStorage.getItem(VIEW_LATER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * "View later" is a pure UI-layer classification (never in the database, so
 * it cannot conflict with any domain logic): an Entry id list in local
 * storage, shown under its own sidebar gallery like Recently viewed.
 */
export const viewLaterIds = ref<number[]>(restoreViewLater());

watch(viewLaterIds, (value) => {
  try {
    window.localStorage.setItem(VIEW_LATER_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — the list just won't survive a reload.
  }
}, { deep: true });

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

export function toggleViewLater(entryId: number): void {
  viewLaterIds.value = viewLaterIds.value.includes(entryId)
    ? viewLaterIds.value.filter((id) => id !== entryId)
    : [...viewLaterIds.value, entryId];
}

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
