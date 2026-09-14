<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { multiAuthorProducerName } from '@t3/shared';
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
} from '@t3/shared';
import AddAuthorPage from './AddAuthorPage.vue';
import AddEntryPage, { type ManualEntryDraft } from './AddEntryPage.vue';
import AdvancedEditingPage from './AdvancedEditingPage.vue';
import AuthorPage from './AuthorPage.vue';
import RecentViewPage from './RecentViewPage.vue';
import ViewLaterPage from './ViewLaterPage.vue';
import { flattenCollectionOptions, type CollectionMenuOption } from './collection-tree.js';
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
import { accent, accentPresets, accentSwatchColors, rowsPerPage, rowsPerPageOptions, showNsfw } from './stores/preferences.js';
import { useArmableAction } from './armable.js';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import SuggestionInput from './components/SuggestionInput.vue';
import AppIcon from './components/AppIcon.vue';
import IconButton from './components/IconButton.vue';
import LazyCardImage from './components/LazyCardImage.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import OfflineLibrarySettings from './components/OfflineLibrarySettings.vue';
import { supportedLocales, useI18n, type Locale } from './i18n.js';
import { createMemorySnapshotStore, type SnapshotStore } from './offline/snapshot-store.js';
import type { OfflineApiState } from './offline/offline-api.js';

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
const props = defineProps<{ api: GalleryApi; offlineStore?: SnapshotStore; offlineState?: OfflineApiState }>();
// main.ts always supplies IndexedDB. The in-memory fallback keeps component
// fixtures and embedders deterministic without touching browser storage.
const offlineStore = props.offlineStore ?? createMemorySnapshotStore();
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
const draggedTagId = ref<number | null>(null);
const selectedTagId = ref<number | null>(null);
const selectedTagFacetId = ref<number | null>(null);
const sectionEditorOpen = ref(false);
const facetEditorSectionId = ref<number | null>(null);
const tagEditorFacetId = ref<number | null>(null);
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
  }, signal);
}

const linkedAuthorIds = computed(() => (
  (activeEntry.value?.producers ?? []).map((producer) => producer.id)
));

function suggestAuthors(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestProducers({ q: query, excludeIds }, signal);
}

const editingTagId = ref<number | null>(null);
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
const sidebarSearchQuery = ref('');
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

function openSearch(): void {
  searchQuery.value = sidebarSearchQuery.value.trim();
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
  sidebarSearchQuery.value = query;
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

watch(showNsfw, () => {
  if (tagResults.value) void changeEntryTagPage(1);
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
 * clicking the card itself never counts. Record first, then navigate.
 */
async function openSourceUrl(event: MouseEvent, url: string): Promise<void> {
  event.preventDefault();
  if (!activeEntry.value) return;
  try {
    applyUsage(await props.api.recordEntryView(activeEntry.value.id));
  } catch {
    // Recording is best-effort: never block the navigation.
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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
      entryCollectionOptions.value = flattenCollectionOptions(collectionTree);
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
function isBasicSection(section: { name: string }): boolean {
  const name = section.name.trim();
  return /^basic\s*information$/i.test(name) || /^basic$/i.test(name);
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
// applyLayoutTemplate on the server). `showEmptyFacets` reveals empty named
// Facets so the rebuilt structure is visible even before tags are added.
const showEmptyFacets = ref(false);
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

async function saveLayoutTemplate(): Promise<void> {
  if (!activeEntry.value) return;
  const type = activeEntry.value.type;
  if (!arm('save-template')) return;
  disarm('save-template');
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
  activeType.value = entryType;
  facetFilters.value = { conditions: [], authorIds: [], ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null };
  galleryPage.value = navigationMemory.pages.get(`gallery:${entryType}`) ?? 1;
  const [, filterOptions] = await Promise.all([
    loadGalleryEntries(),
    props.api.listFacetFilterOptions(entryType),
  ]);
  facetFilterOptions.value = filterOptions;
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
    entryCollectionOptions.value = flattenCollectionOptions(collectionOptions);
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
      sidebarSearchQuery.value = entryOrigin.value.searchQuery;
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
    sidebarSearchQuery.value = authorSearchOrigin.value.searchQuery;
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
      sidebarSearchQuery.value = searchQuery.value;
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

function finishEditing(): void {
  editingEntry.value = false;
  resetLayoutEditors();
}

function resetLayoutEditors(): void {
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

async function createContent(): Promise<void> {
  if (!activeEntry.value) return;
  const entryId = activeEntry.value.id;
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

async function submitEntryTag(facetId: number, name: string): Promise<void> {
  if (!activeEntry.value || name.trim() === '') return;
  error.value = null;
  try {
    await props.api.assignEntryTag(activeEntry.value.id, {
      facetId,
      name,
    });
    tagEditorFacetId.value = null;
    const entryId = activeEntry.value.id;
    await openEntry(entryId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addTag');
  }
}

async function createNamedFacet(sectionId: number): Promise<void> {
  if (!activeEntry.value) return;
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
  try {
    await props.api.createFacet({
      sectionId,
      name: newFacetName,
    });
    await openEntry(activeEntry.value.id);
    tagEditorFacetId.value = activeEntry.value?.sections
      .find((section) => section.id === sectionId)
      ?.facets.find((facet) => facet.name === newFacetName)?.id ?? null;
    facetName.value = '';
    facetEditorSectionId.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createFacet');
  }
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
  if (showEmptyFacets.value) {
    // Show every named Facet (even empty ones) plus any unnamed Facet that
    // carries tags or is being edited — empty unnamed Facets stay hidden.
    return section.facets.filter((facet) => facet.name.length > 0
      || facet.tags.length > 0
      || tagEditorFacetId.value === facet.id);
  }
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

async function initialize(): Promise<void> {
  try {
    // Home is the default view: nothing is selected until the user picks a
    // Gallery (homepage design guide §10 — no first-gallery fallback).
    await Promise.all([refreshGalleries(), refreshAuthors(), initializeViewLater(props.api)]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadGalleries');
  } finally {
    loading.value = false;
  }
}

function openCreation(view: CreationView): void {
  closeMobileNavigation();
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

async function submitEntry(draft: ManualEntryDraft): Promise<void> {
  error.value = null;
  submitting.value = true;
  const targetType = draft.type;
  try {
    const created = await props.api.createEntry({
      title: draft.title,
      type: targetType,
      uploadDate: draft.uploadDate,
    });
    if (draft.coverFile) await props.api.uploadEntryMedia(created.id, 'cover', draft.coverFile);
    if (draft.previewFile) await props.api.uploadEntryMedia(created.id, 'preview', draft.previewFile);
    for (const rating of draft.ratings) {
      if (rating.stars === null) continue;
      await props.api.setEntryRating(created.id, rating.slotId, rating.stars);
    }
    if (draft.viewLater) await addEntriesToViewLater(props.api, [created.id]);
    await refreshGalleries();
    // Jump straight into the freshly created Entry for a quick check.
    creationView.value = null;
    await refreshAuthors();
    await viewEntry(created.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
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

async function finishImport(entryType: string, entryIds: number[] = [], viewLater = false): Promise<void> {
  if (viewLater) await addEntriesToViewLater(props.api, entryIds);
  creationView.value = null;
  batchReview.value = null;
  await Promise.all([refreshGalleries(), refreshAuthors()]);
  if (entryIds.length === 1) {
    await viewEntry(entryIds[0]!);
  } else if (entryIds.length > 1) {
    batchReview.value = { entryType, entryIds, warnings: [], runId: ++batchReviewRunCounter };
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
): Promise<void> {
  // The batch "view later" checkbox applies to every committed item.
  if (viewLater) await addEntriesToViewLater(props.api, entryIds);
  if (entryIds.length > 0) {
    creationView.value = null;
    // The review is the only place a commit note survives: the Add Entry page
    // that produced it unmounts as soon as this view takes over.
    batchReview.value = { entryType, entryIds, warnings, runId: ++batchReviewRunCounter };
    void refreshGalleries();
    void refreshAuthors();
  }
}

async function openBatchReviewEntries(): Promise<GalleryEntrySummary[]> {
  const review = batchReview.value;
  if (!review || review.entryIds.length === 0) return [];
  // Load by the committed ids alone: they are exact, while filtering by the
  // Gallery type as well would hide the whole group whenever that spelling
  // drifts (a typed `comic` that resolved to `Comic`, or a later rename).
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
      entryIds: review.entryIds,
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
  if (review === null || review.entryIds.length === 0) return;
  batchCollectionBusy.value = true;
  error.value = null;
  try {
    const collection = await props.api.createTemporaryCollection(review.entryIds);
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
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleGlobalKeydown);
  void initialize();
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
        <section v-if="settingsOpen" data-testid="settings-panel" class="settings-panel">
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
          <OfflineLibrarySettings :api="api" :store="offlineStore" />
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
      v-if="props.offlineState?.mode === 'offline'"
      class="offline-mode-banner"
      data-testid="offline-mode-banner"
      role="status"
    >
      {{ t('offline.modeBanner') }}
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
        <form
          class="sidebar-search"
          data-testid="sidebar-search-form"
          @submit.prevent="openSearch"
        >
          <AppIcon name="search" :size="16" />
          <input
            v-model="sidebarSearchQuery"
            data-testid="sidebar-search-input"
            type="search"
            :placeholder="t('search.sidebarPlaceholder')"
            :aria-label="t('search.title')"
            @focus="openSearch"
          >
          <button type="submit" :aria-label="t('search.submit')">→</button>
        </form>
        <div class="section-heading">
          <h2>{{ t('gallery.yours') }}</h2>
          <span>{{ visibleGalleries.length }}</span>
        </div>
        <p v-if="loading" class="muted">{{ t('gallery.loading') }}</p>
        <p v-else-if="galleries.length === 0 && authors.length === 0" class="empty-copy">
          {{ t('gallery.empty') }}
        </p>
        <nav v-else class="gallery-list" :aria-label="t('gallery.navigation')">
          <button
            data-testid="home-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: isHomeView }"
            @click="showHome"
          >
            <span>{{ t('home.nav') }}</span>
          </button>
          <button
            v-for="gallery in visibleGalleries"
            :key="gallery.type"
            type="button"
            class="gallery-link"
            :class="{ active: activeType === gallery.type }"
            :data-gallery-type="gallery.type"
            @click="selectGallery(gallery.type)"
          >
            <span>{{ gallery.type }}{{ gallery.nsfw ? ' 🔞' : '' }}</span>
            <span class="count">{{ gallery.entryCount }}</span>
          </button>
          <button
            v-if="authors.length > 0"
            data-testid="author-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: authorView }"
            @click="showAuthors"
          >
            <span>{{ t('author.navigation') }}</span>
            <span class="count">{{ authors.length }}</span>
          </button>
          <button
            data-testid="recent-view-navigation"
            type="button"
            class="gallery-link author-link"
            :class="{ active: recentView }"
            @click="showRecentView"
          >
            <span>{{ t('recent.title') }}</span>
            <span class="count" v-if="viewLaterIds.length > 0" />
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
            <span class="count" v-if="viewLaterIds.length + viewLaterAuthorIds.length > 0">{{ viewLaterIds.length + viewLaterAuthorIds.length }}</span>
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
          <button
            data-testid="add-author-navigation"
            class="secondary-button"
            type="button"
            @click="openCreation('author')"
          >
            {{ t('author.new') }}
          </button>
        </div>
      </aside>

      <section class="content-panel">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <SearchPage
          v-if="searchView"
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
          @back="closeAdvanced"
          @authors-changed="refreshAuthors"
        />
        <AddEntryPage
          v-else-if="creationView === 'entry'"
          :api="api"
          :authors="authors"
          :gallery-types="galleries.map((gallery) => gallery.type)"
          :submitting="submitting"
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
          <h2>{{ tagResults.tagName }}</h2>
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
                  <span v-if="entryStackLayers(entry).length === 0" class="entry-placeholder" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                  <span v-if="entry.likeCount > 0" class="entry-like-badge" data-testid="entry-like-badge">
                    👍 {{ entry.likeCount }}
                  </span>
                </div>
                <span class="entry-meta"><strong>{{ entry.title }}</strong><small>{{ entry.type }}</small></span>
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
                <span class="entry-placeholder" aria-hidden="true">
                  {{ author.name.slice(0, 1).toUpperCase() }}
                </span>
                <span class="entry-meta"><strong>{{ author.name }}</strong></span>
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
                v-if="batchReview.entryIds.length > 0"
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
                  <span v-if="(entry.coverRef || entry.previewRef) === null" class="entry-placeholder" aria-hidden="true">
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
                  <strong>{{ entry.title }}</strong>
                  <small>{{ entry.type }}</small>
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
                  data-testid="toggle-empty-facets"
                  class="secondary-button"
                  :class="{ 'toolbar-action-active': showEmptyFacets }"
                  type="button"
                  @click="showEmptyFacets = !showEmptyFacets"
                >
                  {{ showEmptyFacets ? t('template.hideEmptyFacets') : t('template.showEmptyFacets') }}
                </button>
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
                    class="add-to-collection-option"
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

          <div v-if="mediaSlides.length > 0" class="entry-media-viewer">
            <LazyCardImage
              class="entry-media-image"
              :src="api.assetUrl(mediaSlides[mediaIndex] ?? '')"
              :alt="activeEntry.title"
            />
            <button
              v-if="mediaIndex > 0"
              class="media-nav media-prev"
              type="button"
              :aria-label="t('media.previous')"
              @click="mediaPrevious"
            >‹</button>
            <button
              v-if="mediaIndex < mediaSlides.length - 1"
              class="media-nav media-next"
              type="button"
              :aria-label="t('media.next')"
              @click="mediaNext"
            >›</button>
            <span v-if="mediaSlides.length > 1" class="media-count">
              {{ mediaIndex + 1 }} / {{ mediaSlides.length }}
            </span>
          </div>

          <section v-if="activeEntry.producers.length || editingEntry" class="detail-section">
            <h3>{{ t('entry.producers') }}</h3>
            <div class="chip-row">
              <template v-for="producer in activeEntry.producers" :key="producer.id">
                <button
                  v-if="!editingEntry"
                  type="button"
                  class="detail-chip detail-chip-link"
                  :data-entry-author-id="producer.id"
                  @click="openAuthorFromEntry(producer.id)"
                >
                  {{ producer.name }}
                </button>
                <span
                  v-else
                  class="detail-chip"
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
              {{ t('tag.moveHint') }}
            </p>
            <p v-if="activeEntry.sections.length === 0" class="information-empty">
              {{ t('information.empty') }}
            </p>
            <section
              v-for="section in activeEntry.sections"
              :key="section.id"
              class="information-section"
              :data-section-id="section.id"
            >
              <header class="information-section-header">
                <h3>{{ section.name }}</h3>
                <span
                  v-if="isBasicSection(section) && (activeEntry.pageCount !== null || activeEntry.uploadDate)"
                  class="information-stats"
                >
                  <span v-if="activeEntry.pageCount !== null" class="information-stat">
                    {{ t('entry.pageCount', { count: activeEntry.pageCount }) }}
                  </span>
                  <span v-if="activeEntry.uploadDate" class="information-stat">
                    {{ t('entry.uploadDate', { date: activeEntry.uploadDate }) }}
                  </span>
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
                    <span v-if="facet.name" class="facet-name">{{ facet.name }}</span>
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
                          class="detail-chip detail-chip-link"
                          :data-detail-tag-id="tag.id"
                          @click="openEntryTag(tag)"
                        >
                          {{ tag.name }}
                        </button>
                        <span
                          v-else
                          class="detail-chip draggable-chip"
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
                <span class="rating-name">{{ row.name }}</span>
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
          <section v-if="activeEntry.contents.length || editingEntry" class="detail-section content-section">
            <h3>{{ t('content.title') }}</h3>
            <p v-if="activeEntry.contents.length === 0" class="content-empty">
              {{ t('content.empty') }}
            </p>
            <div
              v-for="(content, contentIndex) in activeEntry.contents"
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
                      :disabled="contentIndex === activeEntry.contents.length - 1"
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
                  class="content-link"
                  :href="content.content"
                  target="_blank"
                  rel="noopener noreferrer"
                  :data-source-url-content-id="content.id"
                  @click="openSourceUrl($event, content.content)"
                >{{ content.content }}</a>
                <p v-else>{{ content.content }}</p>
              </template>
            </div>
            <div v-if="editingEntry" class="add-content-control">
              <button
                v-if="!contentEditorOpen"
                data-testid="add-content-button"
                class="add-button"
                type="button"
                @click="contentEditorOpen = true"
              >
                {{ t('content.add') }}
              </button>
              <form
                v-else
                data-testid="create-content-form"
                class="content-editor"
                @submit.prevent="createContent"
              >
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
                    :placeholder="t('content.bodyPlaceholder')"
                  />
                </label>
                <button class="primary-button compact-submit" type="submit">
                  {{ t('content.addAction') }}
                </button>
              </form>
            </div>
          </section>

          <IconButton
            class="scroll-top-fab"
            icon="arrow-up"
            :label="t('navigation.scrollTop')"
            data-testid="entry-scroll-top"
            @click="scrollToTop"
          />
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
                  <span v-if="entryStackLayers(entry).length === 0" class="entry-placeholder" aria-hidden="true">
                    {{ entry.title.slice(0, 1).toUpperCase() }}
                  </span>
                  <span v-if="entry.likeCount > 0" class="entry-like-badge" data-testid="entry-like-badge">
                    👍 {{ entry.likeCount }}
                  </span>
                </div>
                <span class="entry-meta">
                  <strong>{{ entry.title }}</strong>
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
          v-else-if="!loading"
          :api="api"
          @open-entry="openEntryFromHome"
          @open-gallery="selectGallery"
          @create-entry="openCreation('entry')"
          @create-author="openCreation('author')"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
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
.offline-mode-banner { margin: 0 0 0.75rem; padding: 0.65rem 0.85rem; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-subtle)); border-radius: var(--radius-control); color: var(--text-primary); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); font-size: 0.84rem; }

.app-layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); gap: 1rem; }
.sidebar,
.content-panel { border: 1px solid var(--border-subtle); border-radius: var(--radius-panel); background: var(--surface); box-shadow: var(--shadow-panel); }
.sidebar { padding: 1rem; }
.content-panel { min-height: 30rem; padding: clamp(1rem, 3vw, 1.75rem); }
.sidebar-search { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.35rem; margin-bottom: 1rem; padding: 0.5rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--surface-muted); }
.sidebar-search .app-icon { color: var(--icon-muted); transition: color var(--transition-duration) ease; }
.sidebar-search:focus-within { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 18%, transparent); }
.sidebar-search:focus-within .app-icon { color: var(--accent); }
.sidebar-search input { min-width: 0; padding: 0; border: 0; outline: 0; color: var(--text-primary); background: transparent; font: inherit; }
.sidebar-search button { padding: 0.1rem 0.25rem; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.section-heading { margin-bottom: 0.8rem; }
.section-heading h2 { font-size: 0.95rem; }
.section-heading > span, .count { color: var(--text-muted); font-size: 0.78rem; }
.gallery-list { display: grid; gap: 0.35rem; }
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
.entry-media-viewer { position: relative; margin: 1rem 0 1.25rem; max-width: 24rem; }
.entry-media-image { display: block; width: 100%; max-height: 24rem; object-fit: contain; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface-muted); }
.media-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 2rem; height: 2rem; border: 0; border-radius: 999px; color: var(--text-primary); background: rgb(0 0 0 / 45%); font-size: 1.25rem; line-height: 1; cursor: pointer; }
.media-prev { left: 0.5rem; }
.media-next { right: 0.5rem; }
.media-count { position: absolute; bottom: 0.5rem; right: 0.5rem; padding: 0.15rem 0.5rem; border-radius: 999px; color: var(--text-primary); background: rgb(0 0 0 / 45%); font-size: 0.75rem; }
.entry-meta { display: grid; gap: 0.25rem; padding: 0.85rem; }
.entry-meta small { color: var(--text-muted); }
.secondary-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: var(--control-min-height); padding: 0.45rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.secondary-button:hover { border-color: var(--accent); }
.secondary-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.entry-detail > h2 { margin-bottom: 1.5rem; font-size: clamp(1.7rem, 4vw, 2.5rem); }
.scroll-top-fab {
  position: fixed;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  z-index: 30;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
}
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
.information-stats { display: inline-flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; margin-bottom: 0.55rem; }
.information-stat { color: var(--text-muted); font-size: 0.78rem; }
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
    overflow-y: auto;
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
</style>
