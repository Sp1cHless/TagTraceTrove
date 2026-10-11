<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { DEFAULT_CONTENT_KINDS, multiAuthorProducerName } from '@t3/shared';
import type { GalleryApi, GalleryAuthorSummary, GalleryEntrySummary } from './api/gallery.js';
import {
  type AuthorDetailResponse,
  CreateProducerRequest,
  EntryDetailResponse,
  FacetFilterOptions,
  GallerySummary,
  RatingRow,
  CollectionRecordDto,
  SearchScope,
  TagSearchHit,
  type SyncCapabilities,
  type SyncReplayOperation,
  type EntryTagAssignment,
} from '@t3/shared';
import AddAuthorPage from './AddAuthorPage.vue';
import EntryStatsRow from './components/EntryStatsRow.vue';
import AddEntryPage, { type ManualEntryDraft } from './AddEntryPage.vue';
import SecurePairingSettings from './components/SecurePairingSettings.vue';
import AdvancedEditingPage from './AdvancedEditingPage.vue';
import AuthorPage from './AuthorPage.vue';
import RecentViewPage from './RecentViewPage.vue';
import ViewLaterPage from './ViewLaterPage.vue';
import {
  collectionOptionsForGallery,
  flattenCollectionOptions,
  type CollectionMenuOption,
} from './collection-tree.js';
import CollectionsPage from './CollectionsPage.vue';
import HomePage from './HomePage.vue';
import RandomPage from './RandomPage.vue';
import {
  addEntriesToViewLater,
  initializeViewLater,
  refreshViewLater,
  toggleViewLater,
  viewLaterAuthorIds,
  viewLaterIds,
} from './stores/preferences.js';
import SearchPage from './SearchPage.vue';
import { entryCardMediaRef, entryStackLayerStyle, entryStackLayers } from './entry-media-stack.js';
import { touchOnlyDevice } from './touch.js';
import { accent, accentPresets, accentSwatchColors, rowsPerPage, rowsPerPageOptions, showNsfw } from './stores/preferences.js';
import type { NavigationCounts } from '@t3/shared';
import { useArmableAction } from './armable.js';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import SuggestionInput from './components/SuggestionInput.vue';
import AppIcon from './components/AppIcon.vue';
import IconButton from './components/IconButton.vue';
import LazyCardImage from './components/LazyCardImage.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import { supportedLocales, useI18n, type Locale } from './i18n.js';
import { createMemorySnapshotStore, type SnapshotStore } from './offline/snapshot-store.js';
import type { OfflineApiState } from './offline/offline-api.js';
import { isOfflineTransportError } from './api/transport-error.js';
import { randomUuid } from './offline/random-id.js';

import { createNavigationMemory, navigationMemoryKey } from './navigation-memory.js';

type Theme = 'light' | 'dark';
interface AuthorLocation {
  authorId: number;
  authorName: string;
  directoryId: number | null;
  directoryName: string | null;
}
interface EntryTagResults {
  kind: 'entry';
  tagId: number;
  tagName: string;
  entries: GalleryEntrySummary[];
  total: number;
  page: number;
  pageSize: number;
  sourceEntry: { id: number; type: string; title: string } | null;
  sourceSearchQuery: string | null;
  sourceSearchScope: SearchScope | null;
}
interface AuthorTagResults {
  kind: 'author';
  tagId: number;
  tagName: string;
  authors: Array<{ id: number; name: string }>;
  total: number;
  page: number;
  pageSize: number;
  sourceAuthor: AuthorLocation;
}
type TagResults = EntryTagResults | AuthorTagResults;
type SearchOrigin = { searchQuery: string; searchScope: SearchScope };
type EntryOrigin = AuthorLocation | { tagResults: EntryTagResults } | SearchOrigin;
type CreationView = 'entry' | 'author';
const props = defineProps<{
  api: GalleryApi;
  offlineStore?: SnapshotStore;
  offlineState?: OfflineApiState;
  startupReady?: Promise<unknown>;
}>();
// main.ts always supplies IndexedDB. The in-memory fallback keeps component
// fixtures and embedders deterministic without touching browser storage.
const offlineStore = props.offlineStore ?? createMemorySnapshotStore();
const offlineDiagnosticsOpen = ref(false);
const offlineDiagnosticsText = ref('');
const DIAGNOSTIC_BUILD = '0.0.47-c3-icons-and-boot';
// Milliseconds since WebView navigation, retained across later reconnects.
const startupMilestones: { snapshotReadyAtMs: number | null; galleriesReadyAtMs: number | null } = {
  snapshotReadyAtMs: null,
  galleriesReadyAtMs: null,
};
// An unpaired shell (failed or cancelled first pairing) answers every API call
// with a rejection, so the app would render as a dead, empty surface with no
// way back to the scan prompt. Probe the shell once; an unpaired shell gets an
// explicit, always-available pairing screen instead of that dead end.
const nativePairingBridge = (window as unknown as {
  Capacitor?: { nativePromise?: (plugin: string, method: string, args: Record<string, unknown>) => Promise<unknown> };
}).Capacitor;
const nativePairingRequired = ref(false);
onMounted(async () => {
  if (nativePairingBridge?.nativePromise === undefined
    || document.querySelector('meta[name="t3-native-shell"]') === null) return;
  try {
    const status = await nativePairingBridge.nativePromise('T3PairedTransport', 'status', {}) as { paired?: boolean };
    nativePairingRequired.value = status.paired !== true;
  } catch {
    // Unreadable pairing storage is exactly the re-pair situation.
    nativePairingRequired.value = true;
  }
});
function openNativePairing(): void {
  void nativePairingBridge?.nativePromise?.('T3PairedTransport', 'pair', {});
}

async function refreshOfflineDiagnostics(): Promise<void> {
  const list = (offlineStore as SnapshotStore & {
    list?: () => Promise<Array<{ operationKind: string; status: string }>>;
  }).list;
  const readMeta = async (key: string): Promise<string | null> => {
    try {
      return await offlineStore.readMeta(key);
    } catch (cause) {
      return `read-error:${cause instanceof Error ? cause.message : String(cause)}`;
    }
  };
  let operations: Array<{ operationKind: string; status: string }> | string = 'outbox-unavailable';
  if (typeof list === 'function') {
    try {
      operations = await list.call(offlineStore);
    } catch (cause) {
      operations = `read-error:${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  offlineDiagnosticsText.value = JSON.stringify({
    diagnosticBuild: DIAGNOSTIC_BUILD,
    capturedAt: new Date().toISOString(),
    mode: props.offlineState?.mode ?? null,
    connectionPhase: props.offlineState?.connectionPhase ?? null,
    lastLocalLoadMs: props.offlineState?.lastLocalLoadMs ?? null,
    startupMilestones,
    lastFallbackAt: props.offlineState?.lastFallbackAt ?? null,
    pendingCount: props.offlineState?.pendingCount ?? null,
    conflictCount: props.offlineState?.conflictCount ?? null,
    failedCount: props.offlineState?.failedCount ?? null,
    lastReplayError: props.offlineState?.lastReplayError ?? null,
    lastCapabilityProbe: props.offlineState?.lastCapabilityProbe ?? null,
    lastSuccessfulCapabilityProbe: props.offlineState?.lastSuccessfulCapabilityProbe ?? null,
    lastMutationDiagnostic: props.offlineState?.lastMutationDiagnostic ?? null,
    mutationDiagnostics: props.offlineState?.mutationDiagnostics ?? [],
    metadata: {
      activeGeneration: await readMeta('activeGeneration'),
      offlineMutations: await readMeta('capability.offlineMutations'),
      offlineEntryUpdate: await readMeta('capability.offlineEntryUpdate'),
      completeSnapshotDelta: await readMeta('capability.completeSnapshotDelta'),
      offlineMediaUpload: await readMeta('capability.offlineMediaUpload'),
      offlineMediaMultiplePreviews: await readMeta('capability.offlineMediaMultiplePreviews'),
      existingEntryMedia: await readMeta('capability.existingEntryMedia'),
      offlineEntryCreate: await readMeta('capability.offlineEntryCreate'),
      offlineUsageEvents: await readMeta('capability.offlineUsageEvents'),
      offlineEntryViewLater: await readMeta('capability.offlineEntryViewLater'),
      offlineEntryRating: await readMeta('capability.offlineEntryRating'),
      offlineEntryAuthors: await readMeta('capability.offlineEntryAuthors'),
      offlineAuthorCreate: await readMeta('capability.offlineAuthorCreate'),
      offlineEntryTags: await readMeta('capability.offlineEntryTags'),
      offlineEntryFacetCreate: await readMeta('capability.offlineEntryFacetCreate'),
      offlineEntryTagVocabulary: await readMeta('capability.offlineEntryTagVocabulary'),
      offlinePendingEntryTagCreation: await readMeta('capability.offlinePendingEntryTagCreation'),
      offlinePendingEntryTags: await readMeta('capability.offlinePendingEntryTags'),
      offlinePendingEntryAuthors: await readMeta('capability.offlinePendingEntryAuthors'),
      offlinePendingEntryMetadata: await readMeta('capability.offlinePendingEntryMetadata'),
      offlinePendingEntryContents: await readMeta('capability.offlinePendingEntryContents'),
      offlinePendingEntryAuthorCreate: await readMeta('capability.offlinePendingEntryAuthorCreate'),
      offlineCrossEntryPendingAuthors: await readMeta('capability.offlineCrossEntryPendingAuthors'),
      offlineEntryContents: await readMeta('capability.offlineEntryContents'),
      offlineProducerViewLater: await readMeta('capability.offlineProducerViewLater'),
      offlineProducerRating: await readMeta('capability.offlineProducerRating'),
      offlineProducerProfile: await readMeta('capability.offlineProducerProfile'),
      offlineProducerTags: await readMeta('capability.offlineProducerTags'),
      offlineRatingSlotLayout: await readMeta('capability.offlineRatingSlotLayout'),
      offlineCollectionProducerMembership: await readMeta('capability.offlineCollectionProducerMembership'),
      offlineCollectionManagement: await readMeta('capability.offlineCollectionManagement'),
      offlineAuthorDirectories: await readMeta('capability.offlineAuthorDirectories'),
    },
    outbox: Array.isArray(operations)
      ? operations.map((operation) => ({ kind: operation.operationKind, status: operation.status }))
      : operations,
    userAgent: navigator.userAgent,
  }, null, 2);
}

async function toggleOfflineDiagnostics(): Promise<void> {
  offlineDiagnosticsOpen.value = !offlineDiagnosticsOpen.value;
  if (offlineDiagnosticsOpen.value) await refreshOfflineDiagnostics();
}

async function copyOfflineDiagnostics(): Promise<void> {
  await refreshOfflineDiagnostics();
  await navigator.clipboard.writeText(offlineDiagnosticsText.value);
}

const navigationMemory = createNavigationMemory();
provide(navigationMemoryKey, navigationMemory);
const galleries = ref<GallerySummary[]>([]);
const authors = ref<Array<{
  id: number;
  name: string;
  covers: string[];
  galleryType: string | null;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
  nsfw: boolean;
}>>([]);
const entries = ref<GalleryEntrySummary[]>([]);
// Facet filter state: options are aggregated per gallery type on the server;
// the active filters live here so switching galleries can reset them and bar
// updates reload the visible entries. Tag rows AND inside and across rows;
// the Author list ORs inside itself and ANDs with the tag rows.
const facetFilterOptions = ref<FacetFilterOptions | null>(null);
const facetFilters = ref<GalleryFacetFilters>({
  conditions: [],
  authorIds: [],
  ratingConditions: [],
  ratingSort: null,
  usageConditions: [],
  usageSort: null,
});
let galleryEntriesRequestSeq = 0;
type GallerySort = 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' | 'random';
// Newest first by default: recent imports land at the top of the gallery.
const gallerySort = ref<GallerySort>('date-desc');
const galleryRandomSeed = ref(Math.floor(Math.random() * 2_147_483_648));
const galleryPage = ref(1);
const galleryPageSize = ref(30);
const galleryResultTotal = ref(0);
const showUsageOnCards = computed(() => (
  facetFilters.value.usageConditions.length > 0 || facetFilters.value.usageSort !== null
));

const galleryFilterActive = computed(() => {
  const { conditions, authorIds, ratingConditions, ratingSort, usageConditions, usageSort } = facetFilters.value;
  return conditions.some((condition) => condition.tagIds.length > 0)
    || authorIds.length > 0
    || ratingConditions.length > 0
    || ratingSort !== null
    || usageConditions.length > 0
    || usageSort !== null;
});
// The unfiltered size of the current Gallery, from the sidebar projection —
// the heading shows "filtered / total" while a filter is active.
const galleryTotalCount = computed(() => (
  galleries.value.find((gallery) => gallery.type === activeType.value)?.entryCount
  ?? entries.value.length
));

// Tag results page both kinds through one paged grid; the slot separates
// them again by shape (entries carry `type`, author hits do not).
const pagedTagItems = computed<Array<GalleryEntrySummary | { id: number; name: string }>>(() => {
  const results = tagResults.value;
  if (!results) return [];
  if (results.kind === 'entry') {
    return results.entries.filter((entry) => showNsfw.value || !entryNsfwTypes.value.has(entry.type));
  }
  return results.authors;
});

async function queryEntryTagResults(
  context: Omit<EntryTagResults, 'entries' | 'total' | 'page' | 'pageSize'>,
  page = navigationMemory.pages.get(`tag:entry:${context.tagId}`) ?? 1,
  pageSize = 30,
): Promise<EntryTagResults> {
  const result = await props.api.queryEntryPage({
    conditions: [],
    authorIds: [],
    ratingConditions: [],
    ratingSort: null,
    usageConditions: [],
    usageSort: null,
    includeTagIds: [context.tagId],
    excludeEntryTypes: showNsfw.value ? [] : [...entryNsfwTypes.value],
    sort: 'date-desc',
    page,
    pageSize,
  });
  return { ...context, entries: result.items, total: result.total, page, pageSize };
}

async function queryAuthorTagResults(
  context: Omit<AuthorTagResults, 'authors' | 'total' | 'page' | 'pageSize'>,
  page = navigationMemory.pages.get(`tag:author:${context.tagId}`) ?? 1,
  pageSize = 30,
): Promise<AuthorTagResults> {
  const result = await props.api.queryProducerPage({
    ownTagIds: [context.tagId],
    relatedEntryTagIds: [],
    includeNsfw: showNsfw.value,
    sort: 'name-asc',
    page,
    pageSize,
  });
  return { ...context, authors: result.items, total: result.total, page, pageSize };
}

async function changeEntryTagPage(page: number): Promise<void> {
  const current = tagResults.value;
  if (!current) return;
  tagResults.value = current.kind === 'entry'
    ? await queryEntryTagResults(current, page, current.pageSize)
    : await queryAuthorTagResults(current, page, current.pageSize);
}

async function changeEntryTagPageSize(pageSize: number): Promise<void> {
  const current = tagResults.value;
  if (!current || current.pageSize === pageSize) return;
  tagResults.value = current.kind === 'entry'
    ? await queryEntryTagResults(current, 1, pageSize)
    : await queryAuthorTagResults(current, 1, pageSize);
}

const sortedEntries = computed(() => {
  return [...entries.value];
});
const activeEntry = ref<EntryDetailResponse | null>(null);
const activeType = ref<string | null>(null);
const editingEntry = ref(false);
const entryTitleEditorOpen = ref(false);
const entryTitleDraft = ref('');
const entryTitleSaving = ref(false);
const entryTitleInput = ref<HTMLInputElement | null>(null);
const creationView = ref<CreationView | null>(null);
const sectionName = ref('');
const facetName = ref('');
const entryFacetSaving = ref(false);
const draggedTagId = ref<number | null>(null);
const selectedTagId = ref<number | null>(null);
const selectedTagFacetId = ref<number | null>(null);
const sectionEditorOpen = ref(false);
const facetEditorSectionId = ref<number | null>(null);
const tagEditorFacetId = ref<number | null>(null);
const entryTagSaving = ref(false);
// Relation autocomplete: eligibility, ordering and already-bound exclusions
// are server responsibilities; the editor submits canonical names (select) or
// the typed text (create) and never auto-submits on blur.
const entryTagExcludeIds = computed(() => (
  (activeEntry.value?.sections ?? [])
    .flatMap((section) => section.facets)
    .flatMap((facet) => facet.tags.map((tag) => tag.id))
));

function suggestEntryTags(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestTags({
    vocabulary: 'entry',
    q: query,
    excludeIds,
    entryType: activeEntry.value?.type ?? undefined,
    facetId: tagEditorFacetId.value ?? undefined,
    // Isolation follows the WORK's Gallery, not the browser-wide switch: a work
    // in an SFW Gallery may only be indexed by Tags the SFW side can show, even
    // while NSFW Galleries are visible elsewhere.
    includeNsfw: entryNsfwTypes.value.has(activeEntry.value?.type ?? '') ? 'true' : 'false',
  }, signal);
}

const linkedAuthorIds = computed(() => (
  (activeEntry.value?.producers ?? []).map((producer) => producer.id)
));

function suggestAuthors(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestProducers({ q: query, excludeIds }, signal);
}

const editingTagId = ref<number | null>(null);
/** The Section being renamed in place, and the text in its input. */
/** A work's date may be a year, a year and month, or a full date — and nothing else. */
const DATE_PREFIX_PATTERN = /^\d{4}(-\d{2})?(-\d{2})?$/u;
/**
 * Which interactions are available here. A pointer drags a Tag; a touch screen has to select it and
 * then say where it goes. Telling either one the other's gesture is a hint that cannot be followed,
 * so the hint follows this instead.
 */
const touchOnly = ref(false);
const editingSectionId = ref<number | null>(null);
const editingSectionName = ref('');
const editingTagName = ref('');
const contentEditorOpen = ref(false);
const contentType = ref('');
const contentBody = ref('');
const ratingEditorOpen = ref(false);
const ratingName = ref('');
const editingContentId = ref<number | null>(null);
const editingContentType = ref('');
const editingContentBody = ref('');
const loading = ref(true);
const submitting = ref(false);
const error = ref<string | null>(null);
const theme = ref<Theme>('light');
// Destructive/heavy actions arm in place on the first click (the button
// switches to its confirm copy) and run on the second — no native dialogs.
const { armedKey, arm, disarm } = useArmableAction();
const settingsOpen = ref(false);
const settingsPanelRoot = ref<HTMLElement | null>(null);
/**
 * On a phone the Settings panel is a sheet over the page's own card, and it must
 * sit in exactly that card's box — the same left, right and top, so the width
 * always matches whatever the layout does. Repeating the card's inset
 * expressions left the panel a few pixels narrower and shifted, with a sliver of
 * the card showing along its right edge. Measured from the card instead. The
 * bottom is deliberately free: the card behind may be shorter or taller.
 */
const settingsPanelStyle = ref<Record<string, string>>({});
// The same boundary as the phone layout's `max-width: 44rem`, derived from the
// root font size so it cannot drift from the stylesheet.
function settingsSheetApplies(): boolean {
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const breakpoint = 44 * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
  return globalThis.innerWidth <= breakpoint;
}
function measureSettingsPanelBox(correct = false): void {
  const panel = settingsPanelRoot.value;
  if (!settingsOpen.value || !settingsSheetApplies() || panel === null) {
    settingsPanelStyle.value = {};
    return;
  }
  // Resolved inside the app's own tree, not the document: the sheet and the card
  // are siblings there, and a detached tree (tests) has no document to search.
  const card = panel.closest('.gallery-app')?.querySelector<HTMLElement>('.content-panel') ?? null;
  if (card === null) {
    settingsPanelStyle.value = {};
    return;
  }
  const rect = card.getBoundingClientRect();
  if (correct) {
    // The sheet's `position: fixed` is resolved against the header — an ancestor
    // with a `backdrop-filter` becomes the containing block — so viewport
    // coordinates land off by that ancestor's own origin (measured: 8px on both
    // axes). Correct by what actually rendered; one pass converges and it holds
    // whatever the layout does.
    const rendered = panel.getBoundingClientRect();
    const askedLeft = Number.parseFloat(settingsPanelStyle.value.left ?? '0');
    const askedTop = Number.parseFloat(settingsPanelStyle.value.top ?? '0');
    settingsPanelStyle.value = {
      ...settingsPanelStyle.value,
      left: `${Math.round(askedLeft + (rect.left - rendered.left))}px`,
      top: `${Math.round(askedTop + (rect.top - rendered.top))}px`,
    };
    return;
  }
  settingsPanelStyle.value = {
    left: `${Math.round(rect.left)}px`,
    right: 'auto',
    width: `${Math.round(rect.width)}px`,
    top: `${Math.round(rect.top)}px`,
    maxHeight: `${Math.max(160, Math.round(globalThis.innerHeight - rect.top - 12))}px`,
  };
  globalThis.requestAnimationFrame(() => { measureSettingsPanelBox(true); });
}
function onSettingsViewportChange(): void {
  if (settingsOpen.value) measureSettingsPanelBox();
}
watch(settingsOpen, (open) => {
  // The `then` callback would receive the resolved value as its first argument,
  // which is the "correct the rendered offset" flag here.
  if (open) void nextTick().then(() => { measureSettingsPanelBox(); });
  else settingsPanelStyle.value = {};
});
onMounted(() => {
  globalThis.addEventListener('resize', onSettingsViewportChange);
  globalThis.visualViewport?.addEventListener('resize', onSettingsViewportChange);
});
onUnmounted(() => {
  globalThis.removeEventListener('resize', onSettingsViewportChange);
  globalThis.visualViewport?.removeEventListener('resize', onSettingsViewportChange);
});
const mobileNavigationOpen = ref(false);
const MOBILE_NAVIGATION_HISTORY_KEY = 't3MobileNavigation';
let mobileNavigationHistoryArmed = false;
const advancedView = ref(false);
const authorView = ref(false);
const recentView = ref(false);
const recentViewTab = ref('');
const viewLaterView = ref(false);
const viewLaterKind = ref<'entry' | 'author'>('entry');
const viewLaterTab = ref('');
const collectionsView = ref(false);
const randomView = ref(false);
const homePageRef = ref<{ reload: () => Promise<void> } | null>(null);

const authorPageRef = ref<{
  goBack: () => void | Promise<void>;
  waitUntilReady: () => Promise<void>;
} | null>(null);
const collectionsPageRef = ref<{ goBack: () => void | Promise<void> } | null>(null);
const returnScrollPositions: number[] = [];
let scrollRestoreGeneration = 0;

function rememberReturnScroll(): void {
  returnScrollPositions.push(Math.max(0, window.scrollY));
}

function discardReturnScroll(): void {
  returnScrollPositions.pop();
}

async function scrollCurrentViewToTop(): Promise<void> {
  scrollRestoreGeneration += 1;
  await nextTick();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
}

async function restorePreviousScroll(): Promise<void> {
  const top = returnScrollPositions.pop() ?? 0;
  const generation = ++scrollRestoreGeneration;
  await nextTick();
  let attempts = 0;
  const apply = (): void => {
    if (generation !== scrollRestoreGeneration) return;
    window.scrollTo({ top, left: 0, behavior: 'auto' });
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const hasLayout = document.documentElement.getBoundingClientRect().height > 0;
    const maxScroll = Math.max(0, pageHeight - window.innerHeight);
    // Async list pages briefly render a short loading state. Retry until their
    // cards are back so the browser cannot clamp the requested position to 0.
    // Non-layout DOMs such as jsdom report a zero document rectangle.
    if (hasLayout && pageHeight > 0 && maxScroll + 1 < top && attempts < 60) {
      attempts += 1;
      window.requestAnimationFrame(apply);
    }
  };
  apply();
}

// Add-to-collection menus on the detail pages.
const entryCollectionOptions = ref<CollectionMenuOption[]>([]);
const entryCollectionIds = ref<number[]>([]);
const entryCollectionMenuOpen = ref(false);
const entryCollectionRoot = ref<HTMLElement | null>(null);
// The trigger sits near an edge — the action row is top-right on a phone, the
// stat row bottom-left — so the menu is placed from the trigger's measured
// position: flipped up when there is no room below, and anchored to whichever
// side has room. The stylesheet used to assume a top-left trigger on phones,
// which pushed half the menu off the right edge (seen on the device). The
// numbers below mirror the menu's own CSS (min-width 12rem, 0.3rem offset).
const entryCollectionDropUp = ref(false);
const entryCollectionMenuStyle = ref<Record<string, string>>({});
const COLLECTION_MENU_MIN_WIDTH = 12 * 16;
const COLLECTION_MENU_GAP = 0.3 * 16;
const COLLECTION_MENU_VIEWPORT_MARGIN = 2.5 * 16;
function measureEntryCollectionPlacement(): void {
  const root = entryCollectionRoot.value;
  if (root === null) {
    entryCollectionDropUp.value = false;
    entryCollectionMenuStyle.value = {};
    return;
  }
  const rect = root.getBoundingClientRect();
  const viewport = globalThis.visualViewport;
  const viewportWidth = viewport === undefined || viewport === null
    ? globalThis.innerWidth
    : Math.min(globalThis.innerWidth, viewport.width + viewport.offsetLeft);
  const viewportBottom = viewport === undefined || viewport === null
    ? globalThis.innerHeight
    : Math.min(globalThis.innerHeight, viewport.height + viewport.offsetTop);
  entryCollectionDropUp.value = viewportBottom - rect.bottom < 15 * 16;
  const width = Math.min(
    COLLECTION_MENU_MIN_WIDTH,
    Math.max(0, viewportWidth - COLLECTION_MENU_VIEWPORT_MARGIN),
  );
  const roomLeft = rect.right - COLLECTION_MENU_GAP;
  const roomRight = viewportWidth - rect.left - COLLECTION_MENU_GAP;
  const anchorRight = roomLeft >= width || roomLeft >= roomRight;
  const maxWidth = Math.floor(Math.max(0, Math.min(width, anchorRight ? roomLeft : roomRight)));
  entryCollectionMenuStyle.value = anchorRight
    ? { left: 'auto', right: '0', maxWidth: `${maxWidth}px` }
    : { left: '0', right: 'auto', maxWidth: `${maxWidth}px` };
}
watch(entryCollectionMenuOpen, (open) => { if (open) measureEntryCollectionPlacement(); });
function onDocumentPointerDownForEntryCollection(event: PointerEvent): void {
  if (!entryCollectionMenuOpen.value) return;
  const root = entryCollectionRoot.value;
  if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
  entryCollectionMenuOpen.value = false;
}
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDownForEntryCollection));
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDownForEntryCollection));
const searchView = ref(false);
const searchQuery = ref('');
const searchScope = ref<SearchScope>('entries');
/**
 * The sidebar's exchange mode: the gallery list can be moved up and down.
 *
 * A Gallery is a projection of `entries.type`, so it had no order of its own and the list fell back to
 * the alphabet — measured on a real library with seven galleries, the two used every day sat wherever
 * their spelling put them. While this is on, each row carries the same pair of arrows the Collections
 * page moves folders with, and the button itself takes the "applied" look the view-later switches use.
 */
const galleryOrdering = ref(false);

/** Where a Gallery sits in the list the *server* will be given: the whole list, hidden ones included. */
function galleryIndex(type: string): number {
  return galleries.value.findIndex((gallery) => gallery.type === type);
}

function canMoveGallery(type: string, delta: -1 | 1): boolean {
  const index = visibleGalleries.value.findIndex((gallery) => gallery.type === type);
  return index >= 0 && index + delta >= 0 && index + delta < visibleGalleries.value.length;
}

/**
 * Move one Gallery past its neighbour, then store the whole list.
 *
 * The move happens locally first so the row follows the finger, and the order is written afterwards;
 * a write that fails puts the list back and says why, rather than leaving the sidebar showing an
 * order the library does not have.
 */
async function moveGallery(type: string, delta: -1 | 1): Promise<void> {
  if (!canMoveGallery(type, delta)) return;
  const visibleIndex = visibleGalleries.value.findIndex((gallery) => gallery.type === type);
  const neighbour = visibleGalleries.value[visibleIndex + delta]!;
  const index = galleryIndex(type);
  const target = galleryIndex(neighbour.type);
  if (index < 0 || target < 0) return;
  const before = galleries.value;
  const next = [...before];
  [next[index], next[target]] = [next[target]!, next[index]!];
  galleries.value = next;
  try {
    await props.api.setGalleryOrder(next.map((gallery) => gallery.type));
    error.value = null;
  } catch (cause) {
    galleries.value = before;
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Whether the sidebar has anything to navigate.
 *
 * An empty library shows the invitation instead of a list of dead ends — which is what the sidebar
 * did before the shortcuts moved into their own pinned block, and this keeps that.
 */
const sidebarHasNavigation = computed(() => (
  !loading.value && (galleries.value.length > 0 || authors.value.length > 0)
));

const authorSearchOrigin = ref<SearchOrigin | null>(null);

// Whole-gallery partitions are stored server-side; the show-NSFW switch is a
// local display preference. Everything NSFW hides while it is off.
const entryNsfwTypes = computed(() => (
  new Set(galleries.value.filter((gallery) => gallery.nsfw).map((gallery) => gallery.type))
));

const visibleGalleries = computed(() => (
  galleries.value.filter((gallery) => showNsfw.value || !gallery.nsfw)
));

async function toggleGalleryPartition(gallery: { type: string; nsfw: boolean }): Promise<void> {
  error.value = null;
  try {
    await props.api.setGalleryPartition(gallery.type, !gallery.nsfw);
    await refreshGalleries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntry');
  }
}
const authorEditorOpen = ref(false);
const newAuthorName = ref('');
const authorLinkEditorOpen = ref(false);
// Best-effort duplicate warning while typing a new Author name; the actual
// create-and-link action stays independent and authoritative.
const authorDuplicateNames = ref<string[]>([]);
let authorDuplicateTimer: ReturnType<typeof setTimeout> | null = null;
const authorTarget = ref<AuthorLocation | null>(null);
const authorReturnScrollPositions = ref<number[]>([]);
const authorRestoreInitialScroll = ref(false);
const entryOrigin = ref<EntryOrigin | null>(null);
const tagResults = ref<TagResults | null>(null);
const authorTagOrigin = ref<AuthorTagResults | null>(null);
const nextTheme = computed<Theme>(() => (theme.value === 'light' ? 'dark' : 'light'));

function syncBrowserCanvasTheme(): void {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.dataset.accent = accent.value;
  document.documentElement.style.backgroundColor = 'var(--page-background)';
  document.body.style.backgroundColor = 'var(--page-background)';
}

watch([theme, accent], syncBrowserCanvasTheme, { immediate: true });
// Home is the fallback view: nothing else active and no Gallery/Entry open.
const isHomeView = computed(() => (
  !searchView.value
  && !advancedView.value
  && creationView.value === null
  && tagResults.value === null
  && !recentView.value
  && !viewLaterView.value
  && !collectionsView.value
  && !randomView.value
  && batchReview.value === null
  && !authorView.value
  && activeEntry.value === null
  && activeType.value === null
));
const topBarBackEnabled = computed(() => !isHomeView.value || settingsOpen.value || mobileNavigationOpen.value);

function showHome(): void {
  leaveAllViews();
}

function navigateBackFromTopBar(): void {
  if (settingsOpen.value) {
    settingsOpen.value = false;
    return;
  }
  if (mobileNavigationOpen.value) {
    closeMobileNavigation();
    return;
  }
  if (activeEntry.value) {
    void closeEntry();
    return;
  }
  if (tagResults.value) {
    void closeTagResults();
    return;
  }
  if (authorView.value) {
    void authorPageRef.value?.goBack();
    return;
  }
  if (collectionsView.value) {
    void collectionsPageRef.value?.goBack();
    return;
  }
  if (searchView.value) {
    closeSearch();
    return;
  }
  if (advancedView.value) {
    closeAdvanced();
    return;
  }
  if (creationView.value === 'author') {
    showAuthors();
    return;
  }
  if (batchReview.value) {
    completeBatchReview();
    return;
  }
  if (!isHomeView.value) showHome();
}
const entryBackTarget = computed(() => {
  if (!entryOrigin.value) {
    if (returnView.value === 'recent') return t('recent.title');
    if (returnView.value === 'viewLater') return t('viewLater.title');
    if (returnView.value === 'random') return t('random.title');
    if (returnView.value === 'collections') return t('collections.title');
    if (returnView.value === 'batch') return t('import.batchReviewEyebrow');
    return activeType.value ?? t('home.nav');
  }
  if ('tagResults' in entryOrigin.value) return entryOrigin.value.tagResults.tagName;
  if ('searchQuery' in entryOrigin.value) return t('search.title');
  return entryOrigin.value.directoryName ?? entryOrigin.value.authorName;
});
const { locale, setLocale, t } = useI18n();

function selectLocale(event: Event): void {
  const nextLocale = (event.target as HTMLSelectElement).value as Locale;
  if (supportedLocales.includes(nextLocale)) setLocale(nextLocale);
}

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}

function openMobileNavigation(): void {
  if (mobileNavigationOpen.value) return;
  settingsOpen.value = false;
  mobileNavigationOpen.value = true;
  const currentState = window.history.state;
  const nextState = currentState && typeof currentState === 'object' ? { ...currentState } : {};
  window.history.pushState({ ...nextState, [MOBILE_NAVIGATION_HISTORY_KEY]: true }, '');
  mobileNavigationHistoryArmed = true;
}

function closeMobileNavigation(rewindHistory = true): void {
  if (!mobileNavigationOpen.value) return;
  mobileNavigationOpen.value = false;
  const ownsCurrentHistoryEntry = window.history.state?.[MOBILE_NAVIGATION_HISTORY_KEY] === true;
  if (rewindHistory && mobileNavigationHistoryArmed && ownsCurrentHistoryEntry) {
    mobileNavigationHistoryArmed = false;
    window.history.back();
    return;
  }
  mobileNavigationHistoryArmed = false;
}

function handlePopState(): void {
  if (mobileNavigationOpen.value) closeMobileNavigation(false);
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && mobileNavigationOpen.value) closeMobileNavigation();
}

watch(mobileNavigationOpen, (open) => {
  document.body.classList.toggle('t3-mobile-navigation-open', open);
});

// Every sidebar entry is top priority: switching views always tears down the
// current one first. returnView remembers where an Entry detail was opened
// from so the detail's back button returns to the right place.
type ReturnTarget = 'recent' | 'viewLater' | 'collections' | 'batch' | 'random';

const returnView = ref<ReturnTarget | null>(null);
const pendingBatchReview = ref<typeof batchReview.value>(null);

function leaveAllViews(keepEntry = false, preserveScrollHistory = false): void {
  if (!preserveScrollHistory) {
    returnScrollPositions.length = 0;
    scrollRestoreGeneration += 1;
    authorReturnScrollPositions.value = [];
    authorRestoreInitialScroll.value = false;
  }
  closeMobileNavigation();
  creationView.value = null;
  tagResults.value = null;
  authorTagOrigin.value = null;
  authorSearchOrigin.value = null;
  entryOrigin.value = null;
  searchView.value = false;
  recentView.value = false;
  viewLaterView.value = false;
  collectionsView.value = false;
  randomView.value = false;
  randomTagReturn = false;
  batchReview.value = null;
  authorView.value = false;
  advancedView.value = false;
  activeType.value = null;
  if (!keepEntry) activeEntry.value = null;
  editingEntry.value = false;
  authorTarget.value = null;
  returnView.value = null;
  resetLayoutEditors();
}

function openAdvanced(): void {
  settingsOpen.value = false;
  leaveAllViews();
  advancedView.value = true;
}

function closeAdvanced(): void {
  advancedView.value = false;
}

/**
 * The search door. It used to be a field in the sidebar; it is an icon now, and the field it opened
 * belongs to the Search page itself — where the results are, and where the query can be changed
 * without going back.
 */
function openSearch(): void {
  searchQuery.value = '';
  searchScope.value = 'entries';
  leaveAllViews();
  searchView.value = true;
}

function closeSearch(): void {
  searchView.value = false;
}

function preserveSearchContext(query: string, scope: SearchScope): SearchOrigin {
  const context = { searchQuery: query, searchScope: scope };
  searchQuery.value = query;
  searchScope.value = scope;
  return context;
}

async function openEntryFromSearch(
  entry: GalleryEntrySummary,
  query: string,
  scope: SearchScope,
): Promise<void> {
  rememberReturnScroll();
  const origin = preserveSearchContext(query, scope);
  searchView.value = false;
  creationView.value = null;
  tagResults.value = null;
  recentView.value = false;
  authorView.value = false;
  advancedView.value = false;
  activeType.value = entry.type;
  await viewEntry(entry.id, origin);
  if (activeEntry.value?.id !== entry.id) discardReturnScroll();
}

function openAuthorFromSearch(
  author: GalleryAuthorSummary,
  query: string,
  scope: SearchScope,
): void {
  rememberReturnScroll();
  authorRestoreInitialScroll.value = false;
  authorSearchOrigin.value = preserveSearchContext(query, scope);
  searchView.value = false;
  creationView.value = null;
  tagResults.value = null;
  recentView.value = false;
  advancedView.value = false;
  activeEntry.value = null;
  activeType.value = null;
  authorTarget.value = {
    authorId: author.id,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  authorView.value = true;
  void scrollCurrentViewToTop();
}

async function openTagFromSearch(
  tag: TagSearchHit,
  query: string,
  scope: SearchScope,
): Promise<void> {
  rememberReturnScroll();
  error.value = null;
  const origin = preserveSearchContext(query, scope);
  try {
    tagResults.value = await queryEntryTagResults({
      kind: 'entry',
      tagId: tag.tagId,
      tagName: tag.name,
      sourceEntry: null,
      sourceSearchQuery: origin.searchQuery,
      sourceSearchScope: origin.searchScope,
    });
    searchView.value = false;
    activeEntry.value = null;
    activeType.value = null;
    await scrollCurrentViewToTop();
  } catch (cause) {
    discardReturnScroll();
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

watch([showNsfw, entryNsfwTypes], () => {
  if (showNsfw.value) return;
  if (activeType.value && entryNsfwTypes.value.has(activeType.value)) {
    galleryEntriesRequestSeq += 1;
    activeType.value = null;
    entries.value = [];
    galleryResultTotal.value = 0;
    facetFilterOptions.value = null;
  }
  if (activeEntry.value && entryNsfwTypes.value.has(activeEntry.value.type)) {
    activeEntry.value = null;
    entryOrigin.value = null;
  }
});

watch(showNsfw, () => {
  void refreshNavigationCounts();
  if (tagResults.value) void changeEntryTagPage(1);
});

// Saving or removing an Entry/Author changes both lists the sidebar counts.
watch([viewLaterIds, viewLaterAuthorIds], () => {
  void refreshNavigationCounts();
});

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

function formatDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? isoTimestamp.slice(0, 10) : date.toISOString().slice(0, 10);
}

/**
 * A view is counted only when the user actually opens the source URL —
 * clicking the card itself never counts. Navigation opens immediately; usage
 * recording is a non-blocking best-effort side effect that may enqueue offline.
 */
function openSourceUrl(event: MouseEvent, url: string): void {
  event.preventDefault();
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  window.open(url, '_blank', 'noopener,noreferrer');
  void props.api.recordEntryView(entryId).then(applyUsage).catch(() => {
    // Recording is online-only best-effort; never delay or block navigation.
  });
}

async function likeActiveEntry(): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    applyUsage(await props.api.likeEntry(activeEntry.value.id));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.setRating');
  }
}

// Like is a repeatable action, not a toggle: bumping the key re-mounts the
// icon span so every click replays the short feedback animation.
const likeAnimationKey = ref(0);

function onLikeClick(): void {
  likeAnimationKey.value += 1;
  void likeActiveEntry();
}

const activeEntryInViewLater = computed(() => (
  activeEntry.value !== null && viewLaterIds.value.includes(activeEntry.value.id)
));

async function toggleEntryCollectionMenu(): Promise<void> {
  entryCollectionMenuOpen.value = !entryCollectionMenuOpen.value;
  if (entryCollectionMenuOpen.value && activeEntry.value) {
    try {
      const [collectionTree, memberIds] = await Promise.all([
        props.api.listCollections('entry'),
        props.api.listCollectionsForEntry(activeEntry.value.id),
      ]);
      entryCollectionOptions.value = flattenCollectionOptions(
        collectionOptionsForGallery(collectionTree, activeEntry.value.type, memberIds),
      );
      entryCollectionIds.value = memberIds;
    } catch {
      // Keep whatever options are cached; the menu still renders.
    }
  }
}

async function addEntryToCollection(collectionId: number): Promise<void> {
  if (!activeEntry.value) return;
  // Keep the menu open so several collections can be joined in a row; a tap
  // anywhere outside the menu closes it.
  error.value = null;
  try {
    await props.api.addCollectionEntry(collectionId, activeEntry.value.id);
    entryCollectionIds.value = [...entryCollectionIds.value, collectionId];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function removeEntryFromCollection(collectionId: number): Promise<void> {
  if (!activeEntry.value) return;
  // Keep the menu open so the ✓ clears in place and several collections can be left in a row.
  error.value = null;
  try {
    await props.api.removeCollectionEntry(collectionId, activeEntry.value.id);
    entryCollectionIds.value = entryCollectionIds.value.filter((id) => id !== collectionId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

function toggleEntryCollection(collection: CollectionMenuOption): void {
  if (entryCollectionIds.value.includes(collection.id)) {
    void removeEntryFromCollection(collection.id);
    return;
  }
  void addEntryToCollection(collection.id);
}

function applyUsage(usage: { viewCount: number; likeCount: number; lastViewedAt: string | null }): void {
  const entry = activeEntry.value;
  if (!entry) return;
  entry.usage = usage;
}

const mediaIndex = ref(0);
const mediaSlides = computed(() => {
  if (!activeEntry.value) return [] as string[];
  const slides: string[] = [];
  if (activeEntry.value.coverRef) slides.push(activeEntry.value.coverRef);
  slides.push(...(activeEntry.value.previewRefs ?? []));
  return [...new Set(slides)];
});
function mediaPrevious(): void {
  if (mediaIndex.value > 0) mediaIndex.value -= 1;
}
function mediaNext(): void {
  if (mediaIndex.value < mediaSlides.value.length - 1) mediaIndex.value += 1;
}
// The strip mode is a pointer affordance — a phone keeps the one-at-a-time
// viewer (and gets its own floating add control instead).
const mediaExpanded = ref(false);
const mediaViewerRoot = ref<HTMLElement | null>(null);
// The strip adopts the cover's own rendered height, so a mixed portrait set
// hangs off the first landscape image instead of the tallest one.
const mediaStripHeight = ref<number | null>(null);
const mediaAddInput = ref<HTMLInputElement | null>(null);
const mediaUploading = ref(false);
const mediaUploadError = ref<string | null>(null);
const desktopMedia = computed(() => !touchOnly.value);
const mediaAddAvailable = computed(() => editingEntry.value && mediaSlides.value.length < 4);
/**
 * The strip's height comes from the pictures themselves: the first one sets the
 * proportion (a face-on, same-size set lands exactly on the cover's own shape),
 * and the total width is what keeps the whole row inside the column — never a
 * clamp on a single image, which is what produced letterboxed white bars.
 */
const stripMaxHeight = 24 * 16;
// The height the cover already renders at in the single-image view; the strip
// keeps that size and only shrinks when the whole row would not fit.
const singleViewHeight = ref<number | null>(null);
function measureMediaStrip(): void {
  if (!mediaExpanded.value) return;
  const root = mediaViewerRoot.value;
  const strip = root?.querySelector<HTMLElement>('.entry-media-strip') ?? null;
  if (root === null || strip === null) return;
  // The strip is the boundary: its own box is the column it has to fit in.
  const images = [...strip.querySelectorAll<HTMLImageElement>('.entry-media-slide img')];
  if (images.length === 0) return;
  const gap = 8;
  const width = strip.clientWidth || root.clientWidth;
  const usable = width - gap * (images.length - 1);
  if (usable <= 0) return;
  const aspectOf = (image: HTMLImageElement): number | null => (
    image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : null
  );
  const first = images.map(aspectOf).find((aspect) => aspect !== null) ?? 1;
  const aspects = images.map((image) => aspectOf(image) ?? first);
  const sum = aspects.reduce((total, aspect) => total + aspect, 0);
  if (sum <= 0) return;
  // Two bounds, and the strip takes the smaller: the size the cover already has
  // on its own (so a face-on set looks exactly like the single view), and the
  // size at which the whole row still fits the column. Flooring keeps a
  // rounded pixel from painting past the column's edge.
  const coverSize = singleViewHeight.value ?? stripMaxHeight;
  const height = Math.floor(Math.min(coverSize, usable / sum, stripMaxHeight));
  mediaStripHeight.value = Math.max(64, height);
}
function currentStrip(): HTMLElement | null {
  return mediaViewerRoot.value?.querySelector<HTMLElement>('.entry-media-strip') ?? null;
}
// Watching the strip's own width is what keeps the row inside its column when
// anything else moves it — a side panel opening, the window resizing, the
// browser zooming. Height changes are our own doing and must not re-enter.
let stripObserver: ResizeObserver | null = null;
let observedStripWidth = 0;
function observeStrip(): void {
  const strip = currentStrip();
  if (strip === null || typeof ResizeObserver === 'undefined') return;
  stripObserver?.disconnect();
  observedStripWidth = strip.clientWidth;
  stripObserver = new ResizeObserver(() => {
    const width = currentStrip()?.clientWidth ?? 0;
    if (width === 0 || width === observedStripWidth) return;
    observedStripWidth = width;
    measureMediaStrip();
  });
  stripObserver.observe(strip);
}
function unobserveStrip(): void {
  stripObserver?.disconnect();
  stripObserver = null;
  observedStripWidth = 0;
}
/**
 * Re-runs the geometry for whatever the strip holds now, and again as the
 * pictures decode: a cached image can finish loading in the same tick its
 * element was created, so the load event alone is not a reliable signal, and a
 * measurement taken before the first decode has no aspect to work from.
 */
function syncMediaStrip(): void {
  measureMediaStrip();
  requestAnimationFrame(() => measureMediaStrip());
  globalThis.setTimeout(() => measureMediaStrip(), 150);
  globalThis.setTimeout(() => measureMediaStrip(), 400);
  const strip = currentStrip();
  for (const image of strip?.querySelectorAll('img') ?? []) {
    if (image.complete || image.dataset.stripObserved === '1') continue;
    image.dataset.stripObserved = '1';
    image.addEventListener('load', measureMediaStrip, { once: true });
  }
  observeStrip();
}
async function openMediaExpanded(): Promise<void> {
  // Read the cover's own rendered height before the layout switches.
  const single = mediaViewerRoot.value?.querySelector<HTMLImageElement>('img') ?? null;
  singleViewHeight.value = single !== null && single.clientHeight > 0 ? single.clientHeight : null;
  mediaExpanded.value = true;
  await nextTick();
  syncMediaStrip();
}
function closeMediaExpanded(): void {
  mediaExpanded.value = false;
  unobserveStrip();
}
// Media can change while the strip is open — adding, deleting, moving — and the
// geometry has to follow the list it now shows.
watch([mediaSlides, () => mediaExpanded.value], async () => {
  if (!mediaExpanded.value) { unobserveStrip(); return; }
  await nextTick();
  syncMediaStrip();
}, { flush: 'post' });
function requestMediaUpload(): void {
  if (!mediaAddAvailable.value || mediaUploading.value) return;
  mediaAddInput.value?.click();
}
// A connection failure that has healed must not keep its banner: when the
// connection state settles back online, stale connection-failure messages at
// the top of the page clear themselves (they used to need an app restart).
watch([() => props.offlineState?.mode, () => props.offlineState?.connectionPhase], ([mode, phase]) => {
  if (mode === 'online' && phase === null && error.value !== null) error.value = null;
});

// Media editing (delete / move) speaks one command: the whole list in its new
// order, the first ref being the cover.
const mediaEditMode = ref(false);
const mediaSaving = ref(false);
const mediaRemovalBlockReason=ref<string|null>(null);
let mediaPolicyGeneration=0;
watch([activeEntry,mediaEditMode],async([entry])=>{
  const generation=++mediaPolicyGeneration;
  if(!entry){mediaRemovalBlockReason.value=null;return;}
  if(entry.id<=0){mediaRemovalBlockReason.value=t('media.blockNoServerRow');return;}
  mediaRemovalBlockReason.value=props.api.getEntryMediaRemovalBlockReason ? t('media.blockChecking') : null;
  try {
    const reason=await props.api.getEntryMediaRemovalBlockReason?.(entry.id) ?? null;
    if(generation===mediaPolicyGeneration)mediaRemovalBlockReason.value=reason;
  }catch{if(generation===mediaPolicyGeneration)mediaRemovalBlockReason.value=t('media.blockUncertain');}
});
// Media keeps positional names, so an edited list hands the browser the SAME
// image URL for different bytes; a fresh element (keyed by this) is what makes
// it re-read them. The URL itself stays untouched, so the offline copy's cached
// pictures keep matching.
const mediaRevision = ref(0);
// Leaving the Entry's edit mode takes the picture editors with it: their X and
// move arrows are edit-mode controls, and leaving them on screen after the mode
// ended reads as a stuck page (reported after a slow save).
watch(editingEntry, (editing) => {
  if (!editing) {
    mediaEditMode.value = false;
    unobserveStrip();
  }
});
async function commitMediaOrder(refs: string[]): Promise<void> {
  const entry = activeEntry.value;
  if (entry === null || mediaSaving.value || mediaRemovalBlockReason.value) return;
  mediaSaving.value = true;
  mediaUploadError.value = null;
  try {
    await props.api.setEntryMediaOrder?.(entry.id, refs);
    mediaRevision.value += 1;
    await reloadActiveEntry();
  } catch (cause) {
    mediaUploadError.value = cause instanceof Error ? cause.message : t('media.editFailed');
  } finally {
    mediaSaving.value = false;
  }
}
function removeMediaAt(index: number): void {
  const refs = [...mediaSlides.value];
  if (index < 0 || index >= refs.length) return;
  refs.splice(index, 1);
  void commitMediaOrder(refs);
}
function swapMedia(index: number, delta: number): void {
  const refs = [...mediaSlides.value];
  const target = index + delta;
  if (target < 0 || target >= refs.length) return;
  [refs[index], refs[target]] = [refs[target]!, refs[index]!];
  void commitMediaOrder(refs);
}
async function chooseMediaUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = '';
  const entry = activeEntry.value;
  if (file === null || entry === null) return;
  mediaUploading.value = true;
  mediaUploadError.value = null;
  try {
    // An absent cover takes the new image as the cover; otherwise it appends as
    // the next preview. Both ride the same upload the composer and Quick import
    // already use, offline queue included.
    await props.api.uploadEntryMedia(entry.id, entry.coverRef === null ? 'cover' : 'preview', file);
    mediaRevision.value += 1;
    await reloadActiveEntry();
  } catch (cause) {
    mediaUploadError.value = cause instanceof Error ? cause.message : t('media.addFailed');
  } finally {
    mediaUploading.value = false;
  }
}
async function reloadActiveEntry(): Promise<void> {
  if (activeEntry.value) await openEntry(activeEntry.value.id);
}

/**
 * Deleting a rating dimension, in two steps.
 *
 * The dimension is shared by the whole Gallery — every Entry of the type loses the row, its values
 * go with it — so a dialog asks before anything is sent. (An inline "armed" button is what this page
 * uses for deletes whose blast radius is the card on screen.)
 */
const deleteRatingTarget = ref<{ slotId: number; name: string } | null>(null);

function beginRatingDelete(slotId: number, name: string): void {
  if (!editingEntry.value) return;
  deleteRatingTarget.value = { slotId, name };
}

async function confirmRatingDelete(): Promise<void> {
  const entry = activeEntry.value;
  const target = deleteRatingTarget.value;
  if (!entry || target === null) return;
  try {
    await props.api.deleteEntryRatingSlot(entry.id, target.slotId);
    deleteRatingTarget.value = null;
    // Invalidate the type's backing Gallery before refresh: a late old query
    // must not reinstall deleted-dimension values or counts.
    if (activeType.value === entry.type) {
      galleryEntriesRequestSeq += 1;
      entries.value = [];
      galleryResultTotal.value = 0;
      facetFilters.value = {
        ...facetFilters.value,
        ratingConditions: facetFilters.value.ratingConditions.filter(row => row.slotId !== target.slotId),
        ratingSort: facetFilters.value.ratingSort?.slotId === target.slotId ? null : facetFilters.value.ratingSort,
      };
      galleryPage.value = 1;
      await Promise.all([loadGalleryEntries(), refreshFacetFilterOptions()]);
    }
    await reloadActiveEntry();
  } catch (cause) {
    deleteRatingTarget.value = null;
    error.value = cause instanceof Error ? cause.message : t('error.deleteEntry');
  }
}

async function deleteActiveEntry(): Promise<void> {
  const deletedEntry = activeEntry.value;
  if (!deletedEntry) return;
  if (!arm('delete-entry')) return;
  disarm('delete-entry');
  error.value = null;
  try {
    await props.api.deleteEntry(deletedEntry.id);

    // Preserve the same parent context as the detail Back action. Re-selecting
    // `activeType` here is wrong for Author/Search origins because those detail
    // flows keep a backing Gallery loaded while the Entry is open.
    entries.value = entries.value.filter((entry) => entry.id !== deletedEntry.id);
    if (entryOrigin.value && 'tagResults' in entryOrigin.value) {
      const origin = entryOrigin.value.tagResults;
      const remaining = origin.entries.filter((entry) => entry.id !== deletedEntry.id);
      entryOrigin.value = {
        tagResults: {
          ...origin,
          entries: remaining,
          total: Math.max(0, origin.total - (remaining.length === origin.entries.length ? 0 : 1)),
        },
      };
    }
    if (pendingBatchReview.value) {
      pendingBatchReview.value = {
        ...pendingBatchReview.value,
        entryIds: pendingBatchReview.value.entryIds.filter((id) => id !== deletedEntry.id),
      };
    }

    const returnsToGallery = entryOrigin.value === null
      && returnView.value === null
      && activeType.value !== null;
    const refreshes: Array<Promise<unknown>> = [refreshGalleries(), refreshAuthors()];
    // Gallery is the only parent whose card list remains mounted behind the
    // detail. Reload it in place; all secondary pages remount and reload in
    // closeEntry/restoreReturnView.
    if (returnsToGallery) refreshes.push(loadGalleryEntries());
    const refreshResults = await Promise.allSettled(refreshes);

    await closeEntry();
    const refreshFailure = refreshResults.find((result) => result.status === 'rejected');
    if (refreshFailure?.status === 'rejected') {
      error.value = refreshFailure.reason instanceof Error
        ? refreshFailure.reason.message
        : t('error.loadEntries');
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteEntry');
  }
}
// Layout template: rebuild this type's shared Section/Facet structure from
// the open Entry and re-map every Entry's tags onto it (see
// applyLayoutTemplate on the server).
const templateBusy = ref(false);
const templateNotice = ref<string | null>(null);
let templateNoticeTimer: number | null = null;
const tagLayoutBusy = ref(false);
const tagLayoutNotice = ref<string | null>(null);
const multiAuthorBusy = ref(false);
const multiAuthorNotice = ref<string | null>(null);
let multiAuthorNoticeTimer: number | null = null;

/**
 * How many Authors the conversion would absorb: every credited Author of the
 * open work except the multi-author Author itself. A work needs at least two
 * credited Authors for the action to be meaningful, so single-Author works and
 * already converted ones hide the button.
 */
const convertibleAuthorCount = computed(() => {
  const producers = activeEntry.value?.producers ?? [];
  if (producers.length < 2) return 0;
  return producers.filter((producer) => producer.name !== multiAuthorProducerName).length;
});

function clearMultiAuthorNotice(): void {
  if (multiAuthorNoticeTimer !== null) window.clearTimeout(multiAuthorNoticeTimer);
  multiAuthorNoticeTimer = null;
  multiAuthorNotice.value = null;
}

function showMultiAuthorNotice(message: string): void {
  clearMultiAuthorNotice();
  multiAuthorNotice.value = message;
  multiAuthorNoticeTimer = window.setTimeout(() => {
    multiAuthorNotice.value = null;
    multiAuthorNoticeTimer = null;
  }, 4_000);
}

function clearTemplateNotice(): void {
  if (templateNoticeTimer !== null) window.clearTimeout(templateNoticeTimer);
  templateNoticeTimer = null;
  templateNotice.value = null;
}

function showTemplateNotice(message: string): void {
  clearTemplateNotice();
  templateNotice.value = message;
  templateNoticeTimer = window.setTimeout(() => {
    templateNotice.value = null;
    templateNoticeTimer = null;
  }, 4_000);
}

watch(activeEntry, () => {
  mediaIndex.value = 0;
  clearTemplateNotice();
  tagLayoutNotice.value = null;
  clearMultiAuthorNotice();
}, { flush: 'sync' });
onUnmounted(() => {
  clearTemplateNotice();
  clearMultiAuthorNotice();
});

/** Save this work's structure as the Gallery's shared template. */
async function applyLayoutTemplate(): Promise<void> {
  if (!activeEntry.value) return;
  const type = activeEntry.value.type;
  templateBusy.value = true;
  templateNotice.value = null;
  error.value = null;
  try {
    const result = await props.api.applyEntryLayoutTemplate(activeEntry.value.id);
    // Facet ids all changed: reload the detail so tag rows point at the
    // rebuilt Facets and empty ones become visible via the toggle.
    activeEntry.value = await props.api.getEntry(activeEntry.value.id);
    showTemplateNotice(t('template.applied', {
      type,
      entries: result.entriesAffected,
      relinked: result.tagsRelinked,
    }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('template.applyError');
  } finally {
    templateBusy.value = false;
  }
}

async function saveLayoutTemplate(): Promise<void> {
  if (!activeEntry.value) return;
  if (!arm('save-template')) return;
  disarm('save-template');
  await applyLayoutTemplate();
}

// Tag layout sync: the open Entry's tag→Facet placement becomes the standard
// for every other Entry of the same type. Unlike Save as template this does
// NOT touch the shared Section/Facet structure — it only moves misplaced tag
// assignments in peer Entries (see applyEntryTagLayout on the server).
async function applyActiveEntryTagLayout(): Promise<void> {
  if (!activeEntry.value) return;
  const type = activeEntry.value.type;
  if (!arm('apply-tag-layout')) return;
  disarm('apply-tag-layout');
  tagLayoutBusy.value = true;
  tagLayoutNotice.value = null;
  error.value = null;
  try {
    const result = await props.api.applyEntryTagLayout(activeEntry.value.id);
    tagLayoutNotice.value = t('tagLayout.applied', {
      type,
      entries: result.entriesAffected,
      tags: result.tagsMoved,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('tagLayout.applyError');
  } finally {
    tagLayoutBusy.value = false;
  }
}

function inlineInputSize(value: string): number {
  return Math.max(5, value.length);
}

async function refreshGalleries(): Promise<void> {
  galleries.value = await props.api.listGalleries();
}

/**
 * Re-read the Gallery's filter options.
 *
 * They are not a static list: the server derives them from the tags that actually exist on that
 * type's Entries, in Facets that have a name. So they go stale the moment a tag is assigned, moved
 * or removed — and the reported bug was exactly that: a Gallery was opened while it had no tags (no
 * filter row), a tag was added inside one of its Entries, and coming back showed the old empty
 * options. Reading them again when the Gallery is shown is the one place that covers every route
 * back to it.
 */
async function refreshFacetFilterOptions(): Promise<void> {
  if (!activeType.value) return;
  try {
    facetFilterOptions.value = await props.api.listFacetFilterOptions(activeType.value);
  } catch {
    // A stale filter row is not worth an error of its own: selecting the Gallery again re-reads it.
  }
}

async function refreshAuthors(): Promise<void> {
  authors.value = await props.api.listAuthors();
}

async function refreshWorksAndAuthors(): Promise<void> {
  await Promise.all([refreshAuthors(), refreshGalleries()]);
}

async function selectGallery(
  entryType: string,
  keepEntry = false,
  preserveScrollHistory = false,
): Promise<void> {
  leaveAllViews(keepEntry, preserveScrollHistory);
  entries.value = [];
  galleryResultTotal.value = 0;
  facetFilterOptions.value = null;
  activeType.value = entryType;
  facetFilters.value = { conditions: [], authorIds: [], ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null };
  galleryPage.value = navigationMemory.pages.get(`gallery:${entryType}`) ?? 1;
  try {
    const [, filterOptions] = await Promise.all([
      loadGalleryEntries(),
      props.api.listFacetFilterOptions(entryType),
    ]);
    if (activeType.value === entryType) facetFilterOptions.value = filterOptions;
  } catch (cause) {
    if (activeType.value === entryType) {
      error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
    }
  }
}

async function loadGalleryEntries(): Promise<void> {
  if (!activeType.value) return;
  const seq = ++galleryEntriesRequestSeq;
  const { conditions, authorIds, ratingConditions, ratingSort, usageConditions, usageSort } = facetFilters.value;
  const activeConditions = conditions.filter((condition) => condition.tagIds.length > 0);

  const result = await props.api.queryEntryPage({
    entryType: activeType.value,
    conditions: activeConditions,
    authorIds,
    ratingConditions,
    ratingSort,
    usageConditions,
    usageSort,
    sort: gallerySort.value,
    ...(gallerySort.value === 'random' ? { randomSeed: galleryRandomSeed.value } : {}),
    page: galleryPage.value,
    pageSize: galleryPageSize.value,
  });
  if (seq !== galleryEntriesRequestSeq) return; // superseded by a newer request
  entries.value = result.items;
  galleryResultTotal.value = result.total;
  galleryPage.value = result.page;
}

async function onGalleryPageChange(page: number): Promise<void> {
  galleryPage.value = page;
  try {
    await loadGalleryEntries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function onGalleryPageSizeChange(pageSize: number): Promise<void> {
  if (galleryPageSize.value === pageSize) return;
  galleryPageSize.value = pageSize;
  galleryPage.value = Math.min(
    galleryPage.value,
    Math.max(1, Math.ceil(galleryResultTotal.value / pageSize)),
  );
  try {
    await loadGalleryEntries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function onFacetFiltersChange(filters: GalleryFacetFilters): Promise<void> {
  facetFilters.value = filters;
  galleryPage.value = 1;
  navigationMemory.pages.set(`gallery:${activeType.value ?? ''}`, 1);
  try {
    await loadGalleryEntries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('gallery.filterError');
  }
}

watch(gallerySort, (nextSort, previousSort) => {
  if (!activeType.value) return;
  if (nextSort === 'random' && previousSort !== 'random') {
    galleryRandomSeed.value = Math.floor(Math.random() * 2_147_483_648);
  }
  galleryPage.value = 1;
  navigationMemory.pages.set(`gallery:${activeType.value}`, 1);
  void loadGalleryEntries().catch((cause: unknown) => {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  });
});

function showCollections(preserveScrollHistory: boolean | Event = false): void {
  leaveAllViews(false, preserveScrollHistory === true);
  collectionsView.value = true;
}

function showRandom(preserveScrollHistory: boolean | Event = false): void {
  leaveAllViews(false, preserveScrollHistory === true);
  randomView.value = true;
}

function openEntryFromRandom(entryId: number): void {
  rememberReturnScroll();
  leaveAllViews(false, true);
  returnView.value = 'random';
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

function openAuthorFromRandom(authorId: number): void {
  rememberReturnScroll();
  authorRestoreInitialScroll.value = false;
  collectionsView.value = false;
  randomView.value = false;
  returnView.value = 'random';
  authorTarget.value = { authorId, authorName: '', directoryId: null, directoryName: null };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
  void scrollCurrentViewToTop();
}

// Random tag hits remember they came from the random page so closing the
// result returns there instead of the search page.
let randomTagReturn = false;

function openTagFromRandom(tag: { id: number; name: string }): void {
  rememberReturnScroll();
  error.value = null;
  randomTagReturn = true;
  void queryEntryTagResults({
    kind: 'entry',
    tagId: tag.id,
    tagName: tag.name,
    sourceEntry: null,
    sourceSearchQuery: null,
    sourceSearchScope: null,
  }).then((results) => {
    tagResults.value = results;
    randomView.value = false;
    void scrollCurrentViewToTop();
  }).catch((cause: unknown) => {
    discardReturnScroll();
    randomTagReturn = false;
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  });
}

function openEntryFromCollections(entryId: number): void {
  rememberReturnScroll();
  leaveAllViews(false, true);
  returnView.value = 'collections';
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

function openAuthorFromCollections(authorId: number): void {
  rememberReturnScroll();
  authorRestoreInitialScroll.value = false;
  collectionsView.value = false;
  returnView.value = 'collections';
  authorTarget.value = { authorId, authorName: '', directoryId: null, directoryName: null };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
  void scrollCurrentViewToTop();
}

function openEntryFromViewLater(entryId: number): void {
  rememberReturnScroll();
  leaveAllViews(false, true);
  viewLaterKind.value = 'entry';
  returnView.value = 'viewLater';
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

function openAuthorFromViewLater(authorId: number): void {
  rememberReturnScroll();
  authorRestoreInitialScroll.value = false;
  viewLaterView.value = false;
  viewLaterKind.value = 'author';
  returnView.value = 'viewLater';
  authorTarget.value = { authorId, authorName: '', directoryId: null, directoryName: null };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
  void scrollCurrentViewToTop();
}

// Home-opened entries fall back to Home when closed: no return view needed,
// the template's home branch catches it (homepage design guide §10).
function openEntryFromHome(entryId: number): void {
  rememberReturnScroll();
  leaveAllViews(false, true);
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

function openEntryFromGallery(entryId: number): void {
  rememberReturnScroll();
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

async function synchronizeViewLater(): Promise<void> {
  try {
    await refreshViewLater(props.api);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

function showViewLater(kind: 'entry' | 'author' | Event = 'entry', preserveScrollHistory = false): void {
  leaveAllViews(false, preserveScrollHistory);
  viewLaterKind.value = kind === 'author' ? 'author' : 'entry';
  viewLaterView.value = true;
  void synchronizeViewLater();
}

function openEntryFromRecent(entryId: number): void {
  rememberReturnScroll();
  leaveAllViews(false, true);
  returnView.value = 'recent';
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

function showRecentView(preserveScrollHistory: boolean | Event = false): void {
  leaveAllViews(false, preserveScrollHistory === true);
  recentView.value = true;
}

function showAuthors(): void {
  leaveAllViews();
  authorView.value = true;
}

async function openEntryFromAuthor(payload: {
  work: AuthorDetailResponse['looseEntries'][number];
  authorId: number;
  authorName: string;
  directoryId: number | null;
  directoryName: string | null;
  returnScrollPositions: number[];
}): Promise<void> {
  authorReturnScrollPositions.value = [...payload.returnScrollPositions];
  rememberReturnScroll();
  // Load the detail BEFORE switching views: clearing the author view first
  // rendered the gallery grid for as long as the fetches took. If the load
  // fails, the author page stays up with the error banner.
  await openEntry(payload.work.id);
  if (!activeEntry.value) {
    discardReturnScroll();
    return;
  }
  try {
    await selectGallery(payload.work.type, true, true);
  } catch {
    // The entry is already on screen; a stale backing gallery is harmless —
    // picking a gallery in the sidebar refetches it anyway.
  }
  entryOrigin.value = {
    authorId: payload.authorId,
    authorName: payload.authorName,
    directoryId: payload.directoryId,
    directoryName: payload.directoryName,
  };
  await scrollCurrentViewToTop();
}

async function openEntry(entryId: number): Promise<void> {
  error.value = null;
  try {
    const [detail, collectionOptions, memberIds] = await Promise.all([
      props.api.getEntry(entryId),
      props.api.listCollections('entry'),
      props.api.listCollectionsForEntry(entryId),
    ]);
    entryCollectionOptions.value = flattenCollectionOptions(
      collectionOptionsForGallery(collectionOptions, detail.type, memberIds),
    );
    entryCollectionIds.value = memberIds;
    activeEntry.value = detail;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntry');
  }
}

async function viewEntry(
  entryId: number,
  origin: EntryOrigin | null = null,
  scrollToTop = true,
): Promise<void> {
  entryOrigin.value = origin;
  editingEntry.value = false;
  resetLayoutEditors();
  await openEntry(entryId);
  if (scrollToTop && activeEntry.value?.id === entryId) await scrollCurrentViewToTop();
}

function startEditing(): void {
  editingEntry.value = true;
  resetLayoutEditors();
}

async function beginEntryTitleEdit(): Promise<void> {
  if (!editingEntry.value || !activeEntry.value || entryTitleSaving.value) return;
  entryTitleDraft.value = activeEntry.value.title;
  entryTitleEditorOpen.value = true;
  await nextTick();
  entryTitleInput.value?.focus();
  entryTitleInput.value?.select();
}

function cancelEntryTitleEdit(): void {
  entryTitleEditorOpen.value = false;
  entryTitleDraft.value = '';
}

function replaceEntryTitle(
  items: GalleryEntrySummary[],
  entryId: number,
  title: string,
): GalleryEntrySummary[] {
  return items.map((item) => item.id === entryId ? { ...item, title } : item);
}

async function saveEntryTitle(): Promise<void> {
  if (!entryTitleEditorOpen.value || !activeEntry.value || entryTitleSaving.value) return;
  const entryId = activeEntry.value.id;
  const title = entryTitleDraft.value.trim();
  if (!title) {
    error.value = t('entry.titleRequired');
    return;
  }
  if (title === activeEntry.value.title) {
    cancelEntryTitleEdit();
    return;
  }

  entryTitleSaving.value = true;
  error.value = null;
  try {
    const updated = await props.api.updateEntry(entryId, { title });
    if (activeEntry.value?.id !== entryId) return;
    activeEntry.value = { ...activeEntry.value, title: updated.title };
    entries.value = replaceEntryTitle(entries.value, entryId, updated.title);
    if (tagResults.value?.kind === 'entry') {
      tagResults.value = {
        ...tagResults.value,
        entries: replaceEntryTitle(tagResults.value.entries, entryId, updated.title),
      };
    }
    if (entryOrigin.value && 'tagResults' in entryOrigin.value) {
      entryOrigin.value = {
        tagResults: {
          ...entryOrigin.value.tagResults,
          entries: replaceEntryTitle(entryOrigin.value.tagResults.entries, entryId, updated.title),
        },
      };
    }
    cancelEntryTitleEdit();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateEntry');
  } finally {
    entryTitleSaving.value = false;
  }
}

async function discardBlockedOfflineEdits(): Promise<void> {
  try {
    await props.api.discardBlockedOfflineOperations?.();
    const current = activeEntry.value;
    if (current !== null) {
      const refreshed = await props.api.getEntry(current.id);
      activeEntry.value = refreshed;
      entries.value = replaceEntryTitle(entries.value, refreshed.id, refreshed.title);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateEntry');
  }
}

async function closeEntry(): Promise<void> {
  if (entryOrigin.value) {
    if ('tagResults' in entryOrigin.value) {
      tagResults.value = entryOrigin.value.tagResults;
      entryOrigin.value = null;
      activeEntry.value = null;
      activeType.value = null;
      editingEntry.value = false;
      resetLayoutEditors();
      await restorePreviousScroll();
      return;
    }
    if ('searchQuery' in entryOrigin.value) {
      searchQuery.value = entryOrigin.value.searchQuery;
      searchScope.value = entryOrigin.value.searchScope;
      entryOrigin.value = null;
      activeEntry.value = null;
      activeType.value = null;
      searchView.value = true;
      editingEntry.value = false;
      resetLayoutEditors();
      await restorePreviousScroll();
      return;
    }
    authorRestoreInitialScroll.value = true;
    authorTarget.value = entryOrigin.value;
    entryOrigin.value = null;
    activeEntry.value = null;
    activeType.value = null;
    authorView.value = true;
    editingEntry.value = false;
    resetLayoutEditors();
    await nextTick();
    await authorPageRef.value?.waitUntilReady();
    await restorePreviousScroll();
    return;
  }
  activeEntry.value = null;
  editingEntry.value = false;
  resetLayoutEditors();
  restoreReturnView();
  await restorePreviousScroll();
  // The Entry may have been edited (a tag added, a Facet created) while it was open, and those are
  // what the filter row is built from.
  await refreshFacetFilterOptions();
}

function restoreReturnView(): void {
  const target = returnView.value;
  returnView.value = null;
  if (target === 'recent') showRecentView(true);
  else if (target === 'viewLater') showViewLater(viewLaterKind.value, true);
  else if (target === 'collections') showCollections(true);
  else if (target === 'random') showRandom(true);
  else if (target === 'batch' && pendingBatchReview.value) {
    batchReview.value = pendingBatchReview.value;
    pendingBatchReview.value = null;
  }
}

async function openEntryTag(tag: { id: number; name: string }): Promise<void> {
  if (editingEntry.value || !activeEntry.value) return;
  rememberReturnScroll();
  const sourceEntry = {
    id: activeEntry.value.id,
    type: activeEntry.value.type,
    title: activeEntry.value.title,
  };
  error.value = null;
  try {
    tagResults.value = await queryEntryTagResults({
      kind: 'entry',
      tagId: tag.id,
      tagName: tag.name,
      sourceEntry,
      sourceSearchQuery: null,
      sourceSearchScope: null,
    });
    activeEntry.value = null;
    activeType.value = null;
    await scrollCurrentViewToTop();
  } catch (cause) {
    discardReturnScroll();
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function openAuthorTag(payload: {
  tagId: number;
  tagName: string;
  authorId: number;
  authorName: string;
  returnScrollPositions: number[];
}): Promise<void> {
  authorReturnScrollPositions.value = [...payload.returnScrollPositions];
  rememberReturnScroll();
  error.value = null;
  try {
    tagResults.value = await queryAuthorTagResults({
      kind: 'author',
      tagId: payload.tagId,
      tagName: payload.tagName,
      sourceAuthor: {
        authorId: payload.authorId,
        authorName: payload.authorName,
        directoryId: null,
        directoryName: null,
      },
    });
    authorView.value = false;
    authorTarget.value = null;
    await scrollCurrentViewToTop();
  } catch (cause) {
    discardReturnScroll();
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthors');
  }
}

async function openTagEntry(entry: GalleryEntrySummary): Promise<void> {
  if (tagResults.value?.kind !== 'entry') return;
  rememberReturnScroll();
  const origin = tagResults.value;
  tagResults.value = null;
  activeType.value = entry.type;
  await viewEntry(entry.id, { tagResults: origin });
  if (activeEntry.value?.id !== entry.id) discardReturnScroll();
}

function openTagAuthor(author: { id: number; name: string }): void {
  if (tagResults.value?.kind !== 'author') return;
  rememberReturnScroll();
  authorRestoreInitialScroll.value = false;
  authorTagOrigin.value = tagResults.value;
  tagResults.value = null;
  authorTarget.value = {
    authorId: author.id,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  authorView.value = true;
  void scrollCurrentViewToTop();
}

async function restoreAuthorTagResults(): Promise<void> {
  if (authorTagOrigin.value) {
    tagResults.value = authorTagOrigin.value;
    authorTagOrigin.value = null;
    authorView.value = false;
    authorTarget.value = null;
    await restorePreviousScroll();
    return;
  }
  if (authorSearchOrigin.value !== null) {
    searchQuery.value = authorSearchOrigin.value.searchQuery;
    searchScope.value = authorSearchOrigin.value.searchScope;
    authorSearchOrigin.value = null;
    authorView.value = false;
    authorTarget.value = null;
    searchView.value = true;
    await restorePreviousScroll();
    return;
  }
  if (returnView.value !== null) {
    restoreReturnView();
    await restorePreviousScroll();
    return;
  }
  authorTarget.value = null;
  await restorePreviousScroll();
}

async function closeTagResults(): Promise<void> {
  const current = tagResults.value;
  if (!current) return;
  tagResults.value = null;
  if (current.kind === 'entry') {
    if (current.sourceEntry) {
      activeType.value = current.sourceEntry.type;
      await viewEntry(current.sourceEntry.id, null, false);
    } else if (randomTagReturn) {
      randomTagReturn = false;
      showRandom(true);
    } else {
      searchQuery.value = current.sourceSearchQuery ?? '';
      searchScope.value = current.sourceSearchScope ?? 'entries';
      searchView.value = true;
    }
    await restorePreviousScroll();
    return;
  }
  authorRestoreInitialScroll.value = true;
  authorTarget.value = current.sourceAuthor;
  authorView.value = true;
  await restorePreviousScroll();
}

function openAuthorFromEntry(authorId: number): void {
  const author = activeEntry.value?.producers.find((producer) => producer.id === authorId);
  if (!author) return;
  authorTarget.value = {
    authorId,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
  editingEntry.value = false;
  resetLayoutEditors();
}

const templatePromptOpen = ref(false);

/**
 * The first work of a Gallery that has no shared structure yet. Offering the
 * template here is the last chance to notice it: after this, the work's own
 * Sections and Facets exist but no peer work has been given them.
 */
function needsTemplatePrompt(): boolean {
  const entry = activeEntry.value;
  if (entry === null || entry.sections.length > 0) return false;
  const summary = galleries.value.find((gallery) => gallery.type === entry.type);
  return summary?.entryCount === 1;
}

function finishEditing(): void {
  if (needsTemplatePrompt()) {
    templatePromptOpen.value = true;
    return;
  }
  editingEntry.value = false;
  resetLayoutEditors();
}

function dismissTemplatePrompt(): void {
  templatePromptOpen.value = false;
  editingEntry.value = false;
  resetLayoutEditors();
}

async function applyTemplateAndFinish(): Promise<void> {
  templatePromptOpen.value = false;
  await applyLayoutTemplate();
  editingEntry.value = false;
  resetLayoutEditors();
}

function resetLayoutEditors(): void {
  templatePromptOpen.value = false;
  cancelEntryTitleEdit();
  sectionEditorOpen.value = false;
  facetEditorSectionId.value = null;
  tagEditorFacetId.value = null;
  editingTagId.value = null;
  contentEditorOpen.value = false;
  editingContentId.value = null;
  ratingEditorOpen.value = false;
  draggedTagId.value = null;
  selectedTagId.value = null;
  selectedTagFacetId.value = null;
  sectionName.value = '';
  facetName.value = '';
  editingTagName.value = '';
  contentType.value = '';
  contentBody.value = '';
  editingContentType.value = '';
  editingContentBody.value = '';
  authorEditorOpen.value = false;
  authorLinkEditorOpen.value = false;
  newAuthorName.value = '';
  authorDuplicateNames.value = [];
  if (authorDuplicateTimer !== null) {
    clearTimeout(authorDuplicateTimer);
    authorDuplicateTimer = null;
  }
}

watch(newAuthorName, (value) => {
  if (authorDuplicateTimer !== null) {
    clearTimeout(authorDuplicateTimer);
    authorDuplicateTimer = null;
  }
  if (!authorEditorOpen.value || value.trim() === '') {
    authorDuplicateNames.value = [];
    return;
  }
  const query = value.trim();
  authorDuplicateTimer = setTimeout(async () => {
    authorDuplicateTimer = null;
    try {
      const hits = await props.api.suggestProducers({ q: query, excludeIds: [] });
      authorDuplicateNames.value = hits.map((hit) => hit.name);
    } catch {
      // The warning is best-effort; creation itself stays authoritative.
      authorDuplicateNames.value = [];
    }
  }, 180);
});

async function createAndLinkAuthor(): Promise<void> {
  if (!activeEntry.value || !newAuthorName.value.trim()) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    // One call resolves-or-creates: a name that already exists (directly or
    // through an author-dictionary alias) is linked instead of duplicated.
    const result = await props.api.linkEntryAuthorByName(entryId, newAuthorName.value.trim());
    authorEditorOpen.value = false;
    newAuthorName.value = '';
    authorDuplicateNames.value = [];
    await Promise.all([refreshAuthors(), openEntry(entryId)]);
    if (!result.created) {
      showMultiAuthorNotice(t('author.linkedExisting', { name: result.producerName }));
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createAuthor');
  }
}

async function linkExistingAuthor(authorId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.linkEntryAuthor(entryId, authorId);
    authorLinkEditorOpen.value = false;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.linkAuthor');
  }
}

async function unlinkAuthor(authorId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.unlinkEntryAuthor(entryId, authorId);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.unlinkAuthor');
  }
}

async function convertEntryAuthors(): Promise<void> {
  const entry = activeEntry.value;
  if (!entry) return;
  error.value = null;
  multiAuthorBusy.value = true;
  try {
    const result = await props.api.convertEntryAuthors(entry.id);
    await Promise.all([refreshAuthors(), openEntry(entry.id)]);
    showMultiAuthorNotice(t('entry.multiAuthorDone', {
      count: result.convertedAuthors.length,
      name: result.multiAuthorName,
    }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.convertMultiAuthor');
  } finally {
    multiAuthorBusy.value = false;
  }
}

/**
 * The Content rows worth showing: in read mode a row with no text is a slot nobody filled, not
 * content — the built-in kinds (`source url`, `description`) exist for every work, and the rule is
 * that a work which has nothing to say about one does not show it. In edit mode every row is shown,
 * empty ones included, because that is where they get filled or removed.
 */
const visibleContents = computed(() => {
  const rows = activeEntry.value?.contents ?? [];
  return editingEntry.value ? rows : rows.filter((row) => row.content.trim() !== '');
});

/**
 * The Content kinds this Gallery's works use, offered as one-click labels in the add form.
 *
 * The built-ins are not optional — a Gallery always has `source url` and `description` — so a failed
 * load degrades to those rather than to an empty row of choices.
 */
const contentKindOptions = ref<string[]>([...DEFAULT_CONTENT_KINDS]);

async function loadContentKinds(entryType: string): Promise<void> {
  try {
    contentKindOptions.value = await props.api.listContentKinds(entryType);
  } catch (cause) {
    contentKindOptions.value = [...DEFAULT_CONTENT_KINDS];
    console.warn('Content kinds unavailable, offering the built-ins', cause);
  }
}

function openContentEditor(): void {
  contentEditorOpen.value = true;
  const entryType = activeEntry.value?.type.trim() ?? '';
  if (entryType !== '') void loadContentKinds(entryType);
}

async function createContent(): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  if (contentBody.value.trim() === '') {
    // An empty Content row is a slot, and a slot is not content: it would render as a blank line and
    // re-appear as a "default" the work never had. The form asks for text instead.
    error.value = t('content.bodyRequired');
    return;
  }
  const nextSortOrder = activeEntry.value.contents.reduce(
    (highest, item) => Math.max(highest, item.sortOrder),
    -1,
  ) + 1;
  error.value = null;
  try {
    await props.api.createEntryContent(entryId, {
      contentType: contentType.value,
      content: contentBody.value,
      sortOrder: nextSortOrder,
    });
    contentType.value = '';
    contentBody.value = '';
    contentEditorOpen.value = false;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addContent');
  }
}

function beginContentEdit(content: EntryDetailResponse['contents'][number]): void {
  editingContentId.value = content.id;
  editingContentType.value = content.contentType;
  editingContentBody.value = content.content;
}

function cancelContentEdit(): void {
  editingContentId.value = null;
  editingContentType.value = '';
  editingContentBody.value = '';
}

async function saveContentEdit(contentId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.updateEntryContent(contentId, {
      contentType: editingContentType.value,
      content: editingContentBody.value,
    });
    cancelContentEdit();
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateContent');
  }
}

async function deleteContent(contentId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.deleteEntryContent(contentId);
    if (editingContentId.value === contentId) cancelContentEdit();
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteContent');
  }
}

async function moveContent(contentId: number, offset: -1 | 1): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  const orderedContentIds = activeEntry.value.contents.map((content) => content.id);
  const sourceIndex = orderedContentIds.indexOf(contentId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedContentIds.length) return;
  [orderedContentIds[sourceIndex], orderedContentIds[targetIndex]] = [
    orderedContentIds[targetIndex] as number,
    orderedContentIds[sourceIndex] as number,
  ];
  error.value = null;
  try {
    await props.api.reorderEntryContents(entryId, orderedContentIds);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderContent');
  }
}

async function createSection(): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    await props.api.createSection({ entryType: activeEntry.value.type, name: sectionName.value });
    sectionName.value = '';
    sectionEditorOpen.value = false;
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createSection');
  }
}

// Rating rows are updated in place (no full detail reload): picking stars must
// stay instant while the shared slot set lives on the Gallery template.
function applyRatingRow(row: RatingRow): void {
  const entry = activeEntry.value;
  if (!entry) return;
  entry.ratings = entry.ratings.map((item) => (item.slotId === row.slotId ? row : item));
}

async function createRatingSlot(): Promise<void> {
  if (!activeEntry.value) return;
  const name = ratingName.value.trim();
  if (name === '') return;
  error.value = null;
  try {
    await props.api.createEntryRatingSlot(activeEntry.value.id, name);
    ratingName.value = '';
    ratingEditorOpen.value = false;
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createRatingSlot');
  }
}

async function chooseEntryStars(slotId: number, stars: number): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    applyRatingRow(await props.api.setEntryRating(activeEntry.value.id, slotId, stars));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.setRating');
  }
}

async function clearEntryStars(slotId: number): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    applyRatingRow(await props.api.setEntryRating(activeEntry.value.id, slotId, null));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.setRating');
  }
}

async function moveRatingSlot(slotId: number, direction: -1 | 1): Promise<void> {
  const entry = activeEntry.value;
  if (!entry) return;
  const orderedIds = entry.ratings.map((row) => row.slotId);
  const index = orderedIds.indexOf(slotId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= orderedIds.length) return;
  [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
  error.value = null;
  try {
    // Slot order is shared per Gallery: the reorder propagates to every card.
    await props.api.reorderEntryRatingSlots(entry.id, orderedIds);
    await openEntry(entry.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderRating');
  }
}

/**
 * Put a just-recorded tag on screen from the write's own answer. The tag is
 * already there (on the server, or in the offline copy), and re-reading the
 * whole Entry over the network to see it cost 1.2s with a live server and up to
 * the read timeout whenever the connection was bad — the user's "sometimes it
 * does not refresh and you have to wait". False when the answer cannot be
 * placed (unknown Facet), in which case the caller falls back to the read.
 */
function applyEntryTagAssignment(assignment: EntryTagAssignment): boolean {
  const entry = activeEntry.value;
  const facet = entry?.sections.flatMap((section) => section.facets)
    .find((row) => row.id === assignment.facetId);
  if (entry === null || facet === undefined) return false;
  if (!facet.tags.some((tag) => tag.normalizedName === assignment.normalizedName)) {
    facet.tags = [...facet.tags, {
      id: assignment.tagId,
      name: assignment.name,
      normalizedName: assignment.normalizedName,
    }].sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
  }
  return true;
}

async function submitEntryTag(facetId: number, name: string): Promise<void> {
  const entryId = activeEntry.value?.id;
  if (entryId === undefined || entryTagSaving.value || name.trim() === '') return;
  entryTagSaving.value = true; error.value = null;
  try {
    const assignment = await props.api.assignEntryTag(entryId, { facetId, name });
    if (activeEntry.value?.id !== entryId) return;
    tagEditorFacetId.value = null;
    if (assignment !== null && assignment !== undefined && applyEntryTagAssignment(assignment)) {
      // Recorded and shown; the authoritative re-read only reconciles in the
      // background, so a slow or unreachable server no longer holds the row.
      void openEntry(entryId).then(() => {
        if (error.value && activeEntry.value?.id === entryId) error.value = t('search.pendingTagsRefreshError');
      });
      return;
    }
    await openEntry(entryId);
    if (error.value && activeEntry.value?.id === entryId) error.value = t('search.pendingTagsRefreshError');
  } catch (cause) {
    if (activeEntry.value?.id === entryId) error.value = cause instanceof Error ? cause.message : t('error.addTag');
  } finally { entryTagSaving.value = false; }
}

async function createNamedFacet(sectionId: number): Promise<void> {
  if (!activeEntry.value || entryFacetSaving.value) return;
  const entryId = activeEntry.value.id;
  const newFacetName = facetName.value.trim();
  if (newFacetName === '') return;
  error.value = null;
  const section = activeEntry.value.sections.find((item) => item.id === sectionId);
  const existing = section?.facets.find((facet) => facet.name === newFacetName);
  if (existing) {
    if (existing.tags.length > 0) {
      error.value = t('error.duplicateFacet', { name: newFacetName });
      return;
    }
    tagEditorFacetId.value = existing.id;
    facetName.value = '';
    facetEditorSectionId.value = null;
    return;
  }
  entryFacetSaving.value = true;
  let committed = false;
  try {
    await props.api.createFacet({
      sectionId,
      name: newFacetName,
    });
    committed = true;
    if (activeEntry.value?.id !== entryId) return;
    facetName.value = '';
    facetEditorSectionId.value = null;
    await openEntry(entryId);
    if (error.value) { error.value = t('search.pendingTagsRefreshError'); return; }
    tagEditorFacetId.value = activeEntry.value?.sections
      .find((section) => section.id === sectionId)
      ?.facets.find((facet) => facet.name === newFacetName)?.id ?? null;
    facetName.value = '';
    facetEditorSectionId.value = null;
  } catch (cause) {
    if (activeEntry.value?.id === entryId) error.value = committed ? t('search.pendingTagsRefreshError') : cause instanceof Error ? cause.message : t('error.createFacet');
  } finally { entryFacetSaving.value = false; }
}

async function moveFacet(sectionId: number, facetId: number, offset: -1 | 1): Promise<void> {
  if (!activeEntry.value) return;
  const section = activeEntry.value.sections.find((item) => item.id === sectionId);
  if (!section) return;
  const orderedFacetIds = section.facets.map((facet) => facet.id);
  const sourceIndex = orderedFacetIds.indexOf(facetId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedFacetIds.length) return;
  [orderedFacetIds[sourceIndex], orderedFacetIds[targetIndex]] = [
    orderedFacetIds[targetIndex] as number,
    orderedFacetIds[sourceIndex] as number,
  ];
  error.value = null;
  try {
    await props.api.reorderSectionFacets(sectionId, orderedFacetIds);
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderFacet');
  }
}

/**
 * A Section is the heading above its Facets, and it was the one part of the board with no controls:
 * a name could be given when it was created and never changed, and there was no way to drop one. The
 * two operations below are the Facet pair (`removeFacet` / `saveTagRename`) applied to the heading —
 * same arm-then-confirm, same reload, same error surface — because they destroy the same kind of data.
 */
function startSectionRename(section: { id: number; name: string }): void {
  editingSectionId.value = section.id;
  editingSectionName.value = section.name;
}

function cancelSectionRename(): void {
  editingSectionId.value = null;
  editingSectionName.value = '';
}

async function saveSectionRename(sectionId: number): Promise<void> {
  if (!activeEntry.value || editingSectionId.value !== sectionId) return;
  const name = editingSectionName.value.trim();
  if (name === '') {
    cancelSectionRename();
    return;
  }
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.renameSection(sectionId, name);
    cancelSectionRename();
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.renameSection');
  }
}

async function removeSection(section: { id: number; name: string }): Promise<void> {
  if (!activeEntry.value) return;
  if (!arm(`delete-section-${section.id}`)) return;
  disarm(`delete-section-${section.id}`);
  error.value = null;
  try {
    await props.api.deleteSection(section.id);
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    // The server refuses a Section that still has tags assigned to it. Repeating that sentence helps
    // nobody; naming the Section and the next step does.
    const message = cause instanceof Error ? cause.message : '';
    error.value = /assigned tags/u.test(message)
      ? t('error.sectionHasTags', { name: section.name })
      : message || t('error.deleteSection');
  }
}

async function removeFacet(facetId: number): Promise<void> {
  if (!activeEntry.value) return;
  const facet = activeEntry.value.sections
    .flatMap((section) => section.facets)
    .find((candidate) => candidate.id === facetId);
  if (!facet || facet.name === '') return;
  if (!arm(`delete-facet-${facetId}`)) return;
  disarm(`delete-facet-${facetId}`);
  error.value = null;
  try {
    await props.api.deleteFacet(facetId);
    await openEntry(activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteFacet');
  }
}

function visibleFacets(section: EntryDetailResponse['sections'][number]) {
  if (editingEntry.value) {
    // Editing shows every named Facet whether or not it carries tags — one
    // Gallery shares one template, so the information surface being edited
    // should read the same on every Entry — plus any unnamed Facet that
    // carries tags or is being edited (a blank unnamed one has nothing to edit).
    return section.facets.filter((facet) => facet.name.length > 0
      || facet.tags.length > 0
      || tagEditorFacetId.value === facet.id);
  }
  // Reading keeps an empty Facet hidden: there is nothing in it to read.
  return section.facets.filter((facet) => facet.tags.length > 0
    || (facet.name.length > 0 && tagEditorFacetId.value === facet.id));
}

function emptyUnnamedFacetId(section: EntryDetailResponse['sections'][number]): number | null {
  return section.facets.find((facet) => facet.name.length === 0 && facet.tags.length === 0)?.id
    ?? null;
}

function beginTagDrag(tagId: number): void {
  if (!editingEntry.value) return;
  draggedTagId.value = tagId;
}

function toggleTagMoveSelection(tagId: number, facetId: number): void {
  if (!editingEntry.value) return;
  if (selectedTagId.value === tagId) {
    selectedTagId.value = null;
    selectedTagFacetId.value = null;
    return;
  }
  selectedTagId.value = tagId;
  selectedTagFacetId.value = facetId;
}

function beginTagRename(tag: EntryDetailResponse['sections'][number]['facets'][number]['tags'][number]): void {
  if (!editingEntry.value) return;
  selectedTagId.value = null;
  selectedTagFacetId.value = null;
  editingTagId.value = tag.id;
  editingTagName.value = tag.name;
}

async function saveTagRename(tagId: number): Promise<void> {
  if (!activeEntry.value || editingTagId.value !== tagId || !editingTagName.value.trim()) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.renameEntryTag(entryId, tagId, editingTagName.value);
    editingTagId.value = null;
    editingTagName.value = '';
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.renameTag');
  }
}

async function moveDraggedTag(targetFacetId: number): Promise<void> {
  if (!editingEntry.value || !activeEntry.value || draggedTagId.value === null) return;
  const tagId = draggedTagId.value;
  draggedTagId.value = null;
  await moveTagToFacet(tagId, targetFacetId);
}

async function moveSelectedTag(targetFacetId: number): Promise<void> {
  if (selectedTagId.value === null || selectedTagFacetId.value === targetFacetId) return;
  await moveTagToFacet(selectedTagId.value, targetFacetId);
}

async function moveTagToFacet(tagId: number, targetFacetId: number): Promise<void> {
  if (!editingEntry.value || !activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.moveEntryTag(entryId, tagId, targetFacetId);
    selectedTagId.value = null;
    selectedTagFacetId.value = null;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.moveTag');
  }
}

async function removeTag(tagId: number): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.removeEntryTag(entryId, tagId);
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeTag');
  }
}

/**
 * Sidebar numbers come from one visibility-aware interface instead of the raw
 * list lengths, so SFW mode never advertises NSFW Authors or saved works. The
 * list lengths remain the fallback for a client whose server has no counts route.
 */
const navigationCounts = ref<NavigationCounts | null>(null);
function isOfflineNow(): boolean {
  return props.offlineState?.mode === 'offline';
}

async function refreshNavigationCounts(): Promise<void> {
  // The offline library already provides visible Authors/View-later state. This
  // online-only count endpoint must not hold a saved copy behind a native HTTP
  // timeout after a cold launch with the desktop server stopped.
  if (isOfflineNow() || props.api.getNavigationCounts === undefined) {
    navigationCounts.value = null;
    return;
  }
  try {
    const counts = await props.api.getNavigationCounts(showNsfw.value);
    if (!isOfflineNow()) navigationCounts.value = counts;
  } catch {
    navigationCounts.value = null;
  }
}

const visibleAuthorCount = computed(() => (
  navigationCounts.value?.authors ?? authors.value.length
));
const visibleViewLaterCount = computed(() => (
  navigationCounts.value === null
    ? viewLaterIds.value.length + viewLaterAuthorIds.value.length
    : navigationCounts.value.viewLaterEntries + navigationCounts.value.viewLaterAuthors
));

let startupComplete = false;
async function initialize(): Promise<void> {
  try {
    // Home is the default view: nothing is selected until the user picks a
    // Gallery (homepage design guide §10 — no first-gallery fallback).
    // Gallery doors are the first usable screen. Authors, View later and
    // sidebar counts fill in reactively; none may gate the initial paint.
    const reportSupplementaryError = (cause: unknown): void => {
      if (props.offlineState?.mode === 'offline' && isOfflineTransportError(cause)) return;
      error.value = cause instanceof Error ? cause.message : t('error.loadGalleries');
    };
    void refreshNavigationCounts();
    void refreshAuthors().catch(reportSupplementaryError);
    void initializeViewLater(props.api).catch(reportSupplementaryError);
    await refreshGalleries();
    startupMilestones.galleriesReadyAtMs ??= Math.round(performance.now());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadGalleries');
  } finally {
    loading.value = false;
  }
}

/**
 * Re-read every surface that can be stale after the data underneath it changed:
 * a connection transition, or the offline copy being downloaded, cleared or
 * restored from Settings. Home reads once when it mounts, and a selected
 * Gallery's card list stays mounted behind the detail — both kept showing the
 * old data until the page was entered again (found on the phone). The Home ref
 * is null whenever Home is not the visible page, so this costs nothing there.
 */
async function reloadVisibleSurfaces(): Promise<void> {
  await initialize();
  const refreshes: Array<Promise<unknown>> = [];
  if (activeType.value !== null) refreshes.push(loadGalleryEntries());
  if (activeEntry.value !== null) refreshes.push(reloadActiveEntry());
  if (homePageRef.value !== null) refreshes.push(Promise.resolve(homePageRef.value.reload()));
  await Promise.allSettled(refreshes);
}

// A successful capability probe can arrive without a Wi-Fi event. Refresh
// visible data after either transition; never keep an empty online projection
// pinned over an installed offline copy (or vice versa).
watch(() => props.offlineState?.mode, (next, previous) => {
  if (!startupComplete || next === previous || next === undefined) return;
  void reloadVisibleSurfaces();
});

watch(() => props.offlineState?.lastReplaySnapshotSeq, (next, previous) => {
  if (!startupComplete || next === undefined || next === null || next === previous) return;
  const author = authorTarget.value;
  if (author !== null) {
    const reconciled = props.offlineState?.reconciledAuthorIds?.[String(author.authorId)];
    if (reconciled !== undefined) authorTarget.value = { ...author, authorId: reconciled };
  }
  void initialize().then(async () => {
    const refreshes: Array<Promise<unknown>> = [];
    if (activeType.value !== null) refreshes.push(loadGalleryEntries());
    if (activeEntry.value !== null) refreshes.push(reloadActiveEntry());
    await Promise.allSettled(refreshes);
  });
});

let entryCreateAttemptUid: string | undefined;
// The exact atomic create command of an uncertain online submit. Retrying it
// verbatim is what makes the attempt safe: the server receipt keyed by opId
// answers the replay instead of creating a second Entry.
let entryCreateAttempt: SyncReplayOperation | undefined;
function openCreation(view: CreationView): void {
  closeMobileNavigation();
  // Reopening the composer starts a new draft; retries within the same open form
  // must keep the identity of any online request whose response was uncertain.
  entryCreateAttemptUid = undefined;
  entryCreateAttempt = undefined;
  creationView.value = view;
  tagResults.value = null;
  activeEntry.value = null;
  recentView.value = false;
  viewLaterView.value = false;
  collectionsView.value = false;
  randomView.value = false;
  batchReview.value = null;
  searchView.value = false;
  authorView.value = false;
  advancedView.value = false;
}

const pendingEntryMedia = ref<{ entryId: number; uploads: Array<{ kind: 'cover' | 'preview'; file: File }> } | null>(null);

async function retryEntryMedia(): Promise<void> {
  const pending = pendingEntryMedia.value;
  if (!pending || submitting.value) return;
  submitting.value = true;
  try {
    while (pending.uploads.length > 0) {
      const upload = pending.uploads[0]!;
      await props.api.uploadEntryMedia(pending.entryId, upload.kind, upload.file);
      pending.uploads.shift();
    }
    pendingEntryMedia.value = null;
    error.value = null;
    await refreshGalleries();
    await openEntry(pending.entryId);
  } catch (cause) {
    error.value = `${t('entry.createdButIncomplete', { id: pending.entryId })} ${cause instanceof Error ? cause.message : t('error.createEntry')}`;
  } finally {
    submitting.value = false;
  }
}

async function submitEntry(draft: ManualEntryDraft): Promise<void> {
  error.value = null;
  submitting.value = true;
  const targetType = draft.type;
  let createdId: number | undefined;
  let createUid = entryCreateAttemptUid;
  const enqueueOffline = async (cause?: unknown, presetOperation?: SyncReplayOperation): Promise<string | undefined> => {
    if (props.api.enqueueOfflineEntryCreate === undefined) {
      throw cause ?? new Error('Offline Entry creation is unavailable');
    }
    // Match online creation: Source is ordinary Content, followed by the
    // explicitly entered initial rows. The facade assigns durable Content UIDs.
    const contents = [
      ...(draft.sourceUrl ? [{ contentType: 'Source URL', content: draft.sourceUrl }] : []),
      ...(draft.contents ?? []),
    ];
    const input = {
      title: draft.title,
      type: targetType,
      uploadDate: draft.uploadDate,
      pageCount: draft.pageCount,
      ...(draft.durationSeconds === null ? {} : { durationSeconds: draft.durationSeconds }),
      ratings: draft.ratings.flatMap((rating) => (
        rating.stars === null ? [] : [{ slotId: rating.slotId, stars: rating.stars }]
      )),
      viewLater: draft.viewLater,
      ...(createUid === undefined ? {} : { syncUid: createUid }),
      ...(contents.length ? { contents } : {}),
      coverFile: draft.coverFile,
      previewFile: draft.previewFiles[0] ?? null,
      previewFiles: draft.previewFiles,
      ...(presetOperation === undefined ? {} : { presetCreateOperation: presetOperation }),
    };
    if (cause === undefined) {
      const queued = await props.api.enqueueOfflineEntryCreate(input);
      return queued?.localKey;
    }
    const queued = await props.api.enqueueOfflineEntryCreate(input, cause);
    return queued?.localKey;
  };
  /**
   * Every create changes the Gallery card list and the sidebar counts, whether
   * it committed on the server or only queued in the offline copy. The queued
   * paths return early, so this runs on each of them too — without it a work
   * created offline only appeared after switching galleries (found on the
   * phone, twice: the committed path was fixed first, the queued path kept it).
   */
  const refreshAfterEntryCreate = async (): Promise<void> => {
    await refreshGalleries();
    await refreshFacetFilterOptions();
    if (activeType.value !== null) await loadGalleryEntries();
  };
  // The atomic create command (plan §27.2): metadata, ratings, View later and
  // initial Content travel as one retryable server command; media stays on its
  // own idempotent channel. An uncertain transport failure resolves through
  // the identical operation — its receipt, or a durable offline replay of it.
  const submitEntryCreateCommand = async (
    capabilities: SyncCapabilities,
  ): Promise<{ kind: 'created'; entryId: number } | { kind: 'enqueued-offline' } | { kind: 'new-gallery' }> => {
    const replay = props.api.replaySyncOperation;
    if (replay === undefined) throw new Error(t('entry.createCommandUnavailable'));
    let operation = entryCreateAttempt;
    if (operation === undefined) {
      if (createUid === undefined) {
        createUid = randomUuid();
        entryCreateAttemptUid = createUid;
      }
      const clientId = (await props.api.getClientId?.()) ?? randomUuid();
      const contents = [
        ...(draft.sourceUrl ? [{ contentType: 'Source URL', content: draft.sourceUrl }] : []),
        ...(draft.contents ?? []),
      ];
      operation = {
        opId: randomUuid(),
        clientId,
        libraryId: capabilities.libraryId,
        syncEpoch: capabilities.syncEpoch,
        entityKind: 'entry',
        entityUid: createUid,
        operationKind: 'entry.create',
        baseVersion: 0,
        baseValues: {},
        clientCreatedAt: new Date().toISOString(),
        payload: {
          title: draft.title.trim(),
          type: targetType.trim(),
          uploadDate: draft.uploadDate,
          pageCount: draft.pageCount,
          ...(draft.durationSeconds === null ? {} : { durationSeconds: draft.durationSeconds }),
          ratings: draft.ratings.flatMap((rating) => (
            rating.stars === null ? [] : [{ slotId: rating.slotId, stars: rating.stars }]
          )),
          viewLater: draft.viewLater,
          ...(contents.length ? { contents: contents.map((row, sortOrder) => ({
            syncUid: randomUuid(), contentType: row.contentType.trim(), content: row.content.trim(), sortOrder,
          })) } : {}),
        },
      };
      entryCreateAttempt = operation;
    }
    let result;
    try {
      result = await replay(operation);
    } catch (cause) {
      if (!isOfflineTransportError(cause)) throw cause;
      // The command may have committed; only its identical replay can tell.
      // A durable offline copy can carry that exact operation, so the queued
      // create resolves the ambiguity on reconnect instead of duplicating.
      await enqueueOffline(cause, operation);
      entryCreateAttempt = undefined;
      return { kind: 'enqueued-offline' };
    }
    // A receipt failure or an epoch mismatch is definitive: this opId can
    // never apply, so the attempt identity must not survive it.
    entryCreateAttempt = undefined;
    if (result.status === 'applied' && result.entityId !== undefined) {
      return { kind: 'created', entryId: result.entityId };
    }
    if (result.status === 'resnapshot-required') {
      throw new Error(t('entry.createCommandResnapshot'));
    }
    if (result.status === 'failed' && result.errorCode === 'invalid-create'
      && /existing Gallery/i.test(result.detail ?? '')) {
      // The typed Gallery name does not exist yet. The command channel keeps
      // the offline guarantee that a create uses an existing Gallery, so a
      // new Gallery goes back to the legacy request shape — allowed there,
      // and safe because the failed receipt proves nothing was created.
      return { kind: 'new-gallery' };
    }
    if (result.status === 'failed') {
      throw new Error(result.detail ?? t('error.createEntry'));
    }
    throw new Error(t('error.createEntry'));
  };
  try {
    if (props.offlineState?.mode === 'offline') {
      if (draft.openInEditor === true) {
        throw new Error(t('entry.advancedEditingRequiresConnection'));
      }
      const queued = await enqueueOffline();
      if (draft.authorName !== undefined && draft.authorName.trim() !== '' && queued !== undefined) {
        await props.api.enqueueOfflinePendingEntryAuthorCreate?.(queued, draft.authorName.trim());
      }
      creationView.value = null;
      await refreshAfterEntryCreate();
      return;
    }
    let supportsOnlineClaim = false;
    let capabilities: SyncCapabilities | undefined;
    try {
      capabilities = await props.api.getSyncCapabilities();
      supportsOnlineClaim = capabilities.featureFlags.onlineEntryCreateClaim === true;
    } catch (cause) {
      // No create request was sent; a transport failure is safe to queue directly.
      if (draft.openInEditor === true && isOfflineTransportError(cause)) {
        throw new Error(t('entry.advancedEditingRequiresConnection'));
      }
      await enqueueOffline(cause);
      creationView.value = null;
      await refreshAfterEntryCreate();
      return;
    }
    // After an uncertain claimed POST, a downgraded server must not receive a
    // no-UID legacy retry (nor convert this ambiguity into a new queued create).
    if (!supportsOnlineClaim && createUid !== undefined) {
      throw new Error(t('entry.legacyCreateUncertain'));
    }
    // The legacy request shape stays for servers without the atomic command
    // and for a newly typed Gallery: see the new-gallery fallback below.
    const legacyOnlineCreate = async (): Promise<'created' | 'enqueued-offline'> => {
      try {
        // A negotiated claim lets the online attempt and its uncertain-response
        // fallback share one identity. Older servers keep their legacy request shape.
        if (supportsOnlineClaim && createUid === undefined) {
          createUid = randomUuid();
          entryCreateAttemptUid = createUid;
        }
        createdId = (await props.api.createEntry({
          title: draft.title,
          type: targetType,
          ...(createUid === undefined ? {} : { syncUid: createUid }),
          uploadDate: draft.uploadDate,
          ...(draft.pageCount === null ? {} : { pageCount: draft.pageCount }),
          ...(draft.durationSeconds === null ? {} : { durationSeconds: draft.durationSeconds }),
        })).id;
        if (draft.authorName !== undefined && draft.authorName.trim() !== '') {
          await props.api.linkEntryAuthorByName?.(createdId, draft.authorName.trim());
        }
        return 'created';
      } catch (cause) {
        if (draft.openInEditor === true && isOfflineTransportError(cause)) {
          throw new Error(t('entry.advancedEditingRequiresConnection'));
        }
        if (!supportsOnlineClaim && isOfflineTransportError(cause)) {
          // The legacy POST may already have committed. No shared identity can
          // prove that an offline create would not make a second Entry.
          throw new Error(t('entry.legacyCreateUncertain'));
        }
        await enqueueOffline(cause);
        return 'enqueued-offline';
      }
    };
    let usedCreateCommand = false;
    if (capabilities !== undefined && capabilities.featureFlags.onlineEntryCreateCommand === true) {
      const outcome = await submitEntryCreateCommand(capabilities);
      if (outcome.kind === 'enqueued-offline') {
        creationView.value = null;
        await refreshAfterEntryCreate();
        return;
      }
      if (outcome.kind === 'new-gallery') {
        if (await legacyOnlineCreate() === 'enqueued-offline') {
          creationView.value = null;
          await refreshAfterEntryCreate();
          return;
        }
      } else {
        createdId = outcome.entryId;
        usedCreateCommand = true;
        if (draft.authorName !== undefined && draft.authorName.trim() !== '') {
          // The server resolves spellings through the producer vocabulary: an
          // existing Author (or an alias) is linked, a new name creates one.
          await props.api.linkEntryAuthorByName?.(createdId, draft.authorName.trim());
        }
      }
    } else {
      if (await legacyOnlineCreate() === 'enqueued-offline') {
        creationView.value = null;
        return;
      }
    }
    pendingEntryMedia.value = { entryId: createdId!, uploads: [
      ...(draft.coverFile ? [{ kind: 'cover' as const, file: draft.coverFile }] : []),
      ...draft.previewFiles.map((file) => ({ kind: 'preview' as const, file })),
    ] };
    while (pendingEntryMedia.value.uploads.length > 0) {
      const upload = pendingEntryMedia.value.uploads[0]!;
      await props.api.uploadEntryMedia(createdId!, upload.kind, upload.file);
      pendingEntryMedia.value.uploads.shift();
    }
    pendingEntryMedia.value = null;
    if (!usedCreateCommand) {
      // Legacy multi-request chain: the atomic command payload already carried
      // everything below, so only the older request shape writes them here.
      // The address the work was read from becomes the Entry's Source.
      // Content that contains its URL, which is how the import path stores one too — so this writes
      // the same kind of Content the import writes, under the same content type.
      if (draft.sourceUrl) {
        await props.api.createEntryContent(createdId!, {
          contentType: 'Source URL',
          content: draft.sourceUrl,
        });
      }
      for (const content of draft.contents ?? []) {
        await props.api.createEntryContent(createdId!, content);
      }
      for (const rating of draft.ratings) {
        if (rating.stars === null) continue;
        await props.api.setEntryRating(createdId!, rating.slotId, rating.stars);
      }
      if (draft.viewLater) await addEntriesToViewLater(props.api, [createdId!]);
    }
    await refreshAfterEntryCreate();
    // Jump straight into the freshly created Entry for a quick check.
    creationView.value = null;
    await refreshAuthors();
    await viewEntry(createdId!);
    // Handed over from the composer's template button: open the new work's
    // editor, where an existing template is already applied and a missing one is
    // visible as the empty structure it still needs.
    if (draft.openInEditor === true && activeEntry.value?.id === createdId!) {
      startEditing();
    }
  } catch (cause) {
    if (createdId !== undefined) {
      // The server already created this Entry; retrying the composer would duplicate it.
      creationView.value = null;
      error.value = `${t('entry.createdButIncomplete', { id: createdId })} ${cause instanceof Error ? cause.message : t('error.createEntry')}`;
    } else {
      error.value = cause instanceof Error ? cause.message : t('error.createEntry');
    }
  } finally {
    submitting.value = false;
  }
}

async function submitAuthor(draft: CreateProducerRequest): Promise<void> {
  error.value = null;
  submitting.value = true;
  try {
    const created = await props.api.createAuthor(draft);
    await refreshAuthors();
    showAuthors();
    authorTarget.value = {
      authorId: created.id,
      authorName: created.name,
      directoryId: null,
      directoryName: null,
    };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createAuthor');
  } finally {
    submitting.value = false;
  }
}

async function finishImport(
  entryType: string,
  entryIds: number[] = [],
  viewLater = false,
  existingEntryIds: number[] = [],
  openInEditor = false,
): Promise<void> {
  if (viewLater) await addEntriesToViewLater(props.api, entryIds);
  creationView.value = null;
  batchReview.value = null;
  await Promise.all([refreshGalleries(), refreshAuthors()]);
  await refreshFacetFilterOptions();
  // What the run produced is both halves: the works it created and the ones the
  // library already had, which the folder it came from still says something about.
  if (openInEditor && entryIds.length > 0) {
    // The review's "create your own template": this Gallery had no structure to commit into, so the
    // work is created (without its Tags, which the review said) and opened where the structure is
    // built. Finishing that edit raises the app's own apply-to-all prompt — the same one the quick
    // page's template door ends at.
    await viewEntry(entryIds[0]!);
    if (activeEntry.value?.id === entryIds[0]) startEditing();
    return;
  }
  if (entryIds.length === 1 && existingEntryIds.length === 0) {
    await viewEntry(entryIds[0]!);
  } else if (entryIds.length + existingEntryIds.length > 0) {
    batchReview.value = {
      entryType,
      entryIds,
      existingEntryIds,
      warnings: existingEntryIds.length === 0
        ? []
        : [t('import.batchDuplicates', { count: existingEntryIds.length })],
      runId: ++batchReviewRunCounter,
    };
  } else {
    await selectGallery(entryType);
  }
}

// Temporary batch review: after a batch import the just-committed cards are
// shown as a throwaway gallery group. Everything is already persisted — this
// view is purely for a quick check. Leaving it (explicit button or switching
// to any other view) discards the group.
const batchReview = ref<{
  entryType: string;
  entryIds: number[];
  /** Works the run carried that the library already had: not reviewed again, but
   *  filed with the run so the folder they came from is recorded. */
  existingEntryIds: number[];
  warnings: string[];
  /** Distinct per batch run: the review's page key must not inherit the page a
   *  longer earlier batch of the same Gallery left in the navigation memory. */
  runId: number;
} | null>(null);
let batchReviewRunCounter = 0;

async function finishBatchImport(
  entryType: string,
  entryIds: number[] = [],
  viewLater = false,
  warnings: string[] = [],
  existingEntryIds: number[] = [],
): Promise<void> {
  // The batch "view later" checkbox applies to every committed item.
  if (viewLater) await addEntriesToViewLater(props.api, entryIds);
  if (entryIds.length + existingEntryIds.length > 0) {
    creationView.value = null;
    // The review is the only place a commit note survives: the Add Entry page
    // that produced it unmounts as soon as this view takes over.
    batchReview.value = {
      entryType,
      entryIds,
      existingEntryIds,
      warnings,
      runId: ++batchReviewRunCounter,
    };
    void refreshGalleries();
    void refreshAuthors();
    // A committed batch files tags, which is what the Gallery's filter row lists.
    void refreshFacetFilterOptions();
  }
}

async function openBatchReviewEntries(): Promise<GalleryEntrySummary[]> {
  const review = batchReview.value;
  if (!review) return [];
  // The run's own works first, then the ones the library already had: both were
  // part of what this folder held, and the review is where that is visible.
  const reviewIds = [...review.entryIds, ...review.existingEntryIds];
  if (reviewIds.length === 0) return [];
  // Load by ids alone: they are exact, while filtering by the Gallery type as
  // well would hide the whole group whenever that spelling drifts (a typed
  // `comic` that resolved to `Comic`, or a later rename).
  const loaded: GalleryEntrySummary[] = [];
  let page = 1;
  while (true) {
    const result = await props.api.queryEntryPage({
      conditions: [],
      authorIds: [],
      ratingConditions: [],
      ratingSort: null,
      usageConditions: [],
      usageSort: null,
      entryIds: reviewIds,
      sort: 'source-order',
      page,
      pageSize: 100,
    });
    loaded.push(...result.items);
    if (loaded.length >= result.total || result.items.length === 0) return loaded;
    page += 1;
  }
}

function completeBatchReview(): void {
  batchReview.value = null;
  pendingBatchReview.value = null;
}

function openEntryFromBatchReview(entryId: number): void {
  rememberReturnScroll();
  pendingBatchReview.value = batchReview.value;
  leaveAllViews(false, true);
  returnView.value = 'batch';
  void viewEntry(entryId).then(() => {
    if (activeEntry.value?.id !== entryId) discardReturnScroll();
  });
}

const batchReviewEntries = ref<GalleryEntrySummary[]>([]);
const batchReviewLoading = ref(false);
// Filing the run into a Collection outlives the one-time review, which is what a
// bulk import too large to check in one sitting needs.
const batchCollectionBusy = ref(false);
const batchCollectionTitle = ref<string | null>(null);
const batchCollectionEntryCount = ref(0);

async function saveBatchReviewAsCollection(): Promise<void> {
  const review = batchReview.value;
  if (review === null) return;
  // Created and already-present works are filed together: the folder the run came
  // from held both, and which of them was new is not what the Collection records.
  const entryIds = [...review.entryIds, ...review.existingEntryIds];
  if (entryIds.length === 0) return;
  batchCollectionBusy.value = true;
  error.value = null;
  try {
    const collection = await props.api.createTemporaryCollection(entryIds);
    batchCollectionTitle.value = collection.title;
    batchCollectionEntryCount.value = collection.entryCount;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.batchCollection');
  } finally {
    batchCollectionBusy.value = false;
  }
}

watch(batchReview, async (review) => {
  if (!review) {
    batchReviewEntries.value = [];
    return;
  }
  batchCollectionTitle.value = null;
  batchCollectionEntryCount.value = 0;
  batchReviewLoading.value = true;
  try {
    batchReviewEntries.value = await openBatchReviewEntries();
  } catch (cause) {
    batchReviewEntries.value = [];
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  } finally {
    batchReviewLoading.value = false;
  }
});

async function toggleActiveEntryViewLater(): Promise<void> {
  if (!activeEntry.value) return;
  error.value = null;
  try {
    await toggleViewLater(props.api, activeEntry.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

function handleWindowFocus(): void {
  void synchronizeViewLater();
}

onMounted(() => {
  touchOnly.value = touchOnlyDevice();
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleGlobalKeydown);
  const start = async (): Promise<void> => {
    startupMilestones.snapshotReadyAtMs ??= Math.round(performance.now());
    await initialize();
    startupComplete = true;
  };
  void (props.startupReady ?? Promise.resolve()).then(start, start);
});
onUnmounted(() => {
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener('popstate', handlePopState);
  window.removeEventListener('keydown', handleGlobalKeydown);
  document.body.classList.remove('t3-mobile-navigation-open');
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  document.documentElement.style.removeProperty('background-color');
  document.body.style.removeProperty('background-color');
});
</script>

<template>
  <div class="gallery-app" :data-theme="theme" :data-accent="accent">
    <header class="app-header">
      <div class="header-brand">
        <IconButton
          class="mobile-navigation-toggle"
          icon="menu"
          :label="t('navigation.open')"
          data-testid="mobile-navigation-toggle"
          :active="mobileNavigationOpen"
          :aria-expanded="mobileNavigationOpen"
          aria-controls="app-navigation"
          @click="openMobileNavigation"
        />
        <div class="app-title-copy">
          <p class="eyebrow">{{ t('app.tagline') }}</p>
          <h1>{{ t('gallery.title') }}</h1>
          <p class="subtitle">{{ t('gallery.subtitle') }}</p>
        </div>
      </div>
      <div class="header-controls">
        <IconButton
          icon="back"
          :label="t('navigation.back')"
          :disabled="!topBarBackEnabled"
          data-testid="top-bar-back"
          @click="navigateBackFromTopBar"
        />
        <button
          class="icon-button"
          type="button"
          data-testid="theme-toggle"
          :aria-label="t('theme.switch', { theme: t(`theme.${nextTheme}`) })"
          @click="theme = nextTheme"
        >
          <span :key="theme" class="theme-icon-swap">
            <AppIcon :name="theme === 'light' ? 'moon' : 'sun'" :size="20" />
          </span>
          <span class="icon-tooltip" aria-hidden="true">{{ t('theme.switch', { theme: t(`theme.${nextTheme}`) }) }}</span>
        </button>
        <IconButton
          icon="settings"
          :label="t('settings.open')"
          :active="settingsOpen"
          data-testid="settings-button"
          :aria-expanded="settingsOpen"
          @click="toggleSettings"
        />
        <section v-if="settingsOpen" ref="settingsPanelRoot" data-testid="settings-panel" class="settings-panel" :style="settingsPanelStyle">
          <h2>{{ t('settings.title') }}</h2>
          <label class="checkbox-label" data-testid="show-nsfw-toggle">
            <input v-model="showNsfw" type="checkbox">
            {{ t('settings.showNsfw') }}
          </label>
          <label>
            {{ t('settings.language') }}
            <select data-testid="language-select" :value="locale" @change="selectLocale">
              <option value="en">{{ t('settings.english') }}</option>
              <option value="zh-CN">{{ t('settings.chinese') }}</option>
            </select>
          </label>
          <label>
            {{ t('settings.rowsPerPage') }}
            <select data-testid="rows-per-page-select" v-model.number="rowsPerPage">
              <option v-for="option in rowsPerPageOptions" :key="option" :value="option">
                {{ t('settings.rowsPerPageValue', { count: option }) }}
              </option>
            </select>
          </label>
          <label>
            {{ t('settings.accent') }}
            <span class="accent-row" role="radiogroup" :aria-label="t('settings.accent')">
              <button
                v-for="preset in accentPresets"
                :key="preset"
                type="button"
                class="accent-swatch"
                :class="{ 'accent-swatch-active': accent === preset }"
                :data-testid="`accent-${preset}`"
                :aria-pressed="accent === preset"
                :aria-label="t(`settings.accent.${preset}`)"
                :title="t(`settings.accent.${preset}`)"
                :style="{ background: accentSwatchColors[preset] }"
                @click="accent = preset"
              />
            </span>
          </label>
          <!-- The mobile connection is a quick setting; the offline copy is not
               (it lives on the Advanced function page). -->
          <SecurePairingSettings />
          <button
            data-testid="advanced-entry"
            class="advanced-entry"
            type="button"
            @click="openAdvanced"
          >
            <span>{{ t('settings.advanced') }}</span>
            <small>{{ t('settings.advancedHint') }}</small>
          </button>
        </section>
      </div>
    </header>

    <div
      v-if="props.offlineState?.mode === 'offline'
        || props.offlineState?.connectionPhase
        || (props.offlineState?.pendingCount ?? 0) > 0
        || (props.offlineState?.conflictCount ?? 0) > 0
        || (props.offlineState?.failedCount ?? 0) > 0"
      class="offline-mode-banner"
      data-testid="offline-mode-banner"
      role="status"
    >
      <span v-if="props.offlineState?.connectionPhase === 'checking'" data-testid="offline-connection-status">{{ t('offline.checking') }}</span>
      <span v-if="props.offlineState?.connectionPhase === 'switching'" data-testid="offline-connection-status">{{ t('offline.switching') }}</span>
      <span v-if="props.offlineState?.connectionPhase === 'opening-copy'" data-testid="offline-connection-status">{{ t('offline.openingCopy') }}</span>
      <span v-if="props.offlineState?.connectionPhase === 'no-copy'" data-testid="offline-connection-status">{{ t('offline.noCopy') }}</span>
      <span v-if="props.offlineState?.mode === 'offline' && !props.offlineState?.connectionPhase">{{ t('offline.modeBanner') }}</span>
      <span v-if="(props.offlineState?.conflictCount ?? 0) > 0" data-testid="offline-conflict-count">
        {{ t('offline.conflictBanner', { count: props.offlineState?.conflictCount ?? 0 }) }}
      </span>
      <span v-if="(props.offlineState?.failedCount ?? 0) > 0" data-testid="offline-failed-count">
        {{ t('offline.failedBanner', { count: props.offlineState?.failedCount ?? 0 }) }}
      </span>
      <span v-if="(props.offlineState?.pendingCount ?? 0) > 0" data-testid="offline-pending-count">
        {{ t('offline.pendingBanner', { count: props.offlineState?.pendingCount ?? 0 }) }}
      </span>
      <button
        v-if="(props.offlineState?.conflictCount ?? 0) > 0 || (props.offlineState?.failedCount ?? 0) > 0"
        type="button"
        class="offline-discard-button"
        data-testid="offline-discard-blocked"
        @click="discardBlockedOfflineEdits()"
      >
        {{ t('offline.discardBlocked') }}
      </button>
      <button
        type="button"
        class="offline-diagnostics-button"
        data-testid="offline-diagnostics-toggle"
        @click="toggleOfflineDiagnostics()"
      >
        {{ t('diagnostics.toggle') }}
      </button>
      <section
        v-if="offlineDiagnosticsOpen"
        class="offline-diagnostics"
        data-testid="offline-diagnostics"
      >
        <div class="offline-diagnostics-actions">
          <strong>{{ t('diagnostics.title') }}</strong>
          <button type="button" @click="refreshOfflineDiagnostics()">{{ t('diagnostics.refresh') }}</button>
          <button type="button" @click="copyOfflineDiagnostics()">{{ t('diagnostics.copy') }}</button>
        </div>
        <pre>{{ offlineDiagnosticsText }}</pre>
      </section>
    </div>

    <main class="app-layout">
      <button
        v-if="mobileNavigationOpen"
        type="button"
        class="mobile-navigation-backdrop"
        data-testid="mobile-navigation-backdrop"
        :aria-label="t('navigation.close')"
        @click="closeMobileNavigation()"
      />
      <aside
        id="app-navigation"
        class="sidebar"
        :class="{ 'sidebar-open': mobileNavigationOpen }"
        data-testid="app-sidebar"
      >
        <div class="sidebar-mobile-header">
          <strong>{{ t('navigation.title') }}</strong>
          <IconButton
            icon="close"
            :label="t('navigation.close')"
            data-testid="mobile-navigation-close"
            @click="closeMobileNavigation()"
          />
        </div>
        <!-- Three doors that used to cost the list a row each: a search field, a Home row, and the
             exchange control. They sit in the heading's own row, so every row of height they gave up
             goes to the Galleries. -->
        <div class="section-heading">
          <h2>{{ t('gallery.yours') }}</h2>
          <div class="sidebar-tools">
            <button
              data-testid="sidebar-search"
              class="sidebar-tool"
              type="button"
              :aria-label="t('search.title')"
              :title="t('search.title')"
              @click="openSearch"
            >
              <AppIcon name="search" :size="20" />
            </button>
            <button
              data-testid="sidebar-home"
              class="sidebar-tool"
              type="button"
              :aria-label="t('home.nav')"
              :title="t('home.nav')"
              @click="showHome"
            >
              <AppIcon name="homepage" :size="20" />
            </button>
            <button
              data-testid="sidebar-exchange"
              class="sidebar-tool"
              :class="{ 'sidebar-tool-active': galleryOrdering }"
              type="button"
              :aria-label="t('gallery.reorder')"
              :title="t('gallery.reorder')"
              :aria-pressed="galleryOrdering"
              @click="galleryOrdering = !galleryOrdering"
            >
              <AppIcon name="exchange" :size="20" />
            </button>
          </div>
          <span>{{ visibleGalleries.length }}</span>
        </div>
        <p v-if="loading" class="muted">{{ t('gallery.loading') }}</p>
        <p v-else-if="galleries.length === 0 && authors.length === 0" class="empty-copy">
          {{ t('gallery.empty') }}
        </p>
        <nav v-else class="gallery-list" :aria-label="t('gallery.navigation')">
          <div
            v-for="gallery in visibleGalleries"
            :key="gallery.type"
            class="gallery-row"
          >
            <button
              type="button"
              class="gallery-link"
              :class="{ active: activeType === gallery.type }"
              :data-gallery-type="gallery.type"
              @click="selectGallery(gallery.type)"
            >
              <span>{{ gallery.type }}{{ gallery.nsfw ? ' 🔞' : '' }}</span>
              <span class="count">{{ gallery.entryCount }}</span>
            </button>
            <!-- The exchange control's own arrows, the ones the Collections page moves folders with:
                 shown only while the list is being ordered, so the ordinary sidebar stays a menu. -->
            <div v-if="galleryOrdering" class="gallery-order-controls">
              <button
                type="button"
                class="gallery-order-button"
                :data-testid="`gallery-move-up-${gallery.type}`"
                :aria-label="t('gallery.moveUp', { name: gallery.type })"
                :disabled="!canMoveGallery(gallery.type, -1)"
                @click.stop="moveGallery(gallery.type, -1)"
              >↑</button>
              <button
                type="button"
                class="gallery-order-button"
                :data-testid="`gallery-move-down-${gallery.type}`"
                :aria-label="t('gallery.moveDown', { name: gallery.type })"
                :disabled="!canMoveGallery(gallery.type, 1)"
                @click.stop="moveGallery(gallery.type, 1)"
              >↓</button>
            </div>
          </div>
        </nav>

        <!-- Everything from here down is pinned to the bottom of the sidebar, and the gallery list
             scrolls above it. Measured on a phone: with seven galleries the shortcuts and both
             buttons were pushed off the drawer entirely, so the common actions were unreachable
             exactly when the library grew. The pinned block is one piece with the sidebar (no gap,
             no second card) and the list slides under its top edge — see `.sidebar-pinned` in the
             styles. -->
        <div class="sidebar-pinned">
        <nav v-if="sidebarHasNavigation" class="sidebar-shortcuts" :aria-label="t('gallery.navigation')">
          <button
            v-if="authors.length > 0"
            data-testid="author-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: authorView }"
            @click="showAuthors"
          >
            <span>{{ t('author.navigation') }}</span>
            <span class="count" data-testid="author-navigation-count">{{ visibleAuthorCount }}</span>
          </button>
          <button
            data-testid="recent-view-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: recentView }"
            @click="showRecentView"
          >
            <span>{{ t('recent.title') }}</span>
          </button>
          <button
            data-testid="collections-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: collectionsView }"
            @click="showCollections"
          >
            <span>{{ t('collections.title') }}</span>
          </button>
          <button
            data-testid="random-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: randomView }"
            @click="showRandom"
          >
            <span>{{ t('random.title') }}</span>
          </button>
          <button
            data-testid="view-later-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: viewLaterView }"
            @click="showViewLater"
          >
            <span>{{ t('viewLater.title') }}</span>
            <span class="count" v-if="visibleViewLaterCount > 0" data-testid="view-later-navigation-count">{{ visibleViewLaterCount }}</span>
          </button>
        </nav>

        <div class="create-actions">
          <button
            data-testid="add-entry-navigation"
            class="primary-button"
            type="button"
            @click="openCreation('entry')"
          >
            {{ t('entry.new') }}
          </button>
        </div>
        </div>
      </aside>

      <section class="content-panel">
        <button v-if="pendingEntryMedia" data-testid="retry-entry-media" type="button" :disabled="submitting" @click="retryEntryMedia">
        {{ t('media.retryForEntry', { id: pendingEntryMedia.entryId }) }}
      </button>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <section v-if="nativePairingRequired" class="pairing-gate" data-testid="pairing-gate">
          <h2>{{ t('pairing.gateTitle') }}</h2>
          <p class="muted">{{ t('pairing.gateBody') }}</p>
          <ol>
            <li>{{ t('pairing.gateStepDesktop') }}</li>
            <li>{{ t('pairing.gateStepExpiry') }}</li>
          </ol>
          <button type="button" class="primary-button" data-testid="pairing-gate-scan" @click="openNativePairing">{{ t('pairing.gateScan') }}</button>
        </section>
        <SearchPage
          v-else-if="searchView"
          :api="api"
          :initial-query="searchQuery"
          :initial-scope="searchScope"
          :nsfw-entry-types="[...entryNsfwTypes]"
          @back="closeSearch"
          @open-entry="openEntryFromSearch"
          @open-author="openAuthorFromSearch"
          @open-tag="openTagFromSearch"
        />
        <AdvancedEditingPage
          v-else-if="advancedView"
          :api="api"
          :store="offlineStore"
          :online="props.offlineState?.mode !== 'offline' && props.offlineState?.connectionPhase !== 'no-copy'"
          @back="closeAdvanced"
          @authors-changed="refreshAuthors"
          @updated="reloadVisibleSurfaces"
        />
        <AddEntryPage
          v-else-if="creationView === 'entry'"
          :api="api"
          :authors="authors"
          :gallery-types="galleries.map((gallery) => gallery.type)"
          :galleries="galleries.map((gallery) => ({ type: gallery.type, nsfw: gallery.nsfw }))"
          :submitting="submitting"
          :submit-error="error"
          :offline-state="offlineState"
          @back="creationView = null"
          @submit="submitEntry"
          @imported="finishImport"
          @batch-imported="finishBatchImport"
        />
        <AddAuthorPage
          v-else-if="creationView === 'author'"
          :submitting="submitting"
          @back="showAuthors"
          @submit="submitAuthor"
        />
        <section v-else-if="tagResults" data-testid="tag-results" class="tag-results">
          <button type="button" class="back-button" @click="closeTagResults">
            {{ t('entry.back', {
              type: tagResults.kind === 'entry'
                ? (tagResults.sourceEntry?.title ?? t('search.title'))
                : tagResults.sourceAuthor.authorName,
            }) }}
          </button>
          <p class="eyebrow">{{ t(`tag.${tagResults.kind}Results`) }}</p>
          <h2 class="t3-library-text">{{ tagResults.tagName }}</h2>
          <p
            v-if="tagResults.kind === 'entry'"
            class="muted"
            data-testid="tag-results-count"
          >{{ t(tagResults.total === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', { count: tagResults.total }) }}</p>
          <p
            v-if="tagResults.kind === 'entry' && tagResults.total === 0
              || tagResults.kind === 'author' && tagResults.authors.length === 0"
            class="muted"
          >
            {{ t('tag.noResults') }}
          </p>
          <PagedCardGrid
            :items="pagedTagItems"
            :page-key="`tag:${tagResults.kind}:${tagResults.tagId}`"
            :total-items="tagResults.total"
            :external-page="tagResults.page"
            @update:page="changeEntryTagPage"
            @update:page-size="changeEntryTagPageSize"
            v-slot="{ items }"
          >
            <article
              v-for="entry in items.filter((item): item is GalleryEntrySummary => 'type' in item)"
              :key="`entry-${entry.id}`"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-tag-entry-id="entry.id"
                @click="openTagEntry(entry)"
              >
                <div class="entry-stack">
                  <LazyCardImage
                    v-for="(ref, stackIndex) in entryStackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="entryStackLayerStyle(stackIndex, entryStackLayers(entry).length)"
                    :src="api.assetUrl(entryCardMediaRef(ref))"
                    :alt="entry.title"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-if="entryStackLayers(entry).length === 0" class="entry-placeholder t3-library-text" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                  <span v-if="entry.likeCount > 0" class="entry-like-badge" data-testid="entry-like-badge">
                    👍 {{ entry.likeCount }}
                  </span>
                </div>
                <span class="entry-meta"><strong class="t3-library-text">{{ entry.title }}</strong><small>{{ entry.type }}</small></span>
              </button>
            </article>
            <article
              v-for="author in items.filter((item): item is { id: number; name: string } => !('type' in item))"
              :key="`author-${author.id}`"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-tag-author-id="author.id"
                @click="openTagAuthor(author)"
              >
                  <span class="entry-placeholder t3-library-text" aria-hidden="true">
                  {{ author.name.slice(0, 1).toUpperCase() }}
                </span>
                <span class="entry-meta"><strong class="t3-library-text">{{ author.name }}</strong></span>
              </button>
            </article>
          </PagedCardGrid>
        </section>
        <RecentViewPage
          v-else-if="recentView"
          :api="api"
          :initial-tab="recentViewTab"
          @active-tab-change="recentViewTab = $event"
          @open-entry="openEntryFromRecent"
        />
        <ViewLaterPage
          v-else-if="viewLaterView"
          :api="api"
          :initial-kind="viewLaterKind"
          :initial-tab="viewLaterTab"
          @active-tab-change="viewLaterTab = $event"
          @open-entry="openEntryFromViewLater"
          @open-author="openAuthorFromViewLater"
        />
        <CollectionsPage
          v-else-if="collectionsView"
          ref="collectionsPageRef"
          :api="api"
          @back="showHome"
          @open-entry="openEntryFromCollections"
          @open-author="openAuthorFromCollections"
        />
        <RandomPage
          v-else-if="randomView"
          :api="api"
          @open-entry="openEntryFromRandom"
          @open-author="openAuthorFromRandom"
          @open-tag="openTagFromRandom"
        />
        <section
          v-else-if="batchReview"
          data-testid="batch-review"
          class="gallery-view"
        >
          <div class="content-heading">
            <div>
              <p class="eyebrow">{{ t('import.batchReviewEyebrow') }}</p>
              <h2 data-testid="batch-review-title">{{ batchReview.entryType }}</h2>
            </div>
            <div class="content-heading-actions">
              <button
                data-testid="complete-batch-review"
                class="primary-button"
                type="button"
                @click="completeBatchReview"
              >
                {{ t('import.batchReviewComplete') }}
              </button>
              <button
                v-if="batchReview.entryIds.length + batchReview.existingEntryIds.length > 0"
                class="secondary-button"
                type="button"
                data-testid="batch-review-save-collection"
                :disabled="batchCollectionBusy || batchCollectionTitle !== null"
                @click="saveBatchReviewAsCollection"
              >
                {{ batchCollectionBusy
                  ? t('import.batchCollectionSaving')
                  : batchCollectionTitle === null
                    ? t('import.batchCollectionSave')
                    : t('import.batchCollectionSaved', { name: batchCollectionTitle }) }}
              </button>
            </div>
          </div>
          <p class="batch-review-notice" data-testid="batch-review-notice" role="status">
            {{ t('import.batchReviewNotice') }}
          </p>
          <p
            v-if="batchCollectionTitle !== null"
            class="batch-review-notice"
            data-testid="batch-review-collection-notice"
            role="status"
          >
            {{ t('import.batchCollectionNotice', {
              name: batchCollectionTitle,
              count: batchCollectionEntryCount,
            }) }}
          </p>
          <ul
            v-if="batchReview.warnings.length > 0"
            class="import-warnings"
            data-testid="batch-review-warnings"
          >
            <li v-for="warning in batchReview.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <p v-if="batchReviewLoading" class="muted">{{ t('import.preparing') }}</p>
          <PagedCardGrid v-else :items="batchReviewEntries" :page-key="`batch:${batchReview.entryType}:${batchReview.runId}`" v-slot="{ items }">
            <article
              v-for="entry in items"
              :key="entry.id"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-entry-id="entry.id"
                @click="openEntryFromBatchReview(entry.id)"
              >
                <div class="entry-stack">
                  <span v-if="(entry.coverRef || entry.previewRef) === null" class="entry-placeholder t3-library-text" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                  <LazyCardImage
                    v-else
                    class="entry-stack-image"
                    :src="api.assetUrl(entryCardMediaRef(entry.coverRef ?? entry.previewRef ?? ''))"
                    :alt="entry.title"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <span class="entry-meta">
                  <strong class="t3-library-text">{{ entry.title }}</strong>
                  <small>{{ entry.type }}</small>
                  <small
                    v-if="batchReview.existingEntryIds.includes(entry.id)"
                    class="entry-usage-note"
                    data-testid="batch-review-existing"
                  >
                    {{ t('import.batchReviewExisting') }}
                  </small>
                </span>
              </button>
            </article>
          </PagedCardGrid>
        </section>
        <AuthorPage
          v-else-if="authorView"
          ref="authorPageRef"
          :api="api"
          :authors="authors"
          :initial-author-id="authorTarget?.authorId ?? null"
          :initial-directory-id="authorTarget?.directoryId ?? null"
          :initial-return-scroll-positions="authorReturnScrollPositions"
          :restore-initial-scroll="authorRestoreInitialScroll"
          :back-label="authorTagOrigin
            ? t('entry.back', { type: authorTagOrigin.tagName })
            : authorSearchOrigin !== null
              ? t('entry.back', { type: t('search.title') })
              : returnView === 'viewLater'
                ? t('entry.back', { type: t('viewLater.title') })
                : null"
          @open-entry="openEntryFromAuthor"
          @open-tag="openAuthorTag"
          @back="restoreAuthorTagResults"
          @authors-changed="refreshAuthors"
          @works-changed="refreshWorksAndAuthors"
        />
        <article
          v-else-if="activeEntry"
          data-testid="entry-detail"
          class="entry-detail"
          :data-edit-mode="String(editingEntry)"
        >
          <div class="detail-toolbar">
            <button data-testid="entry-back" class="back-button" type="button" @click="closeEntry">
              {{ t('entry.back', { type: entryBackTarget }) }}
            </button>
            <div class="detail-toolbar-actions" data-testid="detail-actions">
              <template v-if="editingEntry">
                <button
                  data-testid="finish-entry-editing"
                  class="secondary-button toolbar-action-primary"
                  type="button"
                  @click="finishEditing"
                >
                  {{ t('entry.done') }}
                </button>
                <button
                  data-testid="save-template-button"
                  class="secondary-button"
                  type="button"
                  :disabled="templateBusy"
                  @click="saveLayoutTemplate"
                >
                  {{ templateBusy
                    ? t('template.applying')
                    : armedKey === 'save-template' ? t('template.applyConfirmShort', { type: activeEntry?.type }) : t('template.save') }}
                </button>
                <button
                  data-testid="apply-tag-layout-button"
                  class="secondary-button"
                  type="button"
                  :disabled="tagLayoutBusy"
                  @click="applyActiveEntryTagLayout"
                >
                  {{ tagLayoutBusy
                    ? t('tagLayout.applying')
                    : armedKey === 'apply-tag-layout' ? t('tagLayout.applyConfirmShort', { type: activeEntry?.type }) : t('tagLayout.save') }}
                </button>


                <button
                  data-testid="media-edit-toggle"
                  class="secondary-button"
                  :class="{ 'toolbar-action-primary': mediaEditMode }"
                  type="button"
                  :disabled="mediaSaving || mediaSlides.length === 0"
                  :aria-pressed="mediaEditMode"
                  @click="mediaEditMode = !mediaEditMode"
                >{{ mediaEditMode ? t('media.editDone') : t('media.editPreviews') }}</button>
                <button
                  data-testid="delete-entry"
                  class="secondary-button danger-button"
                  :class="{ 'armable-armed': armedKey === 'delete-entry' }"
                  type="button"
                  @click="deleteActiveEntry"
                >
                  {{ armedKey === 'delete-entry' ? t('entry.deleteConfirmShort') : t('entry.delete') }}
                </button>
              </template>
              <IconButton
                v-else
                icon="edit"
                :label="t('entry.edit')"
                data-testid="start-entry-editing"
                @click="startEditing"
              />
              <button
                data-testid="like-entry-button"
                class="icon-button icon-button--thumb-up"
                type="button"
                :aria-label="t('a11y.likeEntry')"
                @click="onLikeClick"
              >
                <span :key="likeAnimationKey" class="like-icon-feedback">
                  <AppIcon name="thumb-up" :size="20" />
                </span>
                <span class="icon-tooltip" aria-hidden="true">{{ t('a11y.likeEntry') }}</span>
              </button>
              <div ref="entryCollectionRoot" class="add-to-collection" data-testid="entry-add-to-collection">
                <IconButton
                  icon="folder-plus"
                  :label="t('a11y.addToCollection')"
                  :active="entryCollectionMenuOpen"
                  aria-haspopup="menu"
                  :aria-expanded="entryCollectionMenuOpen"
                  :aria-controls="entryCollectionMenuOpen ? 'entry-collection-menu' : undefined"
                  @click="toggleEntryCollectionMenu"
                />
                <div
                  v-if="entryCollectionMenuOpen"
                  id="entry-collection-menu"
                  class="add-to-collection-menu"
                  :class="{ 'drop-up': entryCollectionDropUp }"
                  :style="entryCollectionMenuStyle"
                  role="menu"
                >
                  <p v-if="entryCollectionOptions.length === 0" class="muted">
                    {{ t('collections.empty') }}
                  </p>
                  <button
                    v-for="collection in entryCollectionOptions"
                    :key="collection.id"
                    type="button"
                    role="menuitemcheckbox"
                    class="add-to-collection-option t3-library-text"
                    :class="{ 'is-member': entryCollectionIds.includes(collection.id) }"
                    :aria-checked="entryCollectionIds.includes(collection.id)"
                    :title="entryCollectionIds.includes(collection.id)
                      ? t('collections.leaveHint')
                      : t('collections.joinHint')"
                    @click="toggleEntryCollection(collection)"
                  >
                    {{ entryCollectionIds.includes(collection.id) ? '✓ ' : '' }}{{ collection.title }}
                  </button>
                </div>
              </div>
              <IconButton
                :icon="activeEntryInViewLater ? 'view-later-check' : 'view-later'"
                :label="activeEntryInViewLater ? t('entry.viewLaterRemove') : t('entry.viewLater')"
                :active="activeEntryInViewLater"
                :aria-pressed="activeEntryInViewLater"
                data-testid="view-later-button"
                @click="toggleActiveEntryViewLater"
              />
            </div>
          </div>
          <p v-if="templateNotice" class="template-notice" data-testid="template-notice" role="status">
            {{ templateNotice }}
          </p>
          <p v-if="multiAuthorNotice" class="template-notice" data-testid="multi-author-notice" role="status">
            {{ multiAuthorNotice }}
          </p>
          <p v-if="tagLayoutNotice" class="template-notice" data-testid="tag-layout-notice" role="status">
            {{ tagLayoutNotice }}
          </p>
          <p class="eyebrow">{{ activeEntry.type }}</p>
          <div class="detail-heading">
            <input
              v-if="entryTitleEditorOpen"
              ref="entryTitleInput"
              v-model="entryTitleDraft"
              data-testid="entry-title-input"
              class="entry-title-input"
              type="text"
              required
              :disabled="entryTitleSaving"
              :aria-label="t('entry.title')"
              @keydown.enter.prevent="saveEntryTitle"
              @keydown.escape.prevent="cancelEntryTitleEdit"
              @blur="saveEntryTitle"
            >
            <h2
              v-else
              data-testid="entry-title"
                          class="t3-library-text"
                          :class="{ 'editable-entry-title': editingEntry }"
              :title="editingEntry ? t('entry.renameHint') : undefined"
              @dblclick="beginEntryTitleEdit"
            >{{ activeEntry.title }}</h2>
            <span
              class="detail-usage-stats"
              data-testid="entry-usage-stats"
            >
              <span class="detail-usage-count">{{ t('usage.viewCount', { count: activeEntry.usage.viewCount }) }}</span>
              <span
                v-if="activeEntry.usage.likeCount > 0"
                class="detail-usage-count"
                data-testid="entry-like-count"
              >👍 {{ activeEntry.usage.likeCount }}</span>
              <span
                v-if="activeEntry.usage.lastViewedAt"
                class="detail-usage-date"
              >{{ t('usage.lastViewed', { date: formatDate(activeEntry.usage.lastViewedAt) }) }}</span>
            </span>
          </div>

          <div
            v-if="mediaSlides.length > 0 || mediaAddAvailable"
            ref="mediaViewerRoot"
            class="entry-media-viewer"
            :class="{ 'is-empty': mediaSlides.length === 0, expanded: mediaExpanded }"
          >
            <!-- Expanded (desktop): every image in one row, left to right, the
                 cover's own height setting the strip's. -->
            <div
              v-if="mediaExpanded && desktopMedia && mediaSlides.length > 0"
              class="entry-media-strip"
              :style="mediaStripHeight === null ? undefined : { height: `${mediaStripHeight}px` }"
            >
              <div v-for="(ref, index) in mediaSlides" :key="ref" class="entry-media-slide">
                <LazyCardImage
                  class="entry-media-image"
                  :src="api.assetUrl(ref)"
                  :alt="activeEntry?.title ?? ''"
                  :refresh-token="mediaRevision"
                />
                <template v-if="mediaEditMode">
                  <button
                    class="media-delete"
                    type="button"
                    data-testid="media-delete"
                                        :disabled="mediaSaving || !!mediaRemovalBlockReason"
                    :aria-label="t('media.delete')"
                    @click="removeMediaAt(index)"
                  >
                    <AppIcon name="delete" :size="20" />
                  </button>
                  <!-- Swapping is what renames the files on the server, so it is
                       offered where the whole strip is visible. -->
                  <button
                    v-if="index > 0"
                    class="media-nav media-move-prev"
                    type="button"
                    data-testid="media-move-prev"
                                        :disabled="mediaSaving || !!mediaRemovalBlockReason"
                    :aria-label="t('media.moveEarlier')"
                    @click="swapMedia(index, -1)"
                  >‹</button>
                  <button
                    v-if="index < mediaSlides.length - 1"
                    class="media-nav media-move-next"
                    type="button"
                    data-testid="media-move-next"
                                        :disabled="mediaSaving || !!mediaRemovalBlockReason"
                    :aria-label="t('media.moveLater')"
                    @click="swapMedia(index, 1)"
                  >›</button>
                </template>
                <!-- Inside the last image's right edge, so a full strip has no
                     white gutter and reads symmetric. -->
                <button
                  v-if="index === mediaSlides.length - 1"
                  class="media-collapse"
                  type="button"
                  data-testid="media-collapse"
                  :aria-label="t('media.collapse')"
                  @click="closeMediaExpanded"
                >
                  <AppIcon name="collapse" :size="20" />
                </button>
              </div>
            </div>
            <template v-else>
              <button
                v-if="mediaSlides.length === 0"
                class="media-add-empty"
                type="button"
                data-testid="media-add-empty"
                :disabled="mediaUploading"
                :aria-label="t('media.add')"
                @click="requestMediaUpload"
              >
                <AppIcon name="add" :size="24" />
              </button>
              <template v-else>
                <!-- The frame is exactly as wide as the picture, so the pager,
                     counter and delete always sit ON the picture rather than in
                     whatever space the viewer has left over. -->
                <div class="entry-media-frame">
                <LazyCardImage
                  class="entry-media-image"
                  :src="api.assetUrl(mediaSlides[mediaIndex] ?? '')"
                  :alt="activeEntry?.title ?? ''"
                  :refresh-token="mediaRevision"
                  keep-last-on-src-change
                />
                <button
                  v-if="mediaSlides.length > 1 && mediaIndex > 0"
                  class="media-nav media-prev"
                  type="button"
                  :aria-label="t('media.previous')"
                  @click="mediaPrevious"
                >‹</button>
                <button
                  v-if="mediaSlides.length > 1 && mediaIndex < mediaSlides.length - 1"
                  class="media-nav media-next"
                  type="button"
                  :aria-label="t('media.next')"
                  @click="mediaNext"
                >›</button>
                <span v-if="mediaSlides.length > 1" class="media-count">
                  {{ mediaIndex + 1 }} / {{ mediaSlides.length }}
                </span>
                <!-- A phone has no strip mode: the add and delete controls float
                     on the cover's centre, add first. -->
                <button
                  v-if="mediaAddAvailable && !desktopMedia"
                  class="media-add-floating"
                  :class="{ 'with-delete': mediaEditMode }"
                  type="button"
                  data-testid="media-add-floating"
                  :disabled="mediaUploading"
                  :aria-label="t('media.add')"
                  @click="requestMediaUpload"
                >
                  <AppIcon name="add" :size="24" />
                </button>
                <button
                  v-if="mediaEditMode"
                  class="media-delete"
                  :class="{ 'floating': !desktopMedia }"
                  type="button"
                  data-testid="media-delete"
                                      :disabled="mediaSaving || !!mediaRemovalBlockReason"
                  :aria-label="t('media.delete')"
                  @click="removeMediaAt(mediaIndex)"
                >
                  <AppIcon name="delete" :size="20" />
                </button>
                </div>
              </template>
            </template>
            <!-- Outside the image, mid-height: the marked position. -->
            <button
              v-if="desktopMedia && mediaSlides.length > 1 && !mediaExpanded"
              class="media-expand"
              type="button"
              data-testid="media-expand"
              :aria-label="t('media.expand')"
              @click="openMediaExpanded"
            >
              <AppIcon name="expand" :size="20" />
            </button>
            <!-- Right of the expand control in edit mode, and plain when this
                 work has no cover yet (that button is the placeholder). -->
            <button
              v-if="mediaAddAvailable && desktopMedia && mediaSlides.length > 0"
              class="media-add-slot"
              type="button"
              data-testid="media-add-slot"
              :disabled="mediaUploading"
              :aria-label="t('media.add')"
              @click="requestMediaUpload"
            >
              <AppIcon name="add" :size="24" />
            </button>
            <p v-if="mediaEditMode && mediaRemovalBlockReason" data-testid="media-removal-reason" role="status">{{ mediaRemovalBlockReason }}</p>
            <p v-if="mediaUploadError" class="media-add-error" role="alert">{{ mediaUploadError }}</p>
          </div>
          <input
            ref="mediaAddInput"
            class="media-add-file"
            type="file"
            accept="image/*"
            data-testid="media-add-file"
            @change="chooseMediaUpload"
          >

          <section v-if="activeEntry.producers.length || editingEntry" class="detail-section">
            <h3>{{ t('entry.producers') }}</h3>
            <div class="chip-row">
              <template v-for="producer in activeEntry.producers" :key="producer.id">
                <button
                  v-if="!editingEntry"
                  type="button"
                  class="detail-chip detail-chip-link t3-library-text"
                  :data-entry-author-id="producer.id"
                  @click="openAuthorFromEntry(producer.id)"
                >
                  {{ producer.name }}
                </button>
                <span
                  v-else
                  class="detail-chip t3-library-text"
                  :data-entry-author-id="producer.id"
                >
                  {{ producer.name }}
                  <button
                    type="button"
                    class="remove-tag-button"
                    :data-unlink-author-id="producer.id"
                    :aria-label="t('author.unlink', { name: producer.name })"
                    @click="unlinkAuthor(producer.id)"
                  >×</button>
                </span>
              </template>
              <button
                v-if="editingEntry && !authorEditorOpen"
                data-testid="add-entry-author"
                type="button"
                class="add-button add-tag-button"
                @click="authorEditorOpen = true"
              >
                {{ t('author.new') }}
              </button>
              <form
                v-else-if="editingEntry"
                data-testid="create-entry-author-form"
                class="compact-editor"
                @submit.prevent="createAndLinkAuthor"
              >
                <input
                  v-model="newAuthorName"
                  name="authorName"
                  :size="inlineInputSize(newAuthorName)"
                  required
                  autocomplete="off"
                  :placeholder="t('author.namePlaceholder')"
                  @keydown.enter.prevent="createAndLinkAuthor"
                  @blur="newAuthorName.trim() && createAndLinkAuthor()"
                >
              </form>
              <p
                v-if="editingEntry && authorEditorOpen && authorDuplicateNames.length > 0"
                data-testid="create-author-duplicate-warning"
                class="author-duplicate-warning"
              >
                {{ t('author.duplicateWarning', { names: authorDuplicateNames.join(', ') }) }}
              </p>
              <button
                v-if="editingEntry && !authorLinkEditorOpen"
                data-testid="link-entry-author"
                type="button"
                class="add-button add-tag-button"
                @click="authorLinkEditorOpen = true"
              >
                {{ t('author.linkExisting') }}
              </button>
              <button
                v-if="editingEntry && convertibleAuthorCount > 0"
                data-testid="convert-multi-author"
                type="button"
                class="add-button add-tag-button"
                :disabled="multiAuthorBusy"
                :title="t('entry.multiAuthorHint', { name: multiAuthorProducerName })"
                @click="convertEntryAuthors"
              >
                {{ t('entry.multiAuthor', { count: convertibleAuthorCount }) }}
              </button>
            </div>
            <div
              v-if="editingEntry && authorLinkEditorOpen"
              data-testid="link-existing-author-form"
              class="compact-editor author-link-editor"
            >
              <SuggestionInput
                mode="id-only"
                name="existingAuthorName"
                :provider="suggestAuthors"
                :exclude-ids="linkedAuthorIds"
                :aria-label="t('author.chooseExisting')"
                :placeholder="t('author.chooseExisting')"
                @select="(suggestion) => linkExistingAuthor(suggestion.id)"
              />
            </div>
          </section>

          <div data-testid="entry-information-board" class="information-board">
            <p v-if="editingEntry" data-testid="tag-move-hint" class="tag-move-hint">
              {{ touchOnly ? t('tag.moveHintTouch') : t('tag.moveHintDrag') }}
            </p>
            <!-- A work's own facts — its page count, a video's runtime, its date — sit at the right
                 of the FIRST Section's title, whatever that Section is called, and in this same place
                 when the work has no Section at all, so the position never depends on what a person
                 named things. -->
            <EntryStatsRow
              v-if="activeEntry.sections.length === 0"
              :api="api"
              :entry-id="activeEntry.id"
              :page-count="activeEntry.pageCount"
              :duration-seconds="activeEntry.durationSeconds"
              :upload-date="activeEntry.uploadDate"
                :editing="editingEntry"
                :show-empty="editingEntry"
                @saved="reloadActiveEntry"
              />
              <p v-if="activeEntry.sections.length === 0" class="information-empty">
              {{ t('information.empty') }}
            </p>
            <section
              v-for="(section, sectionIndex) in activeEntry.sections"
              :key="section.id"
              class="information-section"
              :data-section-id="section.id"
            >
              <header class="information-section-header">
                <div class="information-section-title">
                    <h3 v-if="editingSectionId !== section.id" class="t3-library-text">{{ section.name }}</h3>
                  <input
                    v-else
                    v-model="editingSectionName"
                    class="information-section-rename"
                    :data-rename-section-id="section.id"
                    :size="inlineInputSize(editingSectionName)"
                    required
                    autocomplete="off"
                    :aria-label="t('section.namePlaceholder')"
                    @click.stop
                    @keydown.enter.prevent="saveSectionRename(section.id)"
                    @keydown.esc.prevent="cancelSectionRename"
                    @blur="saveSectionRename(section.id)"
                  >
                  <!-- Edit mode only, and plain buttons: nothing here is revealed on hover, so a
                       touch screen reaches them the same way a mouse does. They sit beside the name
                       they act on, which leaves the right edge to the page count and the date —
                       where those have always been, and where they stay on a Section that has none. -->
                  <div v-if="editingEntry" class="information-section-actions">
                    <button
                      v-if="editingSectionId !== section.id"
                      type="button"
                      class="secondary-button section-action"
                      :data-rename-section-button="section.id"
                      @click.stop="startSectionRename(section)"
                    >{{ t('section.rename') }}</button>
                    <button
                      type="button"
                      class="secondary-button section-action"
                      :class="{ 'armable-armed': armedKey === `delete-section-${section.id}` }"
                      :data-delete-section-button="section.id"
                      :disabled="editingSectionId === section.id"
                      :title="armedKey === `delete-section-${section.id}` ? t('section.deleteConfirm', { name: section.name }) : undefined"
                      @click.stop="removeSection(section)"
                    >{{ armedKey === `delete-section-${section.id}` ? t('common.confirm') : t('section.delete') }}</button>
                  </div>
                </div>
                <!-- The row's right edge, as it always was. A work with none of these values shows
                     nothing here — unless "show empty facets" is on, which is the switch that already
                     reveals empty Facets, and then each missing value appears as its own chip. -->
                <span v-if="sectionIndex === 0" class="information-stats">
                  <EntryStatsRow
                    :api="api"
                    :entry-id="activeEntry.id"
                    :page-count="activeEntry.pageCount"
                    :duration-seconds="activeEntry.durationSeconds"
                    :upload-date="activeEntry.uploadDate"
                    :editing="editingEntry"
                    :show-empty="editingEntry"
                    @saved="reloadActiveEntry"
                  />
                </span>
              </header>
              <div class="facet-table">
                <div
                  v-for="(facet, facetIndex) in visibleFacets(section)"
                  :key="facet.id"
                  class="facet-row"
                  :data-facet-id="facet.id"
                  :data-unnamed-facet="String(facet.name.length === 0)"
                  :aria-label="facet.name || t('information.directTags', { section: section.name })"
                  @dragover.prevent
                  @drop="moveDraggedTag(facet.id)"
                >
                  <div class="facet-label-column" data-facet-label>
                        <span v-if="facet.name" class="facet-name t3-library-text">{{ facet.name }}</span>
                    <div
                      v-if="editingEntry && facet.name"
                      class="facet-sort-controls"
                    >
                      <button
                        :data-move-facet-up-id="facet.id"
                        type="button"
                        :disabled="facetIndex === 0"
                        :aria-label="t('facet.moveUp', { name: facet.name })"
                        @click.stop="moveFacet(section.id, facet.id, -1)"
                      >
                        ↑
                      </button>
                      <button
                        :data-move-facet-down-id="facet.id"
                        type="button"
                        :disabled="facetIndex === visibleFacets(section).length - 1"
                        :aria-label="t('facet.moveDown', { name: facet.name })"
                        @click.stop="moveFacet(section.id, facet.id, 1)"
                      >
                        ↓
                      </button>
                      <button
                        :data-delete-facet-id="facet.id"
                        class="facet-delete"
                        :class="{ 'armable-armed': armedKey === `delete-facet-${facet.id}` }"
                        type="button"
                        :aria-label="t('facet.delete', { name: facet.name })"
                        :title="armedKey === `delete-facet-${facet.id}` ? t('facet.deleteConfirm', { name: facet.name }) : undefined"
                        @click.stop="removeFacet(facet.id)"
                      >
                        {{ armedKey === `delete-facet-${facet.id}` ? t('common.confirm') : '×' }}
                      </button>
                    </div>
                  </div>
                  <div class="facet-tag-column" data-tag-column>
                    <div class="chip-row">
                      <template v-for="tag in facet.tags" :key="tag.id">
                        <button
                          v-if="!editingEntry"
                          type="button"
                          class="detail-chip detail-chip-link t3-library-text"
                          :data-detail-tag-id="tag.id"
                          @click="openEntryTag(tag)"
                        >
                          {{ tag.name }}
                        </button>
                        <span
                          v-else
                          class="detail-chip draggable-chip t3-library-text"
                          :class="{ 'tag-move-selected': selectedTagId === tag.id }"
                          :draggable="editingTagId !== tag.id"
                          :data-detail-tag-id="tag.id"
                          role="button"
                          :tabindex="editingTagId === tag.id ? -1 : 0"
                          :aria-pressed="selectedTagId === tag.id"
                          :aria-label="selectedTagId === tag.id
                            ? t('tag.removeSelection')
                            : t('tag.selectToMove', { name: tag.name })"
                          @click="toggleTagMoveSelection(tag.id, facet.id)"
                          @keydown.enter.prevent="toggleTagMoveSelection(tag.id, facet.id)"
                          @keydown.space.prevent="toggleTagMoveSelection(tag.id, facet.id)"
                          @dragstart="beginTagDrag(tag.id)"
                          @dragend="draggedTagId = null"
                          @dblclick="beginTagRename(tag)"
                        >
                          <input
                            v-if="editingTagId === tag.id"
                            v-model="editingTagName"
                            :data-rename-entry-tag-id="tag.id"
                            :size="inlineInputSize(editingTagName)"
                            required
                            autocomplete="off"
                            :aria-label="t('tag.rename')"
                            @click.stop
                            @dblclick.stop
                            @keydown.enter.prevent="saveTagRename(tag.id)"
                            @blur="saveTagRename(tag.id)"
                          >
                          <span v-else>{{ tag.name }}</span>
                          <button
                            type="button"
                            class="remove-tag-button"
                            :data-remove-entry-tag-id="tag.id"
                            :aria-label="t('tag.remove', { name: tag.name })"
                            @click.stop="removeTag(tag.id)"
                          >
                            ×
                          </button>
                        </span>
                      </template>
                      <button
                        v-if="editingEntry && tagEditorFacetId !== facet.id"
                        class="add-button add-tag-button"
                        type="button"
                        :data-add-tag-facet-id="facet.id"
                        @click="tagEditorFacetId = facet.id"
                      >
                        {{ t('tag.add') }}
                      </button>
                      <form
                        v-else-if="editingEntry"
                        class="compact-editor tag-editor"
                        :data-create-tag-facet-id="facet.id"
                        @submit.prevent
                      >
                        <SuggestionInput
                          mode="creatable-text"
                          name="tagName"
                          commit-on-blur
                          :provider="suggestEntryTags"
                          :exclude-ids="entryTagExcludeIds"
                          :aria-label="t('tag.namePlaceholder')"
                          :placeholder="t('tag.namePlaceholder')"
                          @select="(suggestion) => submitEntryTag(facet.id, suggestion.name)"
                          @submit-text="(text) => submitEntryTag(facet.id, text)"
                        />
                      </form>
                    </div>
                    <button
                      v-if="editingEntry
                        && selectedTagId !== null
                        && selectedTagFacetId !== facet.id"
                      type="button"
                      class="add-button tag-move-target"
                      :data-move-selected-tag-to-facet-id="facet.id"
                      @click="moveSelectedTag(facet.id)"
                    >
                      {{ t('tag.moveHere') }}
                    </button>
                  </div>
                </div>
              </div>
              <div
                v-if="editingEntry && visibleFacets(section).length === 0"
                class="facet-row empty-section-controls"
                :data-empty-section-controls="section.id"
              >
                <div class="facet-label-column">
                  <button
                    v-if="facetEditorSectionId !== section.id"
                    class="add-button"
                    type="button"
                    :data-add-facet-section-id="section.id"
                    @click="facetEditorSectionId = section.id"
                  >
                    {{ t('facet.add') }}
                  </button>
                  <form
                    v-else
                    class="compact-editor"
                    :data-create-facet-section-id="section.id"
                    @submit.prevent="createNamedFacet(section.id)"
                  >
                    <input
                      v-model="facetName"
                      name="facetName"
                      :size="inlineInputSize(facetName)"
                      required
                      autocomplete="off"
                      :placeholder="t('facet.namePlaceholder')"
                      @blur="facetName.trim() && createNamedFacet(section.id)"
                    >
                  </form>
                </div>
                <div class="facet-tag-column">
                  <button
                    v-if="emptyUnnamedFacetId(section) !== null
                      && tagEditorFacetId !== emptyUnnamedFacetId(section)"
                    class="add-button add-tag-button"
                    type="button"
                    :data-add-direct-tag-section-id="section.id"
                    @click="tagEditorFacetId = emptyUnnamedFacetId(section)"
                  >
                    {{ t('tag.add') }}
                  </button>
                  <form
                    v-else
                    class="compact-editor tag-editor"
                    :data-create-tag-facet-id="emptyUnnamedFacetId(section)"
                    @submit.prevent
                  >
                    <SuggestionInput
                      mode="creatable-text"
                      name="tagName"
                      commit-on-blur
                      :provider="suggestEntryTags"
                      :exclude-ids="entryTagExcludeIds"
                      :aria-label="t('tag.namePlaceholder')"
                      :placeholder="t('tag.namePlaceholder')"
                      @select="(suggestion) => submitEntryTag(emptyUnnamedFacetId(section)!, suggestion.name)"
                      @submit-text="(text) => submitEntryTag(emptyUnnamedFacetId(section)!, text)"
                    />
                  </form>
                </div>
              </div>
              <div v-else-if="editingEntry" class="add-facet-control">
                <button
                  v-if="facetEditorSectionId !== section.id"
                  class="add-button"
                  type="button"
                  :data-add-facet-section-id="section.id"
                  @click="facetEditorSectionId = section.id"
                >
                  {{ t('facet.add') }}
                </button>
                <form
                  v-else
                  class="compact-editor"
                  :data-create-facet-section-id="section.id"
                  @submit.prevent="createNamedFacet(section.id)"
                >
                  <input
                    v-model="facetName"
                    name="facetName"
                    :size="inlineInputSize(facetName)"
                    required
                    autocomplete="off"
                    :placeholder="t('facet.namePlaceholder')"
                    @blur="facetName.trim() && createNamedFacet(section.id)"
                  >
                </form>
              </div>
            </section>

            <div v-if="editingEntry" class="add-section-control">
              <button
                v-if="!sectionEditorOpen"
                data-testid="add-section-button"
                class="add-button"
                type="button"
                @click="sectionEditorOpen = true"
              >
                {{ t('section.add') }}
              </button>
              <form
                v-else
                data-testid="create-section-form"
                class="compact-editor"
                @submit.prevent="createSection"
              >
                <input
                  v-model="sectionName"
                  name="sectionName"
                  :size="inlineInputSize(sectionName)"
                  required
                  autocomplete="off"
                  :placeholder="t('section.namePlaceholder')"
                  @blur="sectionName.trim() && createSection()"
                >
              </form>
            </div>
          </div>

          <section
            v-if="activeEntry.ratings.length > 0 || editingEntry"
            data-testid="entry-ratings"
            class="detail-section rating-section"
          >
            <h3>{{ t('rating.title') }}</h3>
            <div class="rating-rows">
              <div
                v-for="row in activeEntry.ratings"
                :key="row.slotId"
                class="rating-row"
                :data-rating-slot-id="row.slotId"
              >
                        <span class="rating-name t3-library-text">{{ row.name }}</span>
                <!-- Left of the arrows, and a different thing from the × inside the star picker:
                     this removes the DIMENSION for the whole Gallery, that one clears this value. -->
                <button
                  v-if="editingEntry"
                  type="button"
                  class="rating-delete-button"
                  :data-delete-rating-slot-id="row.slotId"
                  :title="t('rating.deleteDimension')"
                  :aria-label="t('rating.deleteDimension')"
                  @click="beginRatingDelete(row.slotId, row.name)"
                >×</button>
                <span
                  v-if="editingEntry && activeEntry.ratings.length > 1"
                  class="rating-sort-controls"
                >
                  <button
                    type="button"
                    :data-move-rating-up-id="row.slotId"
                    :disabled="row.slotId === activeEntry.ratings[0]?.slotId"
                    :aria-label="t('rating.moveUp', { name: row.name })"
                    @click="moveRatingSlot(row.slotId, -1)"
                  >↑</button>
                  <button
                    type="button"
                    :data-move-rating-down-id="row.slotId"
                    :disabled="row.slotId === activeEntry.ratings[activeEntry.ratings.length - 1]?.slotId"
                    :aria-label="t('rating.moveDown', { name: row.name })"
                    @click="moveRatingSlot(row.slotId, 1)"
                  >↓</button>
                </span>
                <template v-if="editingEntry">
                  <span class="star-picker">
                    <span class="star-display">
                      <span class="star-display-base">★★★★★</span>
                      <span
                        class="star-display-fill"
                        :style="{ width: row.stars === null ? '0%' : `${(row.stars / 5) * 100}%` }"
                      >★★★★★</span>
                      <span class="star-picker-zones">
                        <button
                          v-for="half in 10"
                          :key="half"
                          type="button"
                          :data-set-stars="half / 2"
                          :aria-label="t('rating.set', { name: row.name, stars: half / 2 })"
                          @click="chooseEntryStars(row.slotId, half / 2)"
                        />
                      </span>
                    </span>
                    <button
                      v-if="row.stars !== null"
                      type="button"
                      class="remove-tag-button"
                      :data-clear-rating-slot-id="row.slotId"
                      :aria-label="t('rating.clear', { name: row.name })"
                      @click="clearEntryStars(row.slotId)"
                    >×</button>
                  </span>
                </template>
                <span v-else-if="row.stars !== null" class="star-display">
                  <span class="star-display-base">★★★★★</span>
                  <span
                    class="star-display-fill"
                    :style="{ width: `${(row.stars / 5) * 100}%` }"
                  >★★★★★</span>
                </span>
                <span v-else class="rating-unrated">{{ t('rating.unrated') }}</span>
              </div>
            </div>
            <div v-if="editingEntry" class="add-rating-control">
              <button
                v-if="!ratingEditorOpen"
                data-testid="add-rating-button"
                class="add-button"
                type="button"
                @click="ratingEditorOpen = true"
              >
                {{ t('rating.add') }}
              </button>
              <form
                v-else
                data-testid="create-rating-form"
                class="compact-editor"
                @submit.prevent="createRatingSlot"
              >
                <input
                  v-model="ratingName"
                  name="ratingName"
                  :size="inlineInputSize(ratingName)"
                  required
                  autocomplete="off"
                  :placeholder="t('rating.namePlaceholder')"
                  @blur="ratingName.trim() && createRatingSlot()"
                >
              </form>
            </div>
          </section>
          <section v-if="visibleContents.length > 0 || editingEntry" class="detail-section content-section">
            <h3>{{ t('content.title') }}</h3>
            <p v-if="visibleContents.length === 0" class="content-empty">
              {{ t('content.empty') }}
            </p>
            <div
              v-for="(content, contentIndex) in visibleContents"
              :key="content.id"
              class="content-item"
              :data-content-id="content.id"
            >
              <form
                v-if="editingContentId === content.id"
                :data-testid="`edit-content-form-${content.id}`"
                class="content-editor"
                @submit.prevent="saveContentEdit(content.id)"
              >
                <label>
                  {{ t('content.label') }}
                  <input
                    v-model="editingContentType"
                    name="contentType"
                    required
                    autocomplete="off"
                  >
                </label>
                <label>
                  {{ t('content.body') }}
                  <textarea v-model="editingContentBody" name="content" rows="4" />
                </label>
                <div class="content-editor-actions">
                  <button class="primary-button compact-submit" type="submit">
                    {{ t('content.save') }}
                  </button>
                  <button class="secondary-button" type="button" @click="cancelContentEdit">
                    {{ t('content.cancel') }}
                  </button>
                </div>
              </form>
              <template v-else>
                <div class="content-item-header">
                  <span>{{ content.contentType }}</span>
                  <div v-if="editingEntry" class="content-item-actions">
                    <button
                      class="content-action-button"
                      type="button"
                      :data-move-content-up-id="content.id"
                      :aria-label="t('content.moveUp', { label: content.contentType })"
                      :disabled="contentIndex === 0"
                      @click="moveContent(content.id, -1)"
                    >
                      ↑
                    </button>
                    <button
                      class="content-action-button"
                      type="button"
                      :data-move-content-down-id="content.id"
                      :aria-label="t('content.moveDown', { label: content.contentType })"
                      :disabled="contentIndex === visibleContents.length - 1"
                      @click="moveContent(content.id, 1)"
                    >
                      ↓
                    </button>
                    <button
                      class="content-action-button"
                      type="button"
                      :data-edit-content-id="content.id"
                      :aria-label="t('content.edit', { label: content.contentType })"
                      @click="beginContentEdit(content)"
                    >
                      {{ t('content.editAction') }}
                    </button>
                    <button
                      class="content-action-button danger-action"
                      type="button"
                      :data-delete-content-id="content.id"
                      :aria-label="t('content.delete', { label: content.contentType })"
                      @click="deleteContent(content.id)"
                    >
                      {{ t('content.deleteAction') }}
                    </button>
                  </div>
                </div>
                <a
                  v-if="isHttpUrl(content.content)"
                          class="content-link t3-library-text"
                  :href="content.content"
                  target="_blank"
                  rel="noopener noreferrer"
                  :data-source-url-content-id="content.id"
                  @click="openSourceUrl($event, content.content)"
                >{{ content.content }}</a>
                      <p v-else class="t3-library-text">{{ content.content }}</p>
              </template>
            </div>
            <div v-if="editingEntry" class="add-content-control">
              <button
                v-if="!contentEditorOpen"
                data-testid="add-content-button"
                class="add-button"
                type="button"
                @click="openContentEditor"
              >
                {{ t('content.add') }}
              </button>
              <form
                v-else
                data-testid="create-content-form"
                class="content-editor"
                @submit.prevent="createContent"
              >
                <!--
                  The kinds this Gallery already uses, so a work's `description` or `source url` is a
                  click rather than a spelling exercise. Kept as plain buttons in the form's own row:
                  the label field stays free text, and the chips only fill it.
                -->
                <div class="content-kind-chips" data-testid="content-kind-chips">
                  <button
                    v-for="kind in contentKindOptions"
                    :key="kind"
                    type="button"
                    class="content-kind-chip"
                    :class="{ 'content-kind-chip-active': contentType === kind }"
                    :data-content-kind="kind"
                    @click="contentType = kind"
                  >{{ kind }}</button>
                </div>
                <label>
                  {{ t('content.label') }}
                  <input
                    v-model="contentType"
                    name="contentType"
                    required
                    autocomplete="off"
                    :placeholder="t('content.typePlaceholder')"
                  >
                </label>
                <label>
                  {{ t('content.body') }}
                  <textarea
                    v-model="contentBody"
                    name="content"
                    rows="4"
                    required
                    :placeholder="t('content.bodyPlaceholder')"
                  />
                </label>
                <button class="primary-button compact-submit" type="submit">
                  {{ t('content.addAction') }}
                </button>
              </form>
            </div>
          </section>

        </article>
        <template v-else-if="activeType">
          <div class="content-heading">
            <div>
              <p class="eyebrow">{{ t('gallery.eyebrow') }}</p>
              <h2 data-testid="active-gallery-title">{{ activeType }}</h2>
            </div>
            <div class="content-heading-actions">
              <button
                data-testid="gallery-partition-toggle"
                class="secondary-button"
                type="button"
                @click="activeType && toggleGalleryPartition({ type: activeType, nsfw: galleries.find((g) => g.type === activeType)?.nsfw ?? false })"
              >
                {{ galleries.find((g) => g.type === activeType)?.nsfw ? t('gallery.sfwBadge') : t('gallery.nsfwBadge') }}
              </button>
              <label class="sort-control">
                <span>{{ t('gallery.sortLabel') }}</span>
                <select v-model="gallerySort" data-testid="gallery-sort">
                  <option value="date-desc">{{ t('gallery.sortDateNewest') }}</option>
                  <option value="date-asc">{{ t('gallery.sortDateOldest') }}</option>
                  <option value="title-asc">{{ t('gallery.sortTitleAz') }}</option>
                  <option value="title-desc">{{ t('gallery.sortTitleZa') }}</option>
                  <option value="random">{{ t('sort.random') }}</option>
                </select>
              </label>
              <span data-testid="gallery-entry-count">
                {{ galleryFilterActive
                  ? t('gallery.filteredCount', { shown: galleryResultTotal, total: galleryTotalCount })
                  : t(galleryResultTotal === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', {
                    count: galleryResultTotal,
                  }) }}
              </span>
            </div>
          </div>
          <div v-if="facetFilterOptions
            && (facetFilterOptions.facets.length > 0 || facetFilterOptions.allTags.length > 0)"
            class="gallery-filter-wrap"
          >
            <FacetFilterBar
              :options="facetFilterOptions"
              :model-value="facetFilters"
              @update:model-value="onFacetFiltersChange"
            />
          </div>
          <PagedCardGrid
            :items="sortedEntries"
            :page-key="`gallery:${activeType}`"
            :total-items="galleryResultTotal"
            :external-page="galleryPage"
            grid-testid="entry-list"
            @update:page="onGalleryPageChange"
            @update:page-size="onGalleryPageSizeChange"
            v-slot="{ items }"
          >
            <article
              v-for="entry in items"
              :key="entry.id"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-entry-id="entry.id"
                @click="openEntryFromGallery(entry.id)"
              >
                <div class="entry-stack">
                  <LazyCardImage
                    v-for="(ref, stackIndex) in entryStackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="entryStackLayerStyle(stackIndex, entryStackLayers(entry).length)"
                    :src="api.assetUrl(entryCardMediaRef(ref))"
                    :alt="entry.title"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-if="entryStackLayers(entry).length === 0" class="entry-placeholder t3-library-text" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                  <span v-if="entry.likeCount > 0" class="entry-like-badge" data-testid="entry-like-badge">
                    👍 {{ entry.likeCount }}
                  </span>
                </div>
                <span class="entry-meta">
                  <strong class="t3-library-text">{{ entry.title }}</strong>
                  <small>{{ entry.type }}</small>
                  <small
                    v-if="showUsageOnCards"
                    class="entry-usage-note"
                    data-testid="entry-usage-note"
                  >
                    {{ facetFilters.usageConditions.some((c) => c.field === 'lastViewed')
                      || facetFilters.usageSort?.field === 'lastViewed'
                      ? t('card.lastViewed', { date: entry.lastViewedAt ? formatDate(entry.lastViewedAt) : '—' })
                      : facetFilters.usageConditions.some((c) => c.field === 'likes')
                        || facetFilters.usageSort?.field === 'likes'
                        ? t('card.likeCount', { count: entry.likeCount })
                        : t('card.viewCount', { count: entry.viewCount }) }}
                  </small>
                </span>
              </button>
            </article>
          </PagedCardGrid>
        </template>
        <HomePage
          v-else-if="!loading && props.offlineState?.connectionPhase !== 'no-copy'"
          ref="homePageRef"
          :api="api"
          @open-entry="openEntryFromHome"
          @open-gallery="selectGallery"
          @create-entry="openCreation('entry')"
        />
        <p v-else-if="props.offlineState?.connectionPhase === 'no-copy'" data-testid="offline-unavailable" class="muted">
          {{ t('offline.noCopy') }}
        </p>
      </section>
    </main>

    <!-- Fixed on every view: the top bar scrolls away, so Back has to stay
         reachable, and the same has to hold for a long Gallery or Author page. -->
    <div class="floating-actions">
      <IconButton
        class="floating-action"
        icon="back"
        :label="t('navigation.back')"
        :disabled="!topBarBackEnabled"
        data-testid="floating-back"
        @click="navigateBackFromTopBar"
      />
      <IconButton
        class="floating-action"
        icon="arrow-up"
        :label="t('navigation.scrollTop')"
        data-testid="floating-scroll-top"
        @click="scrollToTop"
      />
    </div>

    <div v-if="deleteRatingTarget !== null" class="template-prompt-overlay" role="presentation">
      <section
        class="template-prompt-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('rating.deleteTitle', { name: deleteRatingTarget.name })"
        data-testid="rating-delete-confirmation"
      >
        <h2>{{ t('rating.deleteTitle', { name: deleteRatingTarget.name }) }}</h2>
        <p class="muted">{{ t('rating.deleteConfirm') }}</p>
        <div class="template-prompt-actions">
          <button
            type="button"
            class="secondary-button"
            data-testid="rating-delete-cancel"
            @click="deleteRatingTarget = null"
          >{{ t('rating.deleteCancel') }}</button>
          <button
            type="button"
            class="secondary-button danger-button"
            data-testid="rating-delete-confirm"
            @click="confirmRatingDelete"
          >{{ t('rating.deleteAction') }}</button>
        </div>
      </section>
    </div>

    <div v-if="templatePromptOpen" class="template-prompt-overlay" role="presentation">
      <section
        class="template-prompt-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('entry.templatePromptTitle')"
        data-testid="template-prompt"
      >
        <h2>{{ t('entry.templatePromptTitle') }}</h2>
        <p class="muted">
          {{ t('entry.templatePromptBody', { type: activeEntry?.type ?? '' }) }}
        </p>
        <div class="template-prompt-actions">
          <button
            type="button"
            class="primary-button"
            data-testid="template-prompt-apply"
            :disabled="templateBusy"
            @click="applyTemplateAndFinish"
          >
            {{ templateBusy ? t('template.applying') : t('entry.templatePromptApply') }}
          </button>
          <button
            type="button"
            class="secondary-button"
            data-testid="template-prompt-later"
            @click="dismissTemplatePrompt"
          >
            {{ t('entry.templatePromptLater') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.template-prompt-overlay { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 1rem; background: color-mix(in srgb, #000 58%, transparent); }
.template-prompt-dialog { display: grid; gap: 0.9rem; width: min(30rem, 100%); padding: 1.2rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-overlay); }
.template-prompt-dialog h2, .template-prompt-dialog p { margin: 0; }
.template-prompt-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
.gallery-app {
  min-height: 100vh;
  padding: clamp(1rem, 3vw, 2.5rem);
  color: var(--text-primary);
  background: var(--page-background);
}

.app-header,
.app-layout {
  width: min(76rem, 100%);
  margin-inline: auto;
}

.app-header,
.section-heading,
.content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.content-heading-actions { display: flex; align-items: center; gap: 0.75rem; }
.content-heading-actions > span { color: var(--text-muted); }
.gallery-filter-wrap { margin-bottom: 1rem; }
.sort-control { display: flex; align-items: center; gap: 0.35rem; color: var(--text-muted); font-size: 0.85rem; }
.sort-control select { min-height: var(--control-min-height); padding: 0.3rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-primary); background: var(--surface); font: inherit; }

.app-header { margin-bottom: 1.5rem; }
.header-brand { display: flex; min-width: 0; align-items: center; gap: 0.75rem; }
.app-title-copy { min-width: 0; }
.mobile-navigation-toggle,
.sidebar-mobile-header,
.mobile-navigation-backdrop { display: none; }
h1, h2, h3, p { margin-top: 0; }
/* The app-level "Galleries" heading steps back; the current page title below
   is the primary visual entry (icon brief §1.2 B). */
h1 { margin-bottom: 0.25rem; font-size: var(--font-size-app-title); font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; }
h2 { margin-bottom: 0; }
.subtitle, .muted, .empty-copy, .form-hint, .entry-card p, .content-heading > span { color: var(--text-muted); }
.subtitle { margin-bottom: 0; font-size: var(--font-size-secondary); line-height: 1.5; }
.eyebrow { margin-bottom: 0.35rem; color: var(--accent); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }

.gallery-link,
.primary-button {
  border: 1px solid var(--border-subtle);
  font: inherit;
  cursor: pointer;
}
.header-controls { position: relative; display: flex; align-items: center; gap: 0.5rem; }
.settings-panel { position: absolute; z-index: 10; top: calc(100% + 0.5rem); right: 0; box-sizing: border-box; width: min(36rem, calc(100vw - 2rem)); padding: 1rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-overlay); }
.settings-panel h2 { margin-bottom: 0.8rem; font-size: 1rem; }
.settings-panel label { display: grid; gap: 0.4rem; color: var(--text-muted); font-size: 0.8rem; font-weight: 700; }
.settings-panel .checkbox-label { display: flex; align-items: center; gap: 0.45rem; }
.settings-panel .checkbox-label input { width: 1rem; height: 1rem; margin: 0; }
.settings-panel select { width: 100%; padding: 0.55rem 0.65rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; }
.accent-row { display: flex; gap: 0.45rem; }
.accent-swatch { box-sizing: border-box; width: 1.7rem; height: 1.7rem; padding: 0; border: 2px solid transparent; border-radius: 50%; cursor: pointer; }
.accent-swatch-active { border-color: var(--text-primary); }
.advanced-entry { display: grid; gap: 0.15rem; width: 100%; margin-top: 0.9rem; padding: 0.65rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.6rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; }
.advanced-entry small { color: var(--text-muted); font-weight: 400; font-size: 0.72rem; }
.advanced-entry:hover, .advanced-entry:focus-visible { border-color: var(--accent); outline: none; }
.offline-mode-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0 0 0.75rem; padding: 0.65rem 0.85rem; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--text-primary); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); font-size: 0.84rem; }
.offline-discard-button, .offline-diagnostics-button, .offline-diagnostics-actions button { padding: 0.3rem 0.55rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-primary); background: var(--surface); cursor: pointer; }
.offline-discard-button { margin-left: auto; }
.offline-diagnostics-button { margin-left: auto; }
.offline-discard-button + .offline-diagnostics-button { margin-left: 0; }
.offline-diagnostics { flex: 1 0 100%; min-width: 0; }
.offline-diagnostics-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; margin-bottom: 0.45rem; }
.offline-diagnostics-actions strong { margin-right: auto; }
.offline-diagnostics pre { overflow: auto; max-height: 18rem; margin: 0; padding: 0.65rem; border-radius: var(--radius-control); background: var(--surface); font: 0.72rem/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; user-select: text; }
.pairing-gate { max-width: 34rem; margin: 3rem auto; padding: 1.25rem 1.5rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--surface); display: flex; flex-direction: column; gap: 0.75rem; }
.pairing-gate h2 { margin: 0; }
.pairing-gate p, .pairing-gate ol { margin: 0; padding-left: 1.25rem; }
.pairing-gate .primary-button { align-self: flex-start; }

.app-layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); gap: 1rem; }
.sidebar,
.content-panel { border: 1px solid var(--border-subtle); border-radius: var(--radius-panel); background: var(--surface); box-shadow: var(--shadow-panel); }
.sidebar { padding: 1rem; }
/* On a wide screen the sidebar keeps its own height and sticks to the top: the gallery list scrolls
   inside it, so the shortcuts and the button stay where they are however many galleries there are.
   Measured with seven galleries: the sidebar grew to 811px while the window was 800, which put "New
   Entry" 131px below the fold — the same complaint the phone's drawer had, one breakpoint up. */
@media (min-width: 44rem) {
  /* The shortcut rows are shorter here than on a phone: 44px is a touch target, and a mouse does not
     need one. That is what pays for the last gallery row — the sidebar's height is the window's, so
     every pixel the pinned block gives up goes to the list. */
  .sidebar-shortcuts .gallery-link { padding: 0.45rem 0.75rem; }
  .sidebar {
    position: sticky;
    top: 1rem;
    /* Its own height, not the row's: as a stretched grid item it grew or shrank with whatever page
       was beside it, and the list inside it moved with it. The sidebar is the same box on every page
       now, and a short list leaves room at the bottom rather than spreading itself out. */
    align-self: start;
    height: calc(100vh - 2rem);
    height: calc(100dvh - 2rem);
    /* The window, so the gallery list gets everything the pinned block does not need — measured at
       1280x800 with seven galleries: 420px, about eight and a half rows.
       The trade, stated rather than hidden: the sidebar's own top sits below the app header, so at the
       very top of the page its last ~100px is under the fold. One small scroll sticks it to the
       window's top edge (16px) and then the whole thing, pinned block included, is in view. */

  }
}
.content-panel { min-height: 30rem; padding: clamp(1rem, 3vw, 1.75rem); }

/* The heading's row now carries the three doors, so it is as tall as they are (44px, a touch
   target) — which ate most of the row the removed search field gave back. The margin and the list's
   own bottom padding are trimmed by the same reasoning, to hand the list a whole row rather than
   seven tenths of one: measured on a phone, the drawer's list went 340px -> 376px with the field
   gone, and these two give it the rest. */
.section-heading { margin-bottom: 0.45rem; }
/* One line, with the three doors in the same row: the title is short and the row is the sidebar's
   width, so wrapping it would only push the list down. */
.sidebar .section-heading h2 { white-space: nowrap; }
.section-heading h2 { font-size: 0.95rem; }
.section-heading > span, .count { color: var(--text-muted); font-size: 0.78rem; }
/* The three doors in the heading's own row — search, Home, and the exchange control. They used to
   cost the list a row each (a search field and a Home row); here they cost it nothing, and every row
   they gave up went to the Galleries. */
.sidebar-tools { display: flex; align-items: center; gap: 0.3rem; }
.sidebar-tool {
  display: inline-grid;
  place-items: center;
  width: var(--icon-button-size);
  height: var(--icon-button-size);
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--icon-muted);
  background: transparent;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease,
    border-color var(--transition-duration) ease, transform var(--transition-duration) ease;
}
.sidebar-tool:hover { color: var(--accent); background: var(--surface-hover); border-color: var(--border-strong); }
.sidebar-tool:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
/* Search and Home do their work at once, so the only thing left to say is that the finger landed. */
.sidebar-tool:active { transform: scale(0.9); }
/* The exchange control is a *mode*, so it says so and keeps saying it — the same applied look the
   view-later switches use, which is what "颜色加深表示状态应用" asks for. */
.sidebar-tool-active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.sidebar-tool-active:active { transform: none; }

/* A row is the Gallery and, while the list is being ordered, its two arrows. */
.gallery-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.15rem; }
.gallery-order-controls { display: grid; grid-template-columns: repeat(2, auto); gap: 0.1rem; }
.gallery-order-button {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--accent);
  background: transparent;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
}
.gallery-order-button:hover:not(:disabled), .gallery-order-button:focus-visible:not(:disabled) { background: var(--accent-soft); outline: none; }
.gallery-order-button:disabled { opacity: 0.3; cursor: default; }
/* The sidebar is one column: the heading stays put, the gallery list takes the middle
   and scrolls, and everything from the shortcuts down is pinned to the bottom. Measured on a phone
   with seven galleries: the shortcuts and both buttons were pushed off the drawer, so the common
   actions became unreachable exactly when the library grew. */
.sidebar { display: flex; flex-direction: column; min-height: 0; }
.gallery-list {
  display: grid;
  gap: 0.35rem;
  flex: 1 1 auto;
  min-height: 0;
  /* The rows keep their own height and the leftover space stays blank. Without this a grid stretches
     its rows to fill the box, so the same seven galleries sat 49px apart on one page and 54px apart
     on another — measured between Home and Search, where the sidebar's height differed and every row
     with it. A blank stretch under the last Gallery is the cheaper of the two: the spacing a person
     reads down is the same everywhere. */
  align-content: start;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /* Room for the last row to clear the wash below it, so scrolling to the end does not leave the
     last gallery half-dissolved — the wash fades from nothing, so a few pixels of overlap cost
     nothing and the row is worth more. */
  padding-bottom: 1rem;
}
/* Pinned: no gap and no second card, so it reads as part of the sidebar rather than a panel stuck
   to it. */
.sidebar-pinned { flex: 0 0 auto; display: grid; gap: 0.75rem; }
.sidebar-shortcuts { display: grid; gap: 0.35rem; }
/* The list slides *into* the pinned block rather than being cut off by it: a short fade in the
   sidebar's own colour on the block's top edge, which costs no layout space (the negative margin)
   and cannot be clicked through. */
.sidebar-pinned::before {
  content: '';
  display: block;
  height: 1.5rem;
  margin-top: -1.5rem;
  /* A faint wash of the theme colour along the boundary, fading up into the list, so a gallery
     passing it looks like it is tucking into the block below rather than being cut by it. Faint on
     purpose (a few percent): it should read as the pocket's mouth, not as a band of its own. The
     stops keep it in the accent's own family and land on the sidebar's surface, so it never becomes
     a visible edge against the panel. */
  background: linear-gradient(
    to bottom,
    transparent 0%,
    color-mix(in srgb, var(--accent) 5%, transparent) 45%,
    color-mix(in srgb, var(--accent) 13%, var(--surface)) 100%
  );
  /* The wash's own corners are rounded like everything else on the panel — the colour only reaches
     the bottom edge, so rounding the two bottom corners is what the eye reads as "rounded ends".
     `--radius-control`, the same step the rows above and the controls beside it use. */
  border-bottom-left-radius: var(--radius-control);
  border-bottom-right-radius: var(--radius-control);
  pointer-events: none;
}
.gallery-link { display: flex; justify-content: space-between; width: 100%; padding: 0.65rem 0.75rem; border-color: transparent; border-radius: 0.65rem; color: var(--text-primary); background: transparent; text-align: left; }
.gallery-link:hover, .gallery-link.active { color: var(--tag-text); background: var(--tag-background); border-color: var(--tag-border); }

.create-form { display: grid; gap: 0.8rem; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border-subtle); }
.create-form label { display: grid; gap: 0.35rem; font-size: 0.8rem; font-weight: 700; }
.create-form input { width: 100%; padding: 0.6rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.6rem; color: var(--text-primary); background: var(--surface-muted); }
.create-form input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 20%, transparent); }
.form-hint { margin: -0.2rem 0 0; font-size: 0.72rem; line-height: 1.45; }
.primary-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: var(--control-min-height); padding: 0.45rem 0.8rem; border-color: var(--accent); border-radius: var(--radius-control); color: white; background: var(--accent); font-weight: 750; transition: background-color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.primary-button:hover { background: var(--accent-hover); }
.primary-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.primary-button:disabled { cursor: wait; opacity: 0.65; }

.content-heading { margin-bottom: 1.25rem; }
.content-heading h2 { font-size: var(--font-size-page-title); font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
.entry-card { position: relative; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface-muted); }
.entry-card:hover, .entry-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.entry-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.entry-card-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.entry-placeholder { display: grid; min-height: 8rem; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.entry-stack { position: relative; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; background: var(--surface-muted); perspective: 28rem; perspective-origin: 50% 50%; transform-style: preserve-3d; }
.entry-stack-image { position: absolute; display: block; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent); border-radius: 0.15rem; box-shadow: 0 0.18rem 0.45rem rgb(15 23 42 / 16%); transform-style: preserve-3d; }
.entry-stack-image:first-child { box-shadow: 0 0.28rem 0.7rem rgb(15 23 42 / 22%); }
.entry-stack .entry-placeholder { height: 100%; }
.entry-media-viewer { position: relative; display: flex; align-items: center; gap: 0.4rem; margin: 1rem 0 1.25rem; max-width: 24rem; }
/* Sizes to the picture, never to the column: a portrait keeps its own width
   (no letterbox bars) and the controls keep the picture's edges. */
.entry-media-frame { position: relative; display: inline-flex; max-width: 100%; }
.entry-media-frame .entry-media-image { width: auto; max-width: 100%; height: auto; }
.entry-media-viewer.is-empty { max-width: 24rem; }
/* Expanded, the strip is allowed the whole content column — the measurement
   above divides exactly that width between the pictures. */
.entry-media-viewer.expanded { max-width: 100%; }
.entry-media-image { display: block; width: 100%; max-height: 24rem; object-fit: contain; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface-muted); }
.media-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 2.5rem; height: 2.5rem; border: 0; border-radius: 999px; color: #fff; background: rgb(0 0 0 / 55%); font-size: 1.25rem; line-height: 1; cursor: pointer; }
.media-prev { left: 0.5rem; }
.media-next { right: 0.5rem; }
.media-count { position: absolute; bottom: 0.5rem; right: 0.5rem; padding: 0.15rem 0.5rem; border-radius: 999px; color: #fff; background: rgb(0 0 0 / 55%); font-size: 0.75rem; }
/* The expand control sits outside the image at mid-height (the marked spot);
   the add slot follows it on the right, so the two never overlap. */
.media-expand, .media-add-slot, .media-collapse { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-muted); background: var(--surface); cursor: pointer; transition: color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.media-expand { flex: 0 0 auto; width: 2rem; height: 3rem; }
.media-expand:hover, .media-add-slot:hover, .media-collapse:hover, .media-add-empty:hover, .media-add-floating:hover { color: var(--accent); border-color: var(--accent); }
/* Same height as the image beside it, deliberately much narrower. */
.media-add-slot { flex: 0 0 auto; width: 2rem; height: 3rem; }
.media-add-empty { display: flex; align-items: center; justify-content: center; width: 100%; height: 12rem; border: 1px dashed var(--border-subtle); border-radius: var(--radius-card); color: var(--text-muted); background: var(--surface-muted); cursor: pointer; }
.media-add-floating { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem; border: 0; border-radius: 999px; color: #fff; background: rgb(0 0 0 / 55%); cursor: pointer; }
/* Inside the right edge of the last image, mirroring the pager arrows. */
.media-collapse { position: absolute; top: 50%; right: 0.5rem; transform: translateY(-50%); width: 2.5rem; height: 2.5rem; border: 0; border-radius: 999px; color: #fff; background: rgb(0 0 0 / 55%); }
/* Delete sits on the picture itself (any display mode); the move arrows reuse
   the pager's own circles so a strip of them reads as one control family. */
.media-delete { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem; border: 0; border-radius: 999px; color: #fff; background: rgb(0 0 0 / 55%); cursor: pointer; }
.media-delete:hover { background: rgb(150 20 20 / 75%); }
/* On a phone the add control moves up so the pair stays centred as one block. */
.media-add-floating.with-delete { top: calc(50% - 2.4rem); }
.media-delete.floating { top: calc(50% + 2.4rem); }
.media-move-prev { left: 0.5rem; }
.media-move-next { right: 0.5rem; }
.entry-media-slide .media-nav { top: 50%; }
.media-strip-note, .media-add-error { flex: 1 0 100%; }
.media-add-error { margin: 0; color: var(--danger, #b4232a); font-size: 0.85rem; }
.media-add-file { display: none; }
/* Widen past the single-image column so four images still fit. Each picture
   keeps its own proportion at the shared height — the measurement above made
   that height fit the column, so nothing is cropped and nothing is padded. */
.entry-media-strip { display: flex; align-items: stretch; gap: 0.5rem; width: 100%; max-width: 100%; }
.entry-media-slide { position: relative; flex: 0 0 auto; min-width: 0; height: 100%; }
.entry-media-slide .entry-media-image { height: 100%; width: auto; max-width: none; max-height: none; }
.entry-meta { display: grid; gap: 0.25rem; padding: 0.85rem; }
.entry-meta small { color: var(--text-muted); }
.secondary-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: var(--control-min-height); padding: 0.45rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.secondary-button:hover { border-color: var(--accent); }
.secondary-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.entry-detail > h2 { margin-bottom: 1.5rem; font-size: clamp(1.7rem, 4vw, 2.5rem); }
/* App-wide: the top bar scrolls away on any long page, so Back and scroll-to-top
   stay reachable. Back runs the same action (and disabled state) as the top-bar
   arrow rather than a second implementation. */
.floating-actions {
  position: fixed;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  z-index: 30;
  display: grid;
  gap: 0.5rem;
  justify-items: center;
}
.floating-action {
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
}
.floating-action:disabled { opacity: 0.4; cursor: default; }
.detail-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
.detail-toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.4rem; }
.detail-toolbar-actions .secondary-button { white-space: nowrap; }
.toolbar-action-primary { color: white; border-color: var(--accent); background: var(--accent); }
.toolbar-action-active { border-color: var(--accent); color: var(--accent); }
.template-notice { margin: -0.75rem 0 0.75rem; padding: 0.5rem 0.7rem; border-radius: 0.55rem; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font-size: 0.8rem; }
.batch-review-notice { margin: -0.4rem 0 1rem; padding: 0.7rem 0.85rem; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--text-primary); background: var(--accent-soft); font-size: 0.86rem; line-height: 1.5; }
.back-button { padding: 0; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.secondary-button { padding: 0.45rem 0.7rem; }
.detail-section { padding: 1rem 0; border-top: 1px solid var(--border-subtle); }
.detail-section h3 { margin-bottom: 0.75rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; }
.information-board { margin-top: 0.25rem; border-top: 1px solid var(--border-subtle); }
.information-empty { margin: 0; padding: 1rem 0; color: var(--text-muted); font-size: 0.8rem; }
.information-section { padding: 1.1rem 0; }
.information-section + .information-section { border-top: 1px dashed var(--border-subtle); }
.information-section-header h3 { margin-bottom: 0.55rem; font-size: 0.86rem; letter-spacing: 0.035em; }
.information-section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
/* The name and its edit-mode actions, together: the right edge of the row belongs to the stats. */
.information-section-title { display: inline-flex; align-items: center; gap: 0.6rem; min-width: 0; }
.information-section-actions { display: inline-flex; align-items: center; gap: 0.4rem; }
.section-action { padding: 0.3rem 0.7rem; font-size: 0.78rem; }
/* Renaming happens in the heading itself, so the input inherits the heading's weight and size. */
.information-section-rename { max-width: 100%; font: inherit; font-size: 0.86rem; letter-spacing: 0.035em; }
.information-stats { display: inline-flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; margin-bottom: 0.55rem; }
.information-stat { color: var(--text-muted); font-size: 0.78rem; }
/* The two values and their editors are `EntryStatsRow`; this is only where they are placed. */
.information-stats { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.9rem; }
.facet-table { display: grid; }
.facet-row { display: grid; grid-template-columns: minmax(6.5rem, 9.5rem) minmax(0, 1fr); min-height: 2.8rem; border-radius: 0.55rem; }
.facet-row:has(.draggable-chip:active) { background: var(--surface-muted); }
.facet-label-column { min-width: 0; padding: 0.65rem 0.9rem 0.65rem 0; border-right: 1px dashed color-mix(in srgb, var(--border-subtle) 58%, transparent); color: var(--text-muted); font-size: 0.76rem; line-height: 1.4; }
.facet-tag-column { min-width: 0; padding: 0.55rem 0 0.55rem 1rem; }
.facet-name { display: block; overflow-wrap: anywhere; }
.facet-sort-controls { display: inline-flex; align-items: center; gap: 0.15rem; margin-top: 0.3rem; }
.facet-sort-controls button { display: inline-grid; width: 1.75rem; height: 1.75rem; padding: 0; place-items: center; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-muted); background: transparent; font: inherit; cursor: pointer; }
.facet-sort-controls button:hover, .facet-sort-controls button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; background: var(--surface-muted); }
.facet-sort-controls button:disabled { cursor: default; opacity: 0.3; }
.tag-move-hint { margin: 0.75rem 0 0; padding: 0.6rem 0.75rem; border-radius: 0.55rem; color: var(--text-muted); background: var(--accent-soft); font-size: 0.78rem; line-height: 1.45; }
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.detail-chip { display: inline-flex; align-items: center; padding: 0.35rem 0.6rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--tag-text); background: var(--tag-background); font-size: 0.78rem; }
.detail-chip-link { font-family: inherit; cursor: pointer; }
.draggable-chip[draggable='true'] { cursor: grab; }
.draggable-chip[draggable='true']:active { cursor: grabbing; }
.tag-move-selected {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
}
.tag-move-target { display: block; margin-top: 0.45rem; border-color: var(--accent); color: var(--accent); font-weight: 650; background: var(--accent-soft); }
.remove-tag-button { margin-left: 0.35rem; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; line-height: 1; cursor: pointer; opacity: 0.55; }
.remove-tag-button:hover, .remove-tag-button:focus-visible { opacity: 1; }
.add-facet-control { padding-top: 0.55rem; }
.add-section-control { padding: 0.9rem 0; border-top: 1px dashed var(--border-subtle); }
.add-button { padding: 0.38rem 0.6rem; border: 1px dashed var(--border-subtle); border-radius: 0.55rem; color: var(--text-muted); background: transparent; font: inherit; font-size: 0.76rem; cursor: pointer; }
.add-button:hover, .add-button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; background: var(--surface-muted); }
.add-tag-button { padding: 0.3rem 0.55rem; border-radius: 999px; }
.compact-editor { display: inline-flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 0.4rem; max-width: 100%; }
.compact-editor input { min-width: 0; max-width: 100%; flex: 0 1 auto; padding: 0.46rem 0.58rem; border: 1px solid var(--border-subtle); border-radius: 0.52rem; color: var(--text-primary); background: var(--surface); font: inherit; font-size: 0.8rem; }
.compact-editor input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent); }
.author-link-editor { position: relative; display: inline-grid; margin-top: 0.45rem; }
.author-duplicate-warning { margin: 0.3rem 0 0; color: var(--text-muted); font-size: 0.8rem; }
.compact-submit { padding: 0.46rem 0.62rem; }
.tag-editor { min-width: 0; }
.content-item { padding: 0.75rem; border-radius: 0.65rem; background: var(--surface-muted); }
.content-item + .content-item { margin-top: 0.5rem; }
.content-item-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.content-item-header > span { color: var(--accent); font-size: 0.72rem; font-weight: 750; }
.content-item-actions { display: flex; gap: 0.5rem; }
.content-action-button { border: 0; color: var(--accent); background: transparent; cursor: pointer; }
.content-action-button:disabled { cursor: default; opacity: 0.3; }
.danger-action { color: #a12626; }
.danger-button { border-color: #a12626; color: #a12626; }
.armable-armed { border-color: #a12626; color: #a12626; background: #fff0f0; }
.content-editor-actions { display: flex; gap: 0.5rem; }
.content-kind-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.content-kind-chip { padding: 0.28rem 0.55rem; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-muted); background: var(--surface); font: inherit; font-size: 0.74rem; cursor: pointer; }
.content-kind-chip:hover, .content-kind-chip:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.content-kind-chip-active { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.rating-rows { display: grid; gap: 0.35rem; }
.rating-row { display: flex; align-items: center; gap: 0.85rem; min-height: 2rem; }
.rating-name { min-width: 8rem; color: var(--text-muted); font-size: 0.8rem; }
.rating-unrated { color: var(--text-muted); font-size: 0.82rem; }
.star-display { position: relative; display: inline-block; line-height: 1; font-size: 1.05rem; letter-spacing: 0.08em; }
.star-display-base { color: color-mix(in srgb, var(--text-muted) 45%, transparent); }
.star-display-fill { position: absolute; top: 0; left: 0; height: 100%; overflow: hidden; white-space: nowrap; color: #e8a33d; pointer-events: none; }
.star-picker { display: inline-flex; align-items: center; gap: 0.35rem; }
.star-picker-zones { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(10, 1fr); }
.star-picker-zones button { appearance: none; background: none; border: none; padding: 0; margin: 0; cursor: pointer; }
.rating-sort-controls { display: inline-flex; gap: 0.2rem; }
.rating-sort-controls button { border: none; background: none; cursor: pointer; color: var(--text-muted); padding: 0 0.2rem; }
.rating-sort-controls button:disabled { opacity: 0.3; cursor: default; }
/* The dimension's own delete, left of the arrows: muted until hovered, because a person opens a
   rating row for its stars and this is the one control in it that reaches every work of the Gallery. */
.rating-delete-button { padding: 0.05rem 0.3rem; border: none; border-radius: 0.35rem; color: var(--text-muted); background: none; font-size: 0.9rem; line-height: 1; cursor: pointer; }
.rating-delete-button:hover { color: var(--danger, #b3261e); background: color-mix(in srgb, var(--danger, #b3261e) 12%, transparent); }
.add-rating-control { display: flex; }
.content-item p { margin: 0.35rem 0 0; white-space: pre-wrap; }
.content-link { display: inline-block; margin: 0.35rem 0 0; color: var(--accent); overflow-wrap: anywhere; }
.detail-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.detail-heading h2 { font-size: var(--font-size-page-title); font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
.editable-entry-title { cursor: text; }
.entry-title-input {
  min-width: 0;
  flex: 1;
  font: inherit;
  font-size: var(--font-size-page-title);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.detail-usage-stats { display: inline-flex; align-items: baseline; gap: 0.8rem; flex-shrink: 0; color: var(--text-muted); font-size: 0.82rem; white-space: nowrap; }
.detail-usage-count { font-weight: 700; color: var(--text-primary); }
.entry-usage-note { color: var(--text-muted); }
.entry-stack { position: relative; }
.entry-like-badge { position: absolute; left: 0.4rem; bottom: 0.4rem; z-index: 1; padding: 0.1rem 0.45rem; border-radius: 999px; background: rgb(0 0 0 / 55%); color: #fff; font-size: 0.7rem; }
.error-message { padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }

@media (max-width: 44rem) {
  /* The settings panel is the frame's own surface on a phone: the header
     becomes its positioning context and it stretches edge to edge, instead of
     a narrower dropdown leaking the main frame behind it. */
  .app-header { position: relative; }
  .settings-panel { left: 0; right: 0; width: auto; max-width: none; }
  :global(body.t3-mobile-navigation-open) { overflow: hidden; }
  .gallery-app {
    min-height: 100dvh;
    overflow-x: clip;
    padding:
      max(0.75rem, env(safe-area-inset-top))
      max(0.75rem, env(safe-area-inset-right))
      max(0.75rem, env(safe-area-inset-bottom))
      max(0.75rem, env(safe-area-inset-left));
  }
  .app-header {
    position: sticky;
    z-index: 30;
    top: 0;
    align-items: center;
    margin: -0.25rem -0.25rem 0.75rem;
    padding: 0.25rem;
    background: color-mix(in srgb, var(--page-background) 92%, transparent);
    backdrop-filter: blur(0.6rem);
  }
  .mobile-navigation-toggle { display: inline-grid; flex: 0 0 auto; }
  .app-title-copy .eyebrow,
  .app-title-copy .subtitle { display: none; }
  .app-title-copy h1 { margin: 0; font-size: 1.15rem; }
  .header-controls { flex: 0 0 auto; flex-wrap: nowrap; justify-content: flex-end; gap: 0.25rem; }
  /* Fallback box only: the sheet measures the page's own card when it opens and
     sets left/width/top inline, so it always matches that card exactly. */
  .settings-panel {
    position: fixed;
    top: calc(max(0.75rem, env(safe-area-inset-top)) + var(--icon-button-size) + 0.5rem);
    right: max(0.75rem, env(safe-area-inset-right));
    left: max(0.75rem, env(safe-area-inset-left));
    width: auto;
    max-height: calc(100dvh - 5rem - env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  .settings-panel select,
  .settings-panel .advanced-entry,
  .settings-panel .checkbox-label { min-height: 44px; }
  .accent-swatch { width: 44px; height: 44px; }
  .app-layout { grid-template-columns: 1fr; }
  /* The floating Back / scroll-to-top block is fixed in the bottom-right corner, so whatever a page
     ends with sits underneath it. Measured at a 390px viewport: the block covers 44×96px there while
     the content reserved nothing at all (`padding-bottom: 0`) — and the import review's commit button,
     full width and last on the page, landed exactly in it, so tapping Import hit "Back to top"
     instead and nothing appeared to happen. Every page keeps room for the block now. */
  .app-layout { padding-bottom: calc(7rem + env(safe-area-inset-bottom)); }
  .mobile-navigation-backdrop {
    position: fixed;
    z-index: 50;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: rgb(15 23 42 / 48%);
  }
  .sidebar {
    position: fixed;
    z-index: 60;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(20rem, calc(100vw - 3rem));
    max-width: 100%;
    /* The drawer itself does not scroll: the gallery list inside it does, and the shortcuts stay
       pinned to its bottom edge. */
    overflow: hidden;
    overscroll-behavior: contain;
    padding:
      max(0.75rem, env(safe-area-inset-top))
      1rem
      max(1rem, env(safe-area-inset-bottom))
      max(1rem, env(safe-area-inset-left));
    border-radius: 0 var(--radius-panel) var(--radius-panel) 0;
    visibility: hidden;
    transform: translateX(-105%);
    transition: transform var(--transition-duration) ease, visibility 0s linear var(--transition-duration);
  }
  .sidebar.sidebar-open {
    visibility: visible;
    transform: translateX(0);
    transition-delay: 0s;
  }
  .sidebar-mobile-header {
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .sidebar-search { min-height: 44px; }
  .sidebar-search button { min-width: 44px; min-height: 44px; margin: -0.5rem -0.6rem -0.5rem 0; }
  .gallery-link { min-height: 44px; align-items: center; }
  .create-actions { display: grid; gap: 0.5rem; margin-top: 1rem; }
  .create-actions > button { min-height: 44px; }
  .content-panel { min-width: 0; min-height: 20rem; max-width: 100%; padding: 0.9rem; overflow-x: clip; }
  .content-panel > * { min-width: 0; max-width: 100%; }
  .content-heading,
  .detail-toolbar,
  .detail-heading { align-items: flex-start; flex-wrap: wrap; }
  .content-heading-actions,
  .detail-toolbar-actions { min-width: 0; flex-wrap: wrap; justify-content: flex-start; }
  .detail-toolbar-actions .secondary-button,
  .entry-detail[data-edit-mode='true'] .add-button,
  .entry-detail[data-edit-mode='true'] .compact-editor input,
  .entry-detail[data-edit-mode='true'] .compact-submit,
  .entry-detail[data-edit-mode='true'] .content-action-button { min-height: 44px; }
  .entry-detail[data-edit-mode='true'] .detail-chip { min-height: 44px; padding-block: 0; }
  .entry-detail[data-edit-mode='true'] .remove-tag-button {
    display: inline-grid;
    min-width: 32px;
    min-height: 42px;
    place-items: center;
  }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls,
  .entry-detail[data-edit-mode='true'] .content-item-actions { flex-wrap: wrap; }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls button,
  .entry-detail[data-edit-mode='true'] .rating-sort-controls button {
    min-width: 44px;
    min-height: 44px;
  }
  .entry-detail[data-edit-mode='true'] .facet-label-column:has(.facet-sort-controls) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .entry-detail[data-edit-mode='true'] .facet-name {
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.3;
  }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls {
    flex: 0 0 auto;
    gap: 0;
    margin-top: 0;
  }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls button {
    border: 0;
    color: var(--text-muted);
    background: transparent;
    font-size: 0.82rem;
  }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls button:hover,
  .entry-detail[data-edit-mode='true'] .facet-sort-controls button:focus-visible {
    color: var(--accent);
    background: var(--surface-muted);
  }
  .entry-detail[data-edit-mode='true'] .facet-sort-controls .armable-armed { color: #a12626; background: #fff0f0; }
  .rating-row {
    display: grid;
    grid-template-columns: max-content max-content;
    width: 100%;
    min-width: 0;
    justify-content: start;
    gap: 0.4rem 0.65rem;
  }
  .rating-name {
    min-width: 0;
    max-width: min(9rem, 40vw);
    overflow-wrap: anywhere;
  }
  .rating-row > .star-picker,
  .rating-row > .star-display,
  .rating-row > .rating-unrated {
    grid-column: 2;
    grid-row: 1;
  }
  .rating-row > .rating-sort-controls {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .entry-toolbar .icon-button,
  .author-toolbar .icon-button,
  .detail-toolbar-actions .icon-button,
  .media-nav { width: 44px; height: 44px; }
  .detail-chip-link { min-height: 44px; }
  .sort-control { max-width: 100%; flex-wrap: wrap; }
  .sort-control select { max-width: 100%; }
  .back-button { display: inline-flex; min-height: 44px; align-items: center; }
  .facet-row { grid-template-columns: minmax(4.75rem, 6rem) minmax(0, 1fr); }
  .facet-label-column { padding-right: 0.6rem; }
  .facet-tag-column { padding-left: 0.7rem; }
}

@media (max-width: 30rem) {
  .content-panel { padding: 0.75rem; border-radius: var(--radius-card); }
  .facet-row { grid-template-columns: 1fr; }
  .facet-label-column { padding: 0.65rem 0 0.25rem; border-right: 0; }
  .facet-tag-column { padding: 0.25rem 0 0.65rem; }
}

/* A phone gets the same two actions on a Section, at a size a thumb can hit: the heading wraps and
   the actions move to their own line rather than shrinking into untappable chips. */
@media (max-width: 44rem) {
  .information-section-header { flex-wrap: wrap; }
  .information-section-actions { width: 100%; justify-content: flex-end; }
  .section-action { min-height: 44px; }
}
</style>
