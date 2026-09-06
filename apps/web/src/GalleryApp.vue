<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
import { toggleViewLater, viewLaterIds } from './stores/preferences.js';
import SearchPage from './SearchPage.vue';
import { entryStackLayerStyle, entryStackLayers } from './entry-media-stack.js';
import { accent, accentPresets, accentSwatchColors, rowsPerPage, rowsPerPageOptions, showNsfw } from './stores/preferences.js';
import { useArmableAction } from './armable.js';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import AppIcon from './components/AppIcon.vue';
import IconButton from './components/IconButton.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import { supportedLocales, useI18n, type Locale } from './i18n.js';

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
  sourceEntry: { id: number; type: string; title: string } | null;
  sourceSearchQuery: string | null;
  sourceSearchScope: SearchScope | null;
}
interface AuthorTagResults {
  kind: 'author';
  tagId: number;
  tagName: string;
  authors: Array<{ id: number; name: string }>;
  sourceAuthor: AuthorLocation;
}
type TagResults = EntryTagResults | AuthorTagResults;
type SearchOrigin = { searchQuery: string; searchScope: SearchScope };
type EntryOrigin = AuthorLocation | { tagResults: EntryTagResults } | SearchOrigin;
type CreationView = 'entry' | 'author';
const props = defineProps<{ api: GalleryApi }>();
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
type GallerySort = 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc';
// Newest first by default: recent imports land at the top of the gallery.
const gallerySort = ref<GallerySort>('date-desc');
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

const sortedEntries = computed(() => {
  const list = [...entries.value];
  // A rating sort is performed by the server (unrated sink to the bottom);
  // the local re-order must not undo it.
  if (facetFilters.value.ratingSort !== null || facetFilters.value.usageSort !== null) {
    return list;
  }
  const direction = gallerySort.value.endsWith('-desc') ? -1 : 1;
  const byTitle = (a: GalleryEntrySummary, b: GalleryEntrySummary): number => (
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  );
  if (gallerySort.value.startsWith('title')) {
    return list.sort((a, b) => direction * byTitle(a, b));
  }
  return list.sort((a, b) => {
    const dateCompare = String(a.uploadDate ?? '').localeCompare(String(b.uploadDate ?? ''));
    const tie = a.id - b.id;
    return direction * (dateCompare !== 0 ? dateCompare : tie);
  });
});
const activeEntry = ref<EntryDetailResponse | null>(null);
const activeType = ref<string | null>(null);
const editingEntry = ref(false);
const creationView = ref<CreationView | null>(null);
const sectionName = ref('');
const facetName = ref('');
const tagName = ref('');
const draggedTagId = ref<number | null>(null);
const sectionEditorOpen = ref(false);
const facetEditorSectionId = ref<number | null>(null);
const tagEditorFacetId = ref<number | null>(null);
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
const advancedView = ref(false);
const authorView = ref(false);
const recentView = ref(false);
const viewLaterView = ref(false);
const collectionsView = ref(false);
const randomView = ref(false);

// Add-to-collection menus on the detail pages.
const entryCollectionOptions = ref<CollectionMenuOption[]>([]);
const entryCollectionIds = ref<number[]>([]);
const entryCollectionMenuOpen = ref(false);
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
const authorSearchQuery = ref('');
const authorTarget = ref<AuthorLocation | null>(null);
const entryOrigin = ref<EntryOrigin | null>(null);
const tagResults = ref<TagResults | null>(null);
const authorTagOrigin = ref<AuthorTagResults | null>(null);
const nextTheme = computed<Theme>(() => (theme.value === 'light' ? 'dark' : 'light'));
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

function showHome(): void {
  leaveAllViews();
}
const entryBackTarget = computed(() => {
  if (!entryOrigin.value) return activeType.value ?? t('home.nav');
  if ('tagResults' in entryOrigin.value) return entryOrigin.value.tagResults.tagName;
  if ('searchQuery' in entryOrigin.value) return t('search.title');
  return entryOrigin.value.directoryName ?? entryOrigin.value.authorName;
});
const availableAuthors = computed(() => {
  const linkedIds = new Set(activeEntry.value?.producers.map((author) => author.id) ?? []);
  return authors.value.filter((author) => !linkedIds.has(author.id));
});
const filteredAvailableAuthors = computed(() => {
  const query = authorSearchQuery.value.trim().toLocaleLowerCase();
  return availableAuthors.value.filter((author) => (
    query === '' || author.name.toLocaleLowerCase().includes(query)
  ));
});
const { locale, setLocale, t } = useI18n();

function selectLocale(event: Event): void {
  const nextLocale = (event.target as HTMLSelectElement).value as Locale;
  if (supportedLocales.includes(nextLocale)) setLocale(nextLocale);
}

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}

// Every sidebar entry is top priority: switching views always tears down the
// current one first. returnView remembers where an Entry detail was opened
// from so the detail's back button returns to the right place.
type ReturnTarget = 'recent' | 'viewLater' | 'collections' | 'batch' | 'random';

const returnView = ref<ReturnTarget | null>(null);
const pendingBatchReview = ref<{ entryType: string; entryIds: number[] } | null>(null);

function leaveAllViews(keepEntry = false): void {
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
  const origin = preserveSearchContext(query, scope);
  searchView.value = false;
  creationView.value = null;
  tagResults.value = null;
  recentView.value = false;
  authorView.value = false;
  advancedView.value = false;
  activeType.value = entry.type;
  await viewEntry(entry.id, origin);
}

function openAuthorFromSearch(
  author: GalleryAuthorSummary,
  query: string,
  scope: SearchScope,
): void {
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
}

async function openTagFromSearch(
  tag: TagSearchHit,
  query: string,
  scope: SearchScope,
): Promise<void> {
  error.value = null;
  const origin = preserveSearchContext(query, scope);
  try {
    tagResults.value = {
      kind: 'entry',
      tagId: tag.tagId,
      tagName: tag.name,
      entries: await props.api.findEntriesByTag(tag.tagId),
      sourceEntry: null,
      sourceSearchQuery: origin.searchQuery,
      sourceSearchScope: origin.searchScope,
    };
    searchView.value = false;
    activeEntry.value = null;
    activeType.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

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
  entryCollectionMenuOpen.value = false;
  error.value = null;
  try {
    await props.api.addCollectionEntry(collectionId, activeEntry.value.id);
    entryCollectionIds.value = [...entryCollectionIds.value, collectionId];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
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
  if (!activeEntry.value) return;
  if (!arm('delete-entry')) return;
  disarm('delete-entry');
  error.value = null;
  try {
    await props.api.deleteEntry(activeEntry.value.id);
    await refreshGalleries();
    if (activeType.value) {
      await selectGallery(activeType.value);
    } else {
      await closeEntry();
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
}, { flush: 'sync' });
onUnmounted(clearTemplateNotice);

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

async function selectGallery(entryType: string, keepEntry = false): Promise<void> {
  leaveAllViews(keepEntry);
  activeType.value = entryType;
  facetFilters.value = { conditions: [], authorIds: [], ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null };
  const [summaries, filterOptions] = await Promise.all([
    props.api.listEntries(entryType),
    props.api.listFacetFilterOptions(entryType),
  ]);
  entries.value = summaries;
  facetFilterOptions.value = filterOptions;
}

async function loadGalleryEntries(): Promise<void> {
  if (!activeType.value) return;
  const seq = ++galleryEntriesRequestSeq;
  const { conditions, authorIds, ratingConditions, ratingSort, usageConditions, usageSort } = facetFilters.value;
  const activeConditions = conditions.filter((condition) => condition.tagIds.length > 0);
  const hasFilters = activeConditions.length > 0 || authorIds.length > 0
    || ratingConditions.length > 0 || ratingSort !== null
    || usageConditions.length > 0 || usageSort !== null;
  const summaries = !hasFilters
    ? await props.api.listEntries(activeType.value)
    : await props.api.filterEntriesByFacets(activeType.value, activeConditions, authorIds, {
      ratingConditions,
      ratingSort,
      usageConditions,
      usageSort,
    });
  if (seq !== galleryEntriesRequestSeq) return; // superseded by a newer request
  entries.value = summaries;
}

async function onFacetFiltersChange(filters: GalleryFacetFilters): Promise<void> {
  facetFilters.value = filters;
  try {
    await loadGalleryEntries();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('gallery.filterError');
  }
}

function showCollections(): void {
  leaveAllViews();
  collectionsView.value = true;
}

function showRandom(): void {
  leaveAllViews();
  randomView.value = true;
}

function openEntryFromRandom(entryId: number): void {
  leaveAllViews();
  returnView.value = 'random';
  void viewEntry(entryId);
}

function openAuthorFromRandom(authorId: number): void {
  collectionsView.value = false;
  randomView.value = false;
  authorTarget.value = { authorId, authorName: '', directoryId: null, directoryName: null };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
}

// Random tag hits remember they came from the random page so closing the
// result returns there instead of the search page.
let randomTagReturn = false;

function openTagFromRandom(tag: { id: number; name: string }): void {
  error.value = null;
  randomTagReturn = true;
  void props.api.findEntriesByTag(tag.id).then((entries) => {
    tagResults.value = {
      kind: 'entry',
      tagId: tag.id,
      tagName: tag.name,
      entries,
      sourceEntry: null,
      sourceSearchQuery: null,
      sourceSearchScope: null,
    };
    randomView.value = false;
  }).catch((cause: unknown) => {
    randomTagReturn = false;
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  });
}

function openEntryFromCollections(entryId: number): void {
  leaveAllViews();
  returnView.value = 'collections';
  void viewEntry(entryId);
}

function openAuthorFromCollections(authorId: number): void {
  collectionsView.value = false;
  authorTarget.value = { authorId, authorName: '', directoryId: null, directoryName: null };
  entryOrigin.value = null;
  activeEntry.value = null;
  activeType.value = null;
  authorView.value = true;
}

function openEntryFromViewLater(entryId: number): void {
  leaveAllViews();
  returnView.value = 'viewLater';
  void viewEntry(entryId);
}

// Home-opened entries fall back to Home when closed: no return view needed,
// the template's home branch catches it (homepage design guide §10).
function openEntryFromHome(entryId: number): void {
  leaveAllViews();
  void viewEntry(entryId);
}

function showViewLater(): void {
  leaveAllViews();
  viewLaterView.value = true;
}

function openEntryFromRecent(entryId: number): void {
  leaveAllViews();
  returnView.value = 'recent';
  void viewEntry(entryId);
}

function showRecentView(): void {
  leaveAllViews();
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
}): Promise<void> {
  // Load the detail BEFORE switching views: clearing the author view first
  // rendered the gallery grid for as long as the fetches took. If the load
  // fails, the author page stays up with the error banner.
  await openEntry(payload.work.id);
  if (!activeEntry.value) return;
  try {
    await selectGallery(payload.work.type, true);
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

async function viewEntry(entryId: number, origin: EntryOrigin | null = null): Promise<void> {
  entryOrigin.value = origin;
  editingEntry.value = false;
  resetLayoutEditors();
  await openEntry(entryId);
}

function startEditing(): void {
  editingEntry.value = true;
  resetLayoutEditors();
}

function closeEntry(): void {
  if (entryOrigin.value) {
    if ('tagResults' in entryOrigin.value) {
      tagResults.value = entryOrigin.value.tagResults;
      entryOrigin.value = null;
      activeEntry.value = null;
      activeType.value = null;
      editingEntry.value = false;
      resetLayoutEditors();
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
      return;
    }
    authorTarget.value = entryOrigin.value;
    entryOrigin.value = null;
    activeEntry.value = null;
    activeType.value = null;
    authorView.value = true;
    editingEntry.value = false;
    resetLayoutEditors();
    return;
  }
  activeEntry.value = null;
  editingEntry.value = false;
  resetLayoutEditors();
  restoreReturnView();
}

function restoreReturnView(): void {
  const target = returnView.value;
  returnView.value = null;
  if (target === 'recent') showRecentView();
  else if (target === 'viewLater') showViewLater();
  else if (target === 'collections') showCollections();
  else if (target === 'random') showRandom();
  else if (target === 'batch' && pendingBatchReview.value) {
    batchReview.value = pendingBatchReview.value;
    pendingBatchReview.value = null;
  }
}

async function openEntryTag(tag: { id: number; name: string }): Promise<void> {
  if (editingEntry.value || !activeEntry.value) return;
  const sourceEntry = {
    id: activeEntry.value.id,
    type: activeEntry.value.type,
    title: activeEntry.value.title,
  };
  error.value = null;
  try {
    tagResults.value = {
      kind: 'entry',
      tagId: tag.id,
      tagName: tag.name,
      entries: await props.api.findEntriesByTag(tag.id),
      sourceEntry,
      sourceSearchQuery: null,
      sourceSearchScope: null,
    };
    activeEntry.value = null;
    activeType.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function openAuthorTag(payload: {
  tagId: number;
  tagName: string;
  authorId: number;
  authorName: string;
}): Promise<void> {
  error.value = null;
  try {
    tagResults.value = {
      kind: 'author',
      tagId: payload.tagId,
      tagName: payload.tagName,
      authors: await props.api.findAuthorsByTag(payload.tagId),
      sourceAuthor: {
        authorId: payload.authorId,
        authorName: payload.authorName,
        directoryId: null,
        directoryName: null,
      },
    };
    authorView.value = false;
    authorTarget.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthors');
  }
}

async function openTagEntry(entry: GalleryEntrySummary): Promise<void> {
  if (tagResults.value?.kind !== 'entry') return;
  const origin = tagResults.value;
  tagResults.value = null;
  activeType.value = entry.type;
  await viewEntry(entry.id, { tagResults: origin });
}

function openTagAuthor(author: { id: number; name: string }): void {
  if (tagResults.value?.kind !== 'author') return;
  authorTagOrigin.value = tagResults.value;
  tagResults.value = null;
  authorTarget.value = {
    authorId: author.id,
    authorName: author.name,
    directoryId: null,
    directoryName: null,
  };
  authorView.value = true;
}

function restoreAuthorTagResults(): void {
  if (authorTagOrigin.value) {
    tagResults.value = authorTagOrigin.value;
    authorTagOrigin.value = null;
    authorView.value = false;
    authorTarget.value = null;
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
  }
}

async function closeTagResults(): Promise<void> {
  const current = tagResults.value;
  if (!current) return;
  tagResults.value = null;
  if (current.kind === 'entry') {
    if (current.sourceEntry) {
      activeType.value = current.sourceEntry.type;
      await viewEntry(current.sourceEntry.id);
    } else if (randomTagReturn) {
      randomTagReturn = false;
      showRandom();
    } else {
      searchQuery.value = current.sourceSearchQuery ?? '';
      searchScope.value = current.sourceSearchScope ?? 'entries';
      sidebarSearchQuery.value = searchQuery.value;
      searchView.value = true;
    }
    return;
  }
  authorTarget.value = current.sourceAuthor;
  authorView.value = true;
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
  sectionEditorOpen.value = false;
  facetEditorSectionId.value = null;
  tagEditorFacetId.value = null;
  editingTagId.value = null;
  contentEditorOpen.value = false;
  editingContentId.value = null;
  ratingEditorOpen.value = false;
  draggedTagId.value = null;
  sectionName.value = '';
  facetName.value = '';
  tagName.value = '';
  editingTagName.value = '';
  contentType.value = '';
  contentBody.value = '';
  editingContentType.value = '';
  editingContentBody.value = '';
  authorEditorOpen.value = false;
  authorLinkEditorOpen.value = false;
  newAuthorName.value = '';
  authorSearchQuery.value = '';
}

async function createAndLinkAuthor(): Promise<void> {
  if (!activeEntry.value || !newAuthorName.value.trim()) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    const author = await props.api.createAuthor({ name: newAuthorName.value });
    await props.api.linkEntryAuthor(entryId, author.id);
    authorEditorOpen.value = false;
    newAuthorName.value = '';
    await Promise.all([refreshAuthors(), openEntry(entryId)]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createAuthor');
  }
}

async function linkExistingAuthor(authorId?: number): Promise<void> {
  const matchedAuthor = authorId === undefined
    ? filteredAvailableAuthors.value[0]
    : availableAuthors.value.find((author) => author.id === authorId);
  if (!activeEntry.value || !matchedAuthor) return;
  const entryId = activeEntry.value.id;
  error.value = null;
  try {
    await props.api.linkEntryAuthor(entryId, matchedAuthor.id);
    authorSearchQuery.value = '';
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

async function addEntryTag(facetId: number | null): Promise<void> {
  if (!activeEntry.value || facetId === null) return;
  error.value = null;
  try {
    await props.api.assignEntryTag(activeEntry.value.id, {
      facetId,
      name: tagName.value,
    });
    tagName.value = '';
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

function beginTagRename(tag: EntryDetailResponse['sections'][number]['facets'][number]['tags'][number]): void {
  if (!editingEntry.value) return;
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
  const entryId = activeEntry.value.id;
  const tagId = draggedTagId.value;
  draggedTagId.value = null;
  error.value = null;
  try {
    await props.api.moveEntryTag(entryId, tagId, targetFacetId);
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
    await Promise.all([refreshGalleries(), refreshAuthors()]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadGalleries');
  } finally {
    loading.value = false;
  }
}

function openCreation(view: CreationView): void {
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
    if (draft.viewLater) toggleViewLater(created.id);
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
  if (viewLater) {
    for (const entryId of entryIds) {
      if (!viewLaterIds.value.includes(entryId)) viewLaterIds.value.push(entryId);
    }
  }
  creationView.value = null;
  batchReview.value = null;
  await Promise.all([refreshGalleries(), refreshAuthors()]);
  if (entryIds.length === 1) {
    await viewEntry(entryIds[0]!);
  } else if (entryIds.length > 1) {
    batchReview.value = { entryType, entryIds };
  } else {
    await selectGallery(entryType);
  }
}

// Temporary batch review: after a batch import the just-committed cards are
// shown as a throwaway gallery group. Everything is already persisted — this
// view is purely for a quick check. Leaving it (explicit button or switching
// to any other view) discards the group.
const batchReview = ref<{ entryType: string; entryIds: number[] } | null>(null);

function finishBatchImport(entryType: string, entryIds: number[] = [], viewLater = false): void {
  // The batch "view later" checkbox applies to every committed item.
  if (viewLater) {
    for (const entryId of entryIds) {
      if (!viewLaterIds.value.includes(entryId)) viewLaterIds.value.push(entryId);
    }
  }
  if (entryIds.length > 0) {
    creationView.value = null;
    batchReview.value = { entryType, entryIds };
    void refreshGalleries();
    void refreshAuthors();
  }
}

async function openBatchReviewEntries(): Promise<GalleryEntrySummary[]> {
  if (!batchReview.value) return [];
  const summaries = await props.api.listEntries(batchReview.value.entryType);
  const wanted = new Set(batchReview.value.entryIds);
  return summaries.filter((summary) => wanted.has(summary.id));
}

function completeBatchReview(): void {
  batchReview.value = null;
  pendingBatchReview.value = null;
}

function openEntryFromBatchReview(entryId: number): void {
  pendingBatchReview.value = batchReview.value;
  leaveAllViews();
  returnView.value = 'batch';
  void viewEntry(entryId);
}

const batchReviewEntries = ref<GalleryEntrySummary[]>([]);
const batchReviewLoading = ref(false);

watch(batchReview, async (review) => {
  if (!review) {
    batchReviewEntries.value = [];
    return;
  }
  batchReviewLoading.value = true;
  try {
    const summaries = await props.api.listEntries(review.entryType);
    const wanted = new Set(review.entryIds);
    batchReviewEntries.value = summaries.filter((summary) => wanted.has(summary.id));
  } catch {
    batchReviewEntries.value = [];
  } finally {
    batchReviewLoading.value = false;
  }
});

onMounted(initialize);
</script>

<template>
  <div class="gallery-app" :data-theme="theme" :data-accent="accent">
    <header class="app-header">
      <div>
        <p class="eyebrow">{{ t('app.tagline') }}</p>
        <h1>{{ t('gallery.title') }}</h1>
        <p class="subtitle">{{ t('gallery.subtitle') }}</p>
      </div>
      <div class="header-controls">
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

    <main class="app-layout">
      <aside class="sidebar">
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
            <span class="count" v-if="viewLaterIds.length > 0">{{ viewLaterIds.length }}</span>
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
          >{{ t(tagResults.entries.length === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', { count: tagResults.entries.length }) }}</p>
          <p
            v-if="tagResults.kind === 'entry' && tagResults.entries.length === 0
              || tagResults.kind === 'author' && tagResults.authors.length === 0"
            class="muted"
          >
            {{ t('tag.noResults') }}
          </p>
          <PagedCardGrid :items="pagedTagItems" v-slot="{ items }">
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
                  <img
                    v-for="(ref, stackIndex) in entryStackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="entryStackLayerStyle(stackIndex, entryStackLayers(entry).length)"
                    :src="api.assetUrl(ref)"
                    :alt="entry.title"
                  >
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
          @open-entry="openEntryFromRecent"
        />
        <ViewLaterPage
          v-else-if="viewLaterView"
          :api="api"
          @open-entry="openEntryFromViewLater"
        />
        <CollectionsPage
          v-else-if="collectionsView"
          :api="api"
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
            </div>
          </div>
          <p class="batch-review-notice" data-testid="batch-review-notice" role="status">
            {{ t('import.batchReviewNotice') }}
          </p>
          <p v-if="batchReviewLoading" class="muted">{{ t('import.preparing') }}</p>
          <PagedCardGrid v-else :items="batchReviewEntries" v-slot="{ items }">
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
                  <img
                    v-else
                    class="entry-stack-image"
                    :src="api.assetUrl(entry.coverRef ?? entry.previewRef ?? '')"
                    :alt="entry.title"
                  >
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
          :api="api"
          :authors="authors"
          :initial-author-id="authorTarget?.authorId ?? null"
          :initial-directory-id="authorTarget?.directoryId ?? null"
          :back-label="authorTagOrigin
            ? t('entry.back', { type: authorTagOrigin.tagName })
            : authorSearchOrigin !== null ? t('entry.back', { type: t('search.title') }) : null"
          @open-entry="openEntryFromAuthor"
          @open-tag="openAuthorTag"
          @back="restoreAuthorTagResults"
          @authors-changed="refreshAuthors"
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
              <div class="add-to-collection" data-testid="entry-add-to-collection">
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
                    role="menuitem"
                    class="add-to-collection-option"
                    :disabled="entryCollectionIds.includes(collection.id)"
                    @click="addEntryToCollection(collection.id)"
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
                @click="activeEntry && toggleViewLater(activeEntry.id)"
              />
            </div>
          </div>
          <p v-if="templateNotice" class="template-notice" data-testid="template-notice" role="status">
            {{ templateNotice }}
          </p>
          <p v-if="tagLayoutNotice" class="template-notice" data-testid="tag-layout-notice" role="status">
            {{ tagLayoutNotice }}
          </p>
          <p class="eyebrow">{{ activeEntry.type }}</p>
          <div class="detail-heading">
            <h2>{{ activeEntry.title }}</h2>
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
            <img
              class="entry-media-image"
              :src="api.assetUrl(mediaSlides[mediaIndex] ?? '')"
              :alt="activeEntry.title"
            >
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
              <span
                v-for="producer in activeEntry.producers"
                :key="producer.id"
                class="detail-chip"
                :data-entry-author-id="producer.id"
                @dblclick="!editingEntry && openAuthorFromEntry(producer.id)"
              >
                {{ producer.name }}
                <button
                  v-if="editingEntry"
                  type="button"
                  class="remove-tag-button"
                  :data-unlink-author-id="producer.id"
                  :aria-label="t('author.unlink', { name: producer.name })"
                  @click="unlinkAuthor(producer.id)"
                >×</button>
              </span>
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
              <button
                v-if="editingEntry && availableAuthors.length > 0 && !authorLinkEditorOpen"
                data-testid="link-entry-author"
                type="button"
                class="add-button add-tag-button"
                @click="authorLinkEditorOpen = true"
              >
                {{ t('author.linkExisting') }}
              </button>
            </div>
            <div
              v-if="editingEntry && availableAuthors.length > 0 && authorLinkEditorOpen"
              data-testid="link-existing-author-form"
              class="compact-editor author-link-editor"
            >
              <input
                v-model="authorSearchQuery"
                name="existingAuthorName"
                :size="inlineInputSize(authorSearchQuery)"
                autocomplete="off"
                :placeholder="t('author.chooseExisting')"
                @keydown.enter.prevent="linkExistingAuthor()"
                @blur="authorSearchQuery.trim() && linkExistingAuthor()"
              >
              <div data-testid="author-suggestions" class="author-suggestions">
                <button
                  v-for="author in filteredAvailableAuthors"
                  :key="author.id"
                  type="button"
                  @mousedown.prevent
                  @click="linkExistingAuthor(author.id)"
                >
                  {{ author.name }}
                </button>
                <span v-if="filteredAvailableAuthors.length === 0" class="muted">
                  {{ t('author.noMatches') }}
                </span>
              </div>
            </div>
          </section>

          <div data-testid="entry-information-board" class="information-board">
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
                      <span
                        v-for="tag in facet.tags"
                        :key="tag.id"
                        class="detail-chip draggable-chip"
                        :draggable="editingEntry && editingTagId !== tag.id"
                        :data-detail-tag-id="tag.id"
                        @dragstart="beginTagDrag(tag.id)"
                        @dragend="draggedTagId = null"
                        @dblclick="editingEntry ? beginTagRename(tag) : openEntryTag(tag)"
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
                          v-if="editingEntry"
                          type="button"
                          class="remove-tag-button"
                          :data-remove-entry-tag-id="tag.id"
                          :aria-label="t('tag.remove', { name: tag.name })"
                          @click.stop="removeTag(tag.id)"
                        >
                          ×
                        </button>
                      </span>
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
                        @submit.prevent="addEntryTag(facet.id)"
                      >
                        <input
                          v-model="tagName"
                          name="tagName"
                          :size="inlineInputSize(tagName)"
                          required
                          autocomplete="off"
                          :placeholder="t('tag.namePlaceholder')"
                          @blur="tagName.trim() && addEntryTag(facet.id)"
                        >
                      </form>
                    </div>
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
                    @submit.prevent="addEntryTag(emptyUnnamedFacetId(section))"
                  >
                    <input
                      v-model="tagName"
                      name="tagName"
                      :size="inlineInputSize(tagName)"
                      required
                      autocomplete="off"
                      :placeholder="t('tag.namePlaceholder')"
                      @blur="tagName.trim() && addEntryTag(emptyUnnamedFacetId(section))"
                    >
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
                </select>
              </label>
              <span data-testid="gallery-entry-count">
                {{ galleryFilterActive
                  ? t('gallery.filteredCount', { shown: entries.length, total: galleryTotalCount })
                  : t(entries.length === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', {
                    count: entries.length,
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
          <PagedCardGrid :items="sortedEntries" grid-testid="entry-list" v-slot="{ items }">
            <article
              v-for="entry in items"
              :key="entry.id"
              class="entry-card"
            >
              <button
                type="button"
                class="entry-card-main"
                :data-entry-id="entry.id"
                @click="viewEntry(entry.id)"
              >
                <div class="entry-stack">
                  <img
                    v-for="(ref, stackIndex) in entryStackLayers(entry)"
                    :key="`${ref}-${stackIndex}`"
                    class="entry-stack-image"
                    :style="entryStackLayerStyle(stackIndex, entryStackLayers(entry).length)"
                    :src="api.assetUrl(ref)"
                    :alt="entry.title"
                  >
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
.settings-panel { position: absolute; z-index: 10; top: calc(100% + 0.5rem); right: 0; width: min(36rem, calc(100vw - 2rem)); padding: 1rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-overlay); }
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
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.detail-chip { display: inline-flex; align-items: center; padding: 0.35rem 0.6rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--tag-text); background: var(--tag-background); font-size: 0.78rem; }
.draggable-chip[draggable='true'] { cursor: grab; }
.draggable-chip[draggable='true']:active { cursor: grabbing; }
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
.author-suggestions { position: absolute; z-index: 5; top: calc(100% + 0.25rem); left: 0; display: grid; min-width: 100%; max-height: 12rem; overflow-y: auto; padding: 0.25rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; background: var(--surface); box-shadow: 0 0.65rem 1.5rem rgb(15 23 42 / 12%); }
.author-suggestions button { padding: 0.45rem 0.55rem; border: 0; border-radius: 0.4rem; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.author-suggestions button:hover, .author-suggestions button:focus-visible { color: var(--accent); background: var(--surface-muted); outline: none; }
.author-suggestions .muted { padding: 0.45rem 0.55rem; white-space: nowrap; }
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
.detail-usage-stats { display: inline-flex; align-items: baseline; gap: 0.8rem; flex-shrink: 0; color: var(--text-muted); font-size: 0.82rem; white-space: nowrap; }
.detail-usage-count { font-weight: 700; color: var(--text-primary); }
.entry-usage-note { color: var(--text-muted); }
.entry-stack { position: relative; }
.entry-like-badge { position: absolute; left: 0.4rem; bottom: 0.4rem; z-index: 1; padding: 0.1rem 0.45rem; border-radius: 999px; background: rgb(0 0 0 / 55%); color: #fff; font-size: 0.7rem; }
.error-message { padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }

@media (max-width: 44rem) {
  .app-header { align-items: flex-start; }
  .header-controls { flex-wrap: wrap; justify-content: flex-end; }
  .app-layout { grid-template-columns: 1fr; }
  .content-panel { min-height: 20rem; }
  .facet-row { grid-template-columns: minmax(4.75rem, 6rem) minmax(0, 1fr); }
  .facet-label-column { padding-right: 0.6rem; }
  .facet-tag-column { padding-left: 0.7rem; }
}
</style>
