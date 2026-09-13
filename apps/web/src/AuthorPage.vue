<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { normalizeTag } from '@t3/shared';
import type {
  AuthorDetailResponse,
  AuthorDirectoryDto,
  AuthorFilterOptions,
  EntrySourceRecordDto,
  EntryPageResponse,
  FacetFilterOptions,
  ProducerRecordDto,
  RatingRow,
} from '@t3/shared';
import type { GalleryApi } from './api/gallery.js';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import AppIcon from './components/AppIcon.vue';
import IconButton from './components/IconButton.vue';
import TagCombobox from './components/TagCombobox.vue';
import SuggestionInput from './components/SuggestionInput.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import EntryCard from './components/EntryCard.vue';
import CoverComposition from './components/CoverComposition.vue';
import { rowsPerPage, showNsfw } from './stores/preferences.js';
import { flattenCollectionOptions, type CollectionMenuOption } from './collection-tree.js';
import type { CollectionRecordDto } from '@t3/shared';
import { useI18n } from './i18n.js';
import { useArmableAction } from './armable.js';
import { shuffledCopy } from './random-sort.js';
import { toggleAuthorViewLater, viewLaterAuthorIds } from './stores/preferences.js';
import { useNavigationMemory } from './navigation-memory.js';
import { entryCardMediaRef } from './entry-media-stack.js';

interface AuthorSummary {
  id: number;
  name: string;
  covers: string[];
  galleryType: string | null;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
  nsfw: boolean;
}

type AuthorWork = AuthorDetailResponse['looseEntries'][number];
type AuthorWorkPageItem = EntryPageResponse['items'][number];
type DirectoryCard = { kind: 'directory'; directory: AuthorDirectoryDto };
type WorkCard = { kind: 'work'; work: AuthorWorkPageItem };
type AuthorCard = DirectoryCard | WorkCard;

const props = defineProps<{
  api: GalleryApi;
  authors: AuthorSummary[];
  initialAuthorId?: number | null;
  initialDirectoryId?: number | null;
  initialReturnScrollPositions?: number[];
  restoreInitialScroll?: boolean;
  backLabel?: string | null;
}>();
const emit = defineEmits<{
  'open-entry': [payload: {
    work: AuthorWork;
    authorId: number;
    authorName: string;
    directoryId: number | null;
    directoryName: string | null;
    returnScrollPositions: number[];
  }];
  'open-tag': [payload: {
    tagId: number;
    tagName: string;
    authorId: number;
    authorName: string;
    returnScrollPositions: number[];
  }];
  'back': [];
  'authors-changed': [];
  'works-changed': [];
}>();
const { t } = useI18n();
const { armedKey, arm, disarm } = useArmableAction();
const navigationMemory = useNavigationMemory();
const initialDetailState = props.initialAuthorId
  ? navigationMemory.states.get(`author-detail:${props.initialAuthorId}`) as {
      page?: number;
      sort?: string;
      filters?: GalleryFacetFilters;
    } | undefined
  : undefined;
const initialListState = navigationMemory.states.get('author-list') as {
  page?: number;
  typeFilter?: string;
  usageMode?: 'lastViewed' | 'mostViewed' | 'mostLiked' | 'random' | null;
  authorTagFilters?: Array<number | null>;
  workTagFilters?: Array<number | null>;
} | undefined;
const activeAuthor = ref<AuthorDetailResponse | null>(null);
const activeAuthorInViewLater = computed(() => (
  activeAuthor.value !== null && viewLaterAuthorIds.value.includes(activeAuthor.value.id)
));
const activeDirectoryId = ref<number | null>(null);
const returnScrollPositions: number[] = [...(props.initialReturnScrollPositions ?? [])];
let resolveInitialRender!: () => void;
const initialRenderReady = new Promise<void>((resolve) => {
  resolveInitialRender = resolve;
});

function rememberReturnScroll(): void {
  returnScrollPositions.push(Math.max(0, window.scrollY));
}

async function scrollCurrentViewToTop(): Promise<void> {
  await nextTick();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
}

async function restorePreviousScroll(): Promise<void> {
  const top = returnScrollPositions.pop() ?? 0;
  await nextTick();
  window.scrollTo({ top, left: 0, behavior: 'auto' });
}
const editingAuthor = ref(false);
const editingDirectory = ref(false);
const entryMergeMode = ref(false);
const entryMergeSelection = ref<AuthorWork[]>([]);
const entryMergeSources = ref<Record<number, EntrySourceRecordDto[]>>({});
const entryMergeConfirmationOpen = ref(false);
const entryMergeKeepId = ref<number | null>(null);
const entryMergeCopyTags = ref(true);
const entryMergeSelectedUrls = ref<string[]>([]);
const entryMergeTitleSourceId = ref<number | null>(null);
const entryMergeTitleDraft = ref('');
const entryMergeSubmitting = ref(false);
let entryMergeSourceRequestId = 0;
const page = ref(initialDetailState?.page ?? initialListState?.page ?? 1);
const draggedWorkId = ref<number | null>(null);
const dropTarget = ref<string | null>(null);
const error = ref<string | null>(null);
const authorName = ref('');
const authorOccupation = ref('');
const authorArtwork = ref('');
const authorContent = ref('');
const tagEditorOpen = ref(false);
// Producer Tag autocomplete: server-side eligibility/exclusions, same
// interaction contract as the Entry editors.
const authorTagExcludeIds = computed(() => (
  (activeAuthor.value?.tags ?? []).map((tag) => tag.tagId)
));

function suggestProducerTags(query: string, excludeIds: number[], signal: AbortSignal) {
  return props.api.suggestTags({ vocabulary: 'producer', q: query, excludeIds }, signal);
}

// Add-to-collection menu on the author detail toolbar (same pattern as the
// Entry detail toolbar).
const authorCollectionOptions = ref<CollectionMenuOption[]>([]);
const authorCollectionIds = ref<number[]>([]);
const authorCollectionMenuOpen = ref(false);
const authorCollectionRoot = ref<HTMLElement | null>(null);
function onDocumentPointerDownForAuthorCollection(event: PointerEvent): void {
  if (!authorCollectionMenuOpen.value) return;
  const root = authorCollectionRoot.value;
  if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
  authorCollectionMenuOpen.value = false;
}
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDownForAuthorCollection));
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDownForAuthorCollection));

async function toggleAuthorCollectionMenu(): Promise<void> {
  authorCollectionMenuOpen.value = !authorCollectionMenuOpen.value;
  if (authorCollectionMenuOpen.value && activeAuthor.value) {
    try {
      const [collectionTree, memberIds] = await Promise.all([
        props.api.listCollections('producer'),
        props.api.listCollectionsForProducer(activeAuthor.value.id),
      ]);
      authorCollectionOptions.value = flattenCollectionOptions(collectionTree);
      authorCollectionIds.value = memberIds;
    } catch {
      // Keep cached options; the menu still renders.
    }
  }
}

async function addAuthorToCollection(collectionId: number): Promise<void> {
  if (!activeAuthor.value) return;
  // Keep the menu open so several collections can be joined in a row; a tap
  // anywhere outside the menu closes it.
  error.value = null;
  try {
    await props.api.addCollectionProducer(collectionId, activeAuthor.value.id);
    authorCollectionIds.value = [...authorCollectionIds.value, collectionId];
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

async function removeAuthorFromCollection(collectionId: number): Promise<void> {
  if (!activeAuthor.value) return;
  // Keep the menu open so the ✓ clears in place and several collections can be left in a row.
  error.value = null;
  try {
    await props.api.removeCollectionProducer(collectionId, activeAuthor.value.id);
    authorCollectionIds.value = authorCollectionIds.value.filter((id) => id !== collectionId);
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createEntry');
  }
}

function toggleAuthorCollection(collection: CollectionMenuOption): void {
  if (authorCollectionIds.value.includes(collection.id)) {
    void removeAuthorFromCollection(collection.id);
    return;
  }
  void addAuthorToCollection(collection.id);
}

const ratingEditorOpen = ref(false);
const ratingName = ref('');
const editingTagId = ref<number | null>(null);
const editingTagName = ref('');
const directoryTitle = ref('');
const directoryDescription = ref('');

const activeDirectory = computed(() => activeAuthor.value?.directories
  .find((directory) => directory.id === activeDirectoryId.value) ?? null);
type AuthorSort = 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' | 'type' | 'random';
// Newest first by default, mirroring the gallery's date order.
const authorSort = ref<AuthorSort>((initialDetailState?.sort as AuthorSort | undefined) ?? 'date-desc');
// One page of loose works; Directories always render above them (they are
// drop targets, so they must never be pushed onto a later page).
// `.author-card-grid` renders a fixed 6 / 3 / 2 columns (see the styles below),
// so one server page must request exactly the rows that fit on screen:
// columns × the rows-per-page preference, doubled on phones where the grid is
// short — the same formula the shared card grid uses. A hardcoded page size left
// the last row half empty and paginated a screen early.
const worksColumns = ref(6);
const worksRowMultiplier = ref(1);

function measureWorksGrid(): void {
  if (typeof window.matchMedia !== 'function') return;
  worksColumns.value = window.matchMedia('(max-width: 30rem)').matches
    ? 2
    : window.matchMedia('(max-width: 52rem)').matches ? 3 : 6;
  worksRowMultiplier.value = window.matchMedia('(max-width: 44rem)').matches ? 2 : 1;
}

const pageSize = computed(() => worksColumns.value * rowsPerPage.value * worksRowMultiplier.value);
measureWorksGrid();
const workPageItems = ref<AuthorWorkPageItem[]>([]);
const workTotal = ref(0);
const workRequestId = ref(0);
const workRandomSeed = ref(Math.floor(Math.random() * 2_147_483_648));
const directoryReturnPage = ref(1);

function directoryDate(directory: AuthorDirectoryDto): number {
  return Math.max(0, ...directory.entries.map((entry) => entry.id));
}

function byTitle(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function compareAuthorCards(left: AuthorCard, right: AuthorCard): number {
  const direction = authorSort.value.endsWith('-desc') ? -1 : 1;
  const sortKey = authorSort.value === 'type' ? 'date-desc' : authorSort.value;
  const leftTitle = left.kind === 'directory' ? left.directory.title : left.work.title;
  const rightTitle = right.kind === 'directory' ? right.directory.title : right.work.title;
  if (sortKey.startsWith('title')) {
    return direction * byTitle(leftTitle, rightTitle);
  }
  const leftDate = left.kind === 'directory' ? directoryDate(left.directory) : left.work.id;
  const rightDate = right.kind === 'directory' ? directoryDate(right.directory) : right.work.id;
  const dateCompare = leftDate - rightDate;
  return direction * (dateCompare !== 0 ? dateCompare : byTitle(leftTitle, rightTitle));
}

const directoryCards = computed<DirectoryCard[]>(() => {
  if (!activeAuthor.value) return [];
  const cards = activeAuthor.value.directories
    .filter((directory) => (directory.entryCount ?? directory.entries.length) > 0)
    .map((directory) => ({ kind: 'directory' as const, directory }));
  return authorSort.value === 'random' ? shuffledCopy(cards) : cards.sort(compareAuthorCards);
});

const workCards = computed<WorkCard[]>(() => {
  return workPageItems.value.map((work) => ({ kind: 'work' as const, work }));
});

// When the facet filter is active, Directories are unfolded: every matching
// work (loose or inside a Directory) becomes one plain card in a single
// sorted/paginated grid, so filtering sees ALL works — the pinned Directory
// row only renders while no filter is active.

// Works filtering (same facet filter bar as the Gallery, minus the Authors
// row — the author is fixed). Options are aggregated server-side for THIS
// author's works inside his dominant Gallery type; the filter bar only
// appears when all of his works share one type.
const authorFilterOptions = ref<FacetFilterOptions | null>(null);
const authorFilters = ref<GalleryFacetFilters>(initialDetailState?.filters ?? {
  conditions: [],
  authorIds: [],
  ratingConditions: [],
  ratingSort: null,
  usageConditions: [],
  usageSort: null,
});
// Author list usage controls: filter by the dominant Gallery type and toggle
// between Last viewed (★) and Most viewed (♥). null = no usage note shown.
const authorTypeFilter = ref(initialListState?.typeFilter ?? '');
const authorUsageMode = ref<'lastViewed' | 'mostViewed' | 'mostLiked' | 'random' | null>(initialListState?.usageMode ?? null);
const authorRandomSeed = ref(Math.floor(Math.random() * 2_147_483_648));
const authorListFilterOptions = ref<AuthorFilterOptions>({ authorTags: [], workTags: [] });
const authorTagFilters = ref<Array<number | null>>(initialListState?.authorTagFilters ?? []);
const workTagFilters = ref<Array<number | null>>(initialListState?.workTagFilters ?? []);
const authorPageItems = ref<AuthorSummary[]>([]);
const authorListTotal = ref(0);
const authorListPage = ref(initialListState?.page ?? 1);
const authorListPageSize = ref(30);
let authorListFilterRequest = 0;

function rememberAuthorNavigationState(): void {
  if (activeAuthor.value) {
    navigationMemory.states.set(`author-detail:${activeAuthor.value.id}`, {
      page: page.value,
      sort: authorSort.value,
      filters: JSON.parse(JSON.stringify(authorFilters.value)) as GalleryFacetFilters,
    });
    return;
  }
  navigationMemory.states.set('author-list', {
    page: authorListPage.value,
    typeFilter: authorTypeFilter.value,
    usageMode: authorUsageMode.value,
    authorTagFilters: [...authorTagFilters.value],
    workTagFilters: [...workTagFilters.value],
  });
}

const authorGalleryTypes = computed<string[]>(() => (
  [...new Set(props.authors.map((author) => author.galleryType).filter((type): type is string => type !== null))]
));

const visibleAuthors = computed(() => authorPageItems.value);

function selectedTagIds(rows: Array<number | null>): number[] {
  return [...new Set(rows.filter((tagId): tagId is number => tagId !== null))];
}

async function loadAuthorListFilterOptions(): Promise<void> {
  try {
    authorListFilterOptions.value = await props.api.listAuthorFilterOptions(undefined, showNsfw.value);
  } catch {
    authorListFilterOptions.value = { authorTags: [], workTags: [] };
  }
}

async function applyAuthorListFilters(resetPage = true): Promise<void> {
  const ownTagIds = selectedTagIds(authorTagFilters.value);
  const relatedEntryTagIds = selectedTagIds(workTagFilters.value);
  if (resetPage) authorListPage.value = 1;
  const request = ++authorListFilterRequest;
  error.value = null;
  const sort = authorUsageMode.value === 'random'
    ? 'random' as const
    : authorUsageMode.value === 'mostViewed'
      ? 'views-desc' as const
      : authorUsageMode.value === 'mostLiked'
        ? 'likes-desc' as const
        : authorUsageMode.value === 'lastViewed'
          ? 'last-viewed-desc' as const
          : 'name-asc' as const;
  try {
    const result = await props.api.queryProducerPage({
      ...(authorTypeFilter.value ? { entryType: authorTypeFilter.value } : {}),
      ownTagIds,
      relatedEntryTagIds,
      includeNsfw: showNsfw.value,
      sort,
      ...(sort === 'random' ? { randomSeed: authorRandomSeed.value } : {}),
      page: authorListPage.value,
      pageSize: authorListPageSize.value,
    });
    if (request === authorListFilterRequest) {
      authorPageItems.value = result.items;
      authorListTotal.value = result.total;
    }
  } catch (cause) {
    if (request !== authorListFilterRequest) return;
    error.value = cause instanceof Error ? cause.message : t('author.listFilterError');
    authorPageItems.value = [];
    authorListTotal.value = 0;
  }
}

function changeAuthorListPage(nextPage: number): void {
  authorListPage.value = nextPage;
  void applyAuthorListFilters(false);
}

function changeAuthorListPageSize(nextPageSize: number): void {
  if (authorListPageSize.value === nextPageSize) return;
  authorListPageSize.value = nextPageSize;
  authorListPage.value = 1;
  void applyAuthorListFilters(false);
}

function addAuthorTagFilter(): void {
  if (authorTagFilters.value.length >= authorListFilterOptions.value.authorTags.length) return;
  authorTagFilters.value.push(null);
}

function addWorkTagFilter(): void {
  if (workTagFilters.value.length >= authorListFilterOptions.value.workTags.length) return;
  workTagFilters.value.push(null);
}

function tagSelectedInAnotherRow(rows: Array<number | null>, tagId: number, index: number): boolean {
  return rows.some((selected, selectedIndex) => selectedIndex !== index && selected === tagId);
}

function removeAuthorTagFilter(index: number): void {
  authorTagFilters.value.splice(index, 1);
  void applyAuthorListFilters();
}

function removeWorkTagFilter(index: number): void {
  workTagFilters.value.splice(index, 1);
  void applyAuthorListFilters();
}

watch(showNsfw, async () => {
  await loadAuthorListFilterOptions();
  const availableAuthorTags = new Set(authorListFilterOptions.value.authorTags.map((tag) => tag.tagId));
  const availableWorkTags = new Set(authorListFilterOptions.value.workTags.map((tag) => tag.tagId));
  authorTagFilters.value = authorTagFilters.value
    .filter((tagId) => tagId === null || availableAuthorTags.has(tagId));
  workTagFilters.value = workTagFilters.value
    .filter((tagId) => tagId === null || availableWorkTags.has(tagId));
  await applyAuthorListFilters();
});

watch([authorTypeFilter, authorUsageMode], ([_nextType, nextMode], [_previousType, previousMode]) => {
  if (nextMode === 'random' && previousMode !== 'random') {
    authorRandomSeed.value = Math.floor(Math.random() * 2_147_483_648);
  }
  void applyAuthorListFilters();
});

function formatDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? isoTimestamp.slice(0, 10) : date.toISOString().slice(0, 10);
}

function authorWorkUsageNote(work: AuthorWork): string | null {
  const field = authorFilters.value.usageSort?.field
    ?? authorFilters.value.usageConditions.at(-1)?.field;
  if (field === 'views') return t('usage.viewCount', { count: work.viewCount });
  if (field === 'lastViewed') {
    return work.lastViewedAt ? t('usage.lastViewed', { date: formatDate(work.lastViewedAt) }) : t('usage.lastViewed', { date: '—' });
  }
  if (field === 'likes') return `👍 ${work.likeCount}`;
  return null;
}

const authorFilterType = computed<string | null>(() => {
  const types = activeAuthor.value?.workTypes
    ?? [
      ...(activeAuthor.value?.looseEntries ?? []).map((work) => work.type),
      ...(activeAuthor.value?.directories ?? []).flatMap((directory) => directory.entries.map((entry) => entry.type)),
    ];
  const uniqueTypes = new Set(types);
  return uniqueTypes.size === 1 ? [...uniqueTypes][0]! : null;
});
const filterActive = computed<boolean>(() => (
  authorFilters.value.conditions.some((condition) => condition.tagIds.length > 0)
  || authorFilters.value.ratingConditions.length > 0
  || authorFilters.value.ratingSort !== null
  || authorFilters.value.usageConditions.length > 0
  || authorFilters.value.usageSort !== null
));
const authorHasWorks = computed(() => {
  if (!activeAuthor.value) return false;
  const looseCount = activeAuthor.value.looseEntryCount ?? activeAuthor.value.looseEntries.length;
  return looseCount > 0 || activeAuthor.value.directories.some(
    (directory) => (directory.entryCount ?? directory.entries.length) > 0,
  );
});

async function loadAuthorWorks(resetPage = false): Promise<void> {
  const author = activeAuthor.value;
  if (!author) {
    workPageItems.value = [];
    workTotal.value = 0;
    return;
  }
  if (resetPage) page.value = 1;
  const requestId = ++workRequestId.value;
  const mergeAllWorks = entryMergeMode.value && activeDirectoryId.value === null;
  const useFilters = !mergeAllWorks
    && filterActive.value
    && activeDirectoryId.value === null
    && authorFilterType.value !== null;
  const result = await props.api.queryEntryPage({
    ...(useFilters && authorFilterType.value ? { entryType: authorFilterType.value } : {}),
    ...(activeDirectoryId.value !== null
      ? { producerDirectoryId: activeDirectoryId.value }
      : mergeAllWorks
        ? {}
      : useFilters
        ? {}
        : { looseForProducerId: author.id }),
    authorIds: useFilters || mergeAllWorks ? [author.id] : [],
    conditions: useFilters ? authorFilters.value.conditions.filter((condition) => condition.tagIds.length > 0) : [],
    ratingConditions: useFilters ? authorFilters.value.ratingConditions : [],
    ratingSort: useFilters ? authorFilters.value.ratingSort : null,
    usageConditions: useFilters ? authorFilters.value.usageConditions : [],
    usageSort: useFilters ? authorFilters.value.usageSort : null,
    sort: authorSort.value,
    ...(authorSort.value === 'random' ? { randomSeed: workRandomSeed.value } : {}),
    page: page.value,
    pageSize: pageSize.value,
  });
  if (requestId !== workRequestId.value) return;
  const maxPage = Math.max(1, Math.ceil(result.total / pageSize.value));
  if (page.value > maxPage) {
    page.value = maxPage;
    await loadAuthorWorks(false);
    return;
  }
  workPageItems.value = result.items;
  workTotal.value = result.total;
}

async function setWorkPage(nextPage: number): Promise<void> {
  page.value = Math.min(Math.max(1, nextPage), pageCount.value);
  await loadAuthorWorks(false);
  await scrollCurrentViewToTop();
}

watch(pageSize, (nextSize, previousSize) => {
  if (nextSize === previousSize || activeAuthor.value === null) return;
  page.value = 1;
  void loadAuthorWorks(false);
});

watch(authorSort, (nextSort, previousSort) => {
  if (nextSort === 'random' && previousSort !== 'random') {
    workRandomSeed.value = Math.floor(Math.random() * 2_147_483_648);
  }
  void loadAuthorWorks(true);
});

async function resetAuthorFilters(): Promise<void> {
  authorFilters.value = { conditions: [], authorIds: [], ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null };
  authorFilterOptions.value = null;
  const type = authorFilterType.value;
  if (activeAuthor.value && type) {
    try {
      authorFilterOptions.value = await props.api.listFacetFilterOptions(type, activeAuthor.value.id);
    } catch {
      authorFilterOptions.value = null;
    }
  }
  await loadAuthorWorks(true);
}

async function onAuthorFiltersChange(filters: GalleryFacetFilters): Promise<void> {
  authorFilters.value = filters;
  try {
    await loadAuthorWorks(true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('author.filterError');
  }
}

// Filtered view unfolds Directories and displays one bounded server page of
// matching works. The regular view keeps Directories pinned above loose works.
const filterFlat = computed<boolean>(() => filterActive.value || entryMergeMode.value);
const displayCards = computed<WorkCard[]>(() => workCards.value);
const hasAnyCards = computed(() => (
  workTotal.value > 0 || (!filterFlat.value && directoryCards.value.length > 0)
));
const pageCount = computed(() => Math.max(1, Math.ceil(workTotal.value / pageSize.value)));
const visibleWorkCards = computed<WorkCard[]>(() => displayCards.value);
const authorCoverCovers = computed<string[]>(() => {
  if (!activeAuthor.value) return [];
  if (activeAuthor.value.workCoverRefs) return activeAuthor.value.workCoverRefs;
  const works: Array<{ coverRef: string | null; id: number }> = [
    ...activeAuthor.value.looseEntries.map((work) => ({ coverRef: work.coverRef, id: work.id })),
    ...activeAuthor.value.directories.flatMap((directory) => directory.entries.map((entry) => ({
      coverRef: entry.coverRef,
      id: entry.id,
    }))),
  ];
  return works
    .filter((work) => !!work.coverRef)
    .sort((a, b) => a.id - b.id)
    .slice(0, 4)
    .map((work) => work.coverRef as string);
});

// Other-language spellings of an author's name (e.g. "bob" under "鲍勃"),
// derived from the 'producer'-vocabulary taxonomy dictionary. Shown as a
// faded sub-line under the display name on author cards.
const authorAlternates = ref<Map<string, string[]>>(new Map());

function alternatesFor(name: string): string {
  return (authorAlternates.value.get(normalizeTag(name)) ?? []).join(' / ');
}

async function loadAuthorAlternates(): Promise<void> {
  try {
    const aliases = await props.api.listTaxonomyAliases('producer');
    const map = new Map<string, string[]>();
    for (const alias of aliases) {
      // Placeholder rows (imported name, canonical not filled yet) carry no
      // canonical and must not appear under any author's alternates.
      if (alias.normalizedCanonical === '') continue;
      const key = alias.normalizedCanonical;
      const names = map.get(key) ?? [];
      if (!names.includes(alias.alias)) names.push(alias.alias);
      map.set(key, names);
    }
    authorAlternates.value = map;
  } catch {
    authorAlternates.value = new Map();
  }
}

async function refreshAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  const [detail, collectionOptions, memberIds] = await Promise.all([
    props.api.getAuthor(activeAuthor.value.id),
    props.api.listCollections('producer'),
    props.api.listCollectionsForProducer(activeAuthor.value.id),
  ]);
  authorCollectionOptions.value = flattenCollectionOptions(collectionOptions);
  authorCollectionIds.value = memberIds;
  activeAuthor.value = detail;
  await loadAuthorWorks(false);
  if (page.value > pageCount.value) {
    page.value = pageCount.value;
    await loadAuthorWorks(false);
  }
}

async function openAuthor(
  authorId: number,
  rememberListScroll = true,
  scrollToTop = true,
): Promise<void> {
  if (rememberListScroll) {
    rememberAuthorNavigationState();
    rememberReturnScroll();
  }
  error.value = null;
  try {
    resetEntryMergeState();
    activeAuthor.value = await props.api.getAuthor(authorId);
    activeDirectoryId.value = null;
    editingAuthor.value = false;
    page.value = 1;
    await resetAuthorFilters();
    if (scrollToTop) await scrollCurrentViewToTop();
  } catch (cause) {
    if (rememberListScroll) returnScrollPositions.pop();
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthor');
  }
}

function openWork(work: AuthorWork): void {
  if (!activeAuthor.value) return;
  rememberAuthorNavigationState();
  emit('open-entry', {
    work,
    authorId: activeAuthor.value.id,
    authorName: activeAuthor.value.name,
    directoryId: activeDirectoryId.value,
    directoryName: activeDirectory.value?.title ?? null,
    returnScrollPositions: [...returnScrollPositions],
  });
}

function openAuthorTag(tagId: number, tagName: string): void {
  if (!activeAuthor.value || editingAuthor.value) return;
  rememberAuthorNavigationState();
  emit('open-tag', {
    tagId,
    tagName,
    authorId: activeAuthor.value.id,
    authorName: activeAuthor.value.name,
    returnScrollPositions: [...returnScrollPositions],
  });
}

onMounted(async () => {
  window.addEventListener('resize', measureWorksGrid);
  try {
    await Promise.all([loadAuthorAlternates(), loadAuthorListFilterOptions(), applyAuthorListFilters(false)]);
    if (props.initialAuthorId) {
      await openAuthor(props.initialAuthorId, false, !props.restoreInitialScroll);
      if (initialDetailState?.filters) {
        await onAuthorFiltersChange(initialDetailState.filters);
      }
      if (!props.initialDirectoryId) {
        page.value = Math.min(initialDetailState?.page ?? 1, pageCount.value);
        await loadAuthorWorks(false);
      }
      if (props.initialDirectoryId) {
        activeDirectoryId.value = props.initialDirectoryId;
        page.value = initialDetailState?.page ?? 1;
        await loadAuthorWorks(false);
      }
    }
  } finally {
    await nextTick();
    resolveInitialRender();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', measureWorksGrid);
});

async function closeAuthor(): Promise<void> {
  if (props.backLabel || (
    props.initialAuthorId !== null
    && props.initialAuthorId !== undefined
    && returnScrollPositions.length === 0
  )) {
    emit('back');
    return;
  }
  activeAuthor.value = null;
  activeDirectoryId.value = null;
  editingAuthor.value = false;
  editingDirectory.value = false;
  resetEntryMergeState();
  clearDragState();
  await restorePreviousScroll();
}

function beginAuthorEdit(): void {
  if (!activeAuthor.value) return;
  clearDragState();
  authorName.value = activeAuthor.value.name;
  authorOccupation.value = activeAuthor.value.occupation ?? '';
  authorArtwork.value = activeAuthor.value.artworkRef ?? '';
  authorContent.value = activeAuthor.value.content ?? '';
  ratingEditorOpen.value = false;
  resetEntryMergeState();
  editingAuthor.value = true;
}

async function saveAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    await props.api.updateAuthor(activeAuthor.value.id, {
      name: authorName.value,
      occupation: authorOccupation.value || null,
      artworkRef: authorArtwork.value || null,
      content: authorContent.value || null,
    });
    editingAuthor.value = false;
    resetEntryMergeState();
    clearDragState();
    await refreshAuthor();
    emit('authors-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateAuthor');
  }
}

async function deleteActiveAuthor(): Promise<void> {
  if (!activeAuthor.value) return;
  if (!arm('delete-author')) return;
  disarm('delete-author');
  error.value = null;
  try {
    await props.api.deleteAuthor(activeAuthor.value.id);
    emit('authors-changed');
    closeAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.deleteAuthor');
  }
}

async function toggleActiveAuthorViewLater(): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    await toggleAuthorViewLater(props.api, activeAuthor.value.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthors');
  }
}

async function addTag(name: string): Promise<void> {
  if (!activeAuthor.value || name.trim() === '') return;
  error.value = null;
  try {
    await props.api.assignAuthorTag(activeAuthor.value.id, name);
    tagEditorOpen.value = false;
    await refreshAuthor();
    await loadAuthorListFilterOptions();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.addAuthorTag');
  }
}

function applyAuthorRatingRow(row: RatingRow): void {
  const author = activeAuthor.value;
  if (!author) return;
  author.ratings = author.ratings.map((item) => (item.slotId === row.slotId ? row : item));
}

async function createAuthorRatingSlot(): Promise<void> {
  if (!activeAuthor.value || !ratingName.value.trim()) return;
  error.value = null;
  try {
    await props.api.createAuthorRatingSlot(activeAuthor.value.id, ratingName.value.trim());
    ratingName.value = '';
    ratingEditorOpen.value = false;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createRatingSlot');
  }
}

async function chooseAuthorStars(slotId: number, stars: number): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    applyAuthorRatingRow(await props.api.setAuthorRating(activeAuthor.value.id, slotId, stars));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.setRating');
  }
}

async function clearAuthorStars(slotId: number): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    applyAuthorRatingRow(await props.api.setAuthorRating(activeAuthor.value.id, slotId, null));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.setRating');
  }
}

async function moveAuthorRatingSlot(slotId: number, direction: -1 | 1): Promise<void> {
  const author = activeAuthor.value;
  if (!author) return;
  const orderedIds = author.ratings.map((row) => row.slotId);
  const index = orderedIds.indexOf(slotId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= orderedIds.length) return;
  [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
  error.value = null;
  try {
    // The order is shared per dominant-Gallery partition, like the slots.
    await props.api.reorderAuthorRatingSlots(author.id, orderedIds);
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.reorderRating');
  }
}

function beginTagRename(tag: AuthorDetailResponse['tags'][number]): void {
  if (!editingAuthor.value) return;
  editingTagId.value = tag.tagId;
  editingTagName.value = tag.name;
}

async function saveTagRename(tagId: number): Promise<void> {
  if (!activeAuthor.value || editingTagId.value !== tagId || !editingTagName.value.trim()) return;
  try {
    await props.api.renameAuthorTag(activeAuthor.value.id, tagId, editingTagName.value);
    editingTagId.value = null;
    editingTagName.value = '';
    await refreshAuthor();
    await loadAuthorListFilterOptions();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.renameAuthorTag');
  }
}

async function removeTag(tagId: number): Promise<void> {
  if (!activeAuthor.value) return;
  try {
    await props.api.removeAuthorTag(activeAuthor.value.id, tagId);
    await refreshAuthor();
    await loadAuthorListFilterOptions();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeAuthorTag');
  }
}

function nextDirectoryTitle(): string {
  const base = t('directory.defaultTitle');
  const titles = new Set(activeAuthor.value?.directories.map((directory) => directory.title) ?? []);
  if (!titles.has(base)) return base;
  let suffix = 2;
  while (titles.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

async function createDirectory(entryIds?: number[]): Promise<void> {
  if (!activeAuthor.value) return;
  error.value = null;
  try {
    await props.api.createAuthorDirectory(activeAuthor.value.id, {
      title: nextDirectoryTitle(),
      ...(entryIds ? { entryIds } : {}),
    });
    draggedWorkId.value = null;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.createDirectory');
  }
}

function resetEntryMergeState(): void {
  entryMergeSourceRequestId += 1;
  entryMergeMode.value = false;
  entryMergeSelection.value = [];
  entryMergeSources.value = {};
  entryMergeConfirmationOpen.value = false;
  entryMergeKeepId.value = null;
  entryMergeCopyTags.value = true;
  entryMergeSelectedUrls.value = [];
  entryMergeTitleSourceId.value = null;
  entryMergeTitleDraft.value = '';
  entryMergeSubmitting.value = false;
}

async function beginEntryMerge(): Promise<void> {
  if (!editingAuthor.value || !activeAuthor.value) return;
  resetEntryMergeState();
  entryMergeMode.value = true;
  clearDragState();
  await loadAuthorWorks(true);
}

async function cancelEntryMerge(): Promise<void> {
  const wasActive = entryMergeMode.value;
  resetEntryMergeState();
  if (wasActive && activeAuthor.value) await loadAuthorWorks(true);
}

function isEntryMergeSelected(entryId: number): boolean {
  return entryMergeSelection.value.some((work) => work.id === entryId);
}

function chooseEntryMergeKeeper(entryId: number): void {
  if (!entryMergeSelection.value.some((work) => work.id === entryId)) return;
  entryMergeKeepId.value = entryId;
  const absorbed = entryMergeSelection.value.find((work) => work.id !== entryId);
  entryMergeSelectedUrls.value = absorbed
    ? (entryMergeSources.value[absorbed.id] ?? []).map((source) => source.url)
    : [];
  // 换保留对象时标题默认跟着它走，仍可再改成另一条的标题或直接改写。
  chooseEntryMergeTitleSource(entryId);
}

function chooseEntryMergeTitleSource(entryId: number): void {
  if (!entryMergeSelection.value.some((work) => work.id === entryId)) return;
  entryMergeTitleSourceId.value = entryId;
  entryMergeTitleDraft.value = entryMergeSelection.value.find((work) => work.id === entryId)?.title ?? '';
}

function entryMergeSourcesFor(entryId: number): EntrySourceRecordDto[] {
  return entryMergeSources.value[entryId] ?? [];
}

const entryMergeTitleInvalid = computed(() => entryMergeTitleDraft.value.trim().length === 0);

function entryMergeAbsorbedWork(): AuthorWork | null {
  if (entryMergeKeepId.value === null) return null;
  return entryMergeSelection.value.find((work) => work.id !== entryMergeKeepId.value) ?? null;
}

function entryMergeAvailableSources(): EntrySourceRecordDto[] {
  const absorbed = entryMergeAbsorbedWork();
  return absorbed ? (entryMergeSources.value[absorbed.id] ?? []) : [];
}

async function selectEntryForMerge(work: AuthorWork): Promise<void> {
  if (!entryMergeMode.value) return;
  entryMergeSourceRequestId += 1;
  const selectedIndex = entryMergeSelection.value.findIndex((item) => item.id === work.id);
  if (selectedIndex >= 0) {
    entryMergeSelection.value = entryMergeSelection.value.filter((item) => item.id !== work.id);
    entryMergeConfirmationOpen.value = false;
    entryMergeKeepId.value = null;
    entryMergeSelectedUrls.value = [];
    return;
  }
  const first = entryMergeSelection.value[0];
  if (first && first.type !== work.type) {
    error.value = t('entryMerge.sameGallery');
    return;
  }
  if (entryMergeSelection.value.length >= 2) return;
  entryMergeSelection.value = [...entryMergeSelection.value, work];
  if (entryMergeSelection.value.length !== 2) return;

  const selectedWorks = [...entryMergeSelection.value] as [AuthorWork, AuthorWork];
  const selectedAuthorId = activeAuthor.value?.id ?? null;
  const requestId = entryMergeSourceRequestId;
  error.value = null;
  try {
    const [firstSources, secondSources] = await Promise.all([
      props.api.listEntrySources(selectedWorks[0].id),
      props.api.listEntrySources(selectedWorks[1].id),
    ]);
    if (
      requestId !== entryMergeSourceRequestId
      || !entryMergeMode.value
      || activeAuthor.value?.id !== selectedAuthorId
      || entryMergeSelection.value.length !== 2
      || entryMergeSelection.value[0]?.id !== selectedWorks[0].id
      || entryMergeSelection.value[1]?.id !== selectedWorks[1].id
    ) return;
    entryMergeSources.value = {
      [selectedWorks[0].id]: firstSources,
      [selectedWorks[1].id]: secondSources,
    };
    chooseEntryMergeKeeper(selectedWorks[0].id);
    entryMergeConfirmationOpen.value = true;
  } catch (cause) {
    if (requestId !== entryMergeSourceRequestId) return;
    error.value = cause instanceof Error ? cause.message : t('entryMerge.loadError');
  }
}

async function confirmEntryMerge(): Promise<void> {
  const author = activeAuthor.value;
  const absorbed = entryMergeAbsorbedWork();
  const title = entryMergeTitleDraft.value.trim();
  if (!author || entryMergeKeepId.value === null || !absorbed || !title || entryMergeSubmitting.value) return;
  entryMergeSubmitting.value = true;
  error.value = null;
  try {
    const result = await props.api.mergeAuthorEntries({
      authorId: author.id,
      keepEntryId: entryMergeKeepId.value,
      absorbEntryId: absorbed.id,
      copyTags: entryMergeCopyTags.value,
      title,
      sourceUrls: entryMergeSelectedUrls.value,
    });
    resetEntryMergeState();
    await refreshAuthor();
    if (result.mediaCleanupFailed) error.value = t('entryMerge.mediaCleanupWarning');
    emit('works-changed');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('entryMerge.mergeError');
    entryMergeSubmitting.value = false;
  }
}

function beginWorkDrag(workId: number): void {
  if (editingAuthor.value && !entryMergeMode.value) draggedWorkId.value = workId;
}

function selectLooseWork(workId: number): void {
  if (!editingAuthor.value || filterFlat.value) return;
  draggedWorkId.value = draggedWorkId.value === workId ? null : workId;
  dropTarget.value = null;
}

function openOrSelectLooseWork(work: AuthorWork): void {
  if (entryMergeMode.value) {
    void selectEntryForMerge(work);
    return;
  }
  if (editingAuthor.value && !filterFlat.value) {
    selectLooseWork(work.id);
    return;
  }
  openWork(work);
}

function cardKey(card: AuthorCard): string {
  return `${card.kind}-${card.kind === 'work' ? card.work.id : card.directory.id}`;
}

function markDropTarget(card: AuthorCard): void {
  if (editingAuthor.value && !entryMergeMode.value && draggedWorkId.value !== null) dropTarget.value = cardKey(card);
}

function clearDragState(): void {
  draggedWorkId.value = null;
  dropTarget.value = null;
}

async function finishAuthorEdit(): Promise<void> {
  if (entryMergeMode.value) await cancelEntryMerge();
  editingAuthor.value = false;
  clearDragState();
}

async function groupWorksIntoDirectory(targetWorkId: number): Promise<void> {
  const sourceWorkId = draggedWorkId.value;
  if (entryMergeMode.value || !editingAuthor.value || sourceWorkId === null || sourceWorkId === targetWorkId) return;
  dropTarget.value = null;
  await createDirectory([sourceWorkId, targetWorkId]);
}

async function moveToDirectory(directoryId: number): Promise<void> {
  if (entryMergeMode.value || !editingAuthor.value || !activeAuthor.value || draggedWorkId.value === null) return;
  const workId = draggedWorkId.value;
  clearDragState();
  try {
    await props.api.moveEntryToAuthorDirectory(activeAuthor.value.id, directoryId, workId);
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.moveToDirectory');
  }
}

async function openDirectory(directory: AuthorDirectoryDto): Promise<void> {
  if (entryMergeMode.value) return;
  rememberReturnScroll();
  directoryReturnPage.value = page.value;
  activeDirectoryId.value = directory.id;
  page.value = 1;
  editingDirectory.value = false;
  await loadAuthorWorks(false);
  await scrollCurrentViewToTop();
}

async function closeDirectory(): Promise<void> {
  activeDirectoryId.value = null;
  page.value = directoryReturnPage.value;
  editingDirectory.value = false;
  clearDragState();
  await loadAuthorWorks(false);
  await restorePreviousScroll();
}

async function goBack(): Promise<void> {
  if (activeDirectory.value) await closeDirectory();
  else await closeAuthor();
}

async function waitUntilReady(): Promise<void> {
  await initialRenderReady;
  await nextTick();
}

defineExpose({ goBack, waitUntilReady });

function beginDirectoryEdit(): void {
  if (!activeDirectory.value) return;
  clearDragState();
  directoryTitle.value = activeDirectory.value.title;
  directoryDescription.value = activeDirectory.value.description;
  editingDirectory.value = true;
}

function openOrSelectDirectoryWork(work: AuthorWork): void {
  if (editingDirectory.value) {
    draggedWorkId.value = draggedWorkId.value === work.id ? null : work.id;
    dropTarget.value = null;
    return;
  }
  openWork(work);
}

async function saveDirectory(): Promise<void> {
  if (!activeDirectory.value) return;
  try {
    await props.api.updateAuthorDirectory(activeDirectory.value.id, {
      title: directoryTitle.value,
      description: directoryDescription.value,
    });
    editingDirectory.value = false;
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.updateDirectory');
  }
}

async function removeFromDirectory(): Promise<void> {
  if (!activeAuthor.value || !activeDirectory.value || draggedWorkId.value === null) return;
  const workId = draggedWorkId.value;
  clearDragState();
  try {
    await props.api.removeEntryFromAuthorDirectory(
      activeAuthor.value.id,
      activeDirectory.value.id,
      workId,
    );
    await refreshAuthor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.removeFromDirectory');
  }
}
</script>

<template>
  <section class="author-page" data-testid="author-page">
    <p v-if="error" class="author-error" role="alert">{{ error }}</p>

    <template v-if="activeDirectory && activeAuthor">
      <div class="author-toolbar">
        <button type="button" class="text-button" @click="closeDirectory">
          {{ t('directory.back', { author: activeAuthor.name }) }}
        </button>
        <IconButton
          v-if="!editingDirectory"
          data-testid="start-directory-editing"
          icon="edit"
          :label="t('directory.edit')"
          @click="beginDirectoryEdit"
        />
        <div v-else class="directory-edit-actions">
          <button
            data-testid="finish-directory-editing"
            type="button"
            class="secondary-button"
            @click="saveDirectory"
          >
            {{ t('directory.done') }}
          </button>
          <button
            data-testid="directory-remove-target"
            type="button"
            class="directory-remove-target"
            :class="{ 'drop-target': draggedWorkId !== null }"
            :disabled="draggedWorkId === null"
            @click="removeFromDirectory"
            @dragover.prevent
            @drop.prevent="removeFromDirectory"
          >
            {{ t('directory.removeWork') }}
          </button>
        </div>
      </div>
      <div
        v-if="editingDirectory"
        data-testid="directory-edit-form"
        class="author-edit-form"
      >
        <label>{{ t('directory.title') }}<input v-model="directoryTitle" name="directoryTitle" required></label>
        <label>{{ t('directory.description') }}<textarea v-model="directoryDescription" name="directoryDescription" rows="4" /></label>
      </div>
      <header v-else class="directory-heading">
        <h2>{{ activeDirectory.title }}</h2>
        <p>{{ activeDirectory.description }}</p>
      </header>
      <p
        v-if="editingDirectory"
        data-testid="directory-work-move-hint"
        class="work-move-hint"
      >{{ t('directory.removeHint') }}</p>
      <p v-if="workTotal === 0" class="muted">{{ t('directory.empty') }}</p>
      <div v-else class="author-card-grid">
        <EntryCard
          v-for="work in workPageItems"
          :key="work.id"
          :api="api"
          :entry="work"
          :pressed="editingDirectory ? draggedWorkId === work.id : undefined"
          main-class="author-card-main"
          class="author-card"
          :class="{ 'selected-work': draggedWorkId === work.id }"
          :data-directory-work-id="work.id"
          :draggable="editingDirectory"
          @dragstart="editingDirectory && (draggedWorkId = work.id)"
          @dragend="clearDragState"
          @open="openOrSelectDirectoryWork(work)"
        />
      </div>
      <nav v-if="pageCount > 1" class="pagination">
        <button type="button" :disabled="page === 1" @click="setWorkPage(page - 1)">{{ t('author.previousPage') }}</button>
        <span>{{ t('author.page', { page, pages: pageCount }) }}</span>
        <button type="button" :disabled="page === pageCount" @click="setWorkPage(page + 1)">{{ t('author.nextPage') }}</button>
      </nav>
    </template>

    <template v-else-if="activeAuthor">
      <section data-testid="author-information-board" class="author-information-board">
        <div class="author-toolbar">
          <button type="button" class="text-button" @click="closeAuthor">
            {{ props.backLabel ?? t('author.backToList') }}
          </button>
          <IconButton
            v-if="!editingAuthor"
            data-testid="start-author-editing"
            icon="edit"
            :label="t('author.edit')"
            @click="beginAuthorEdit"
          />
          <button
            v-else
            data-testid="finish-author-editing"
            type="button"
            class="secondary-button"
            @click="finishAuthorEdit"
          >
            {{ t('author.done') }}
          </button>
          <div ref="authorCollectionRoot" class="add-to-collection" data-testid="author-add-to-collection">
            <IconButton
              icon="folder-plus"
              :label="t('a11y.addToCollection')"
              :active="authorCollectionMenuOpen"
              aria-haspopup="menu"
              :aria-expanded="authorCollectionMenuOpen"
              :aria-controls="authorCollectionMenuOpen ? 'author-collection-menu' : undefined"
              @click="toggleAuthorCollectionMenu"
            />
            <div
              v-if="authorCollectionMenuOpen"
              id="author-collection-menu"
              class="add-to-collection-menu"
              role="menu"
            >
              <p v-if="authorCollectionOptions.length === 0" class="muted">
                {{ t('collections.empty') }}
              </p>
                <button
                  v-for="collection in authorCollectionOptions"
                  :key="collection.id"
                  type="button"
                  role="menuitemcheckbox"
                  class="add-to-collection-option"
                  :class="{ 'is-member': authorCollectionIds.includes(collection.id) }"
                  :aria-checked="authorCollectionIds.includes(collection.id)"
                  :title="authorCollectionIds.includes(collection.id)
                    ? t('collections.leaveHint')
                    : t('collections.joinHint')"
                  @click="toggleAuthorCollection(collection)"
                >
                  {{ authorCollectionIds.includes(collection.id) ? '✓ ' : '' }}{{ collection.title }}
                </button>
            </div>
          </div>
          <IconButton
            v-if="!editingAuthor"
            :icon="activeAuthorInViewLater ? 'view-later-check' : 'view-later'"
            :label="activeAuthorInViewLater ? t('entry.viewLaterRemove') : t('entry.viewLater')"
            :active="activeAuthorInViewLater"
            :aria-pressed="activeAuthorInViewLater"
            data-testid="author-view-later-button"
            @click="toggleActiveAuthorViewLater"
          />
          <button
            v-if="editingAuthor"
            data-testid="delete-author"
            type="button"
            class="secondary-button danger-button"
            :class="{ 'armable-armed': armedKey === 'delete-author' }"
            @click="deleteActiveAuthor"
          >
            {{ armedKey === 'delete-author' ? t('author.deleteConfirmShort', { name: activeAuthor?.name }) : t('author.delete') }}
          </button>
        </div>
        <form v-if="editingAuthor" class="author-edit-form" @submit.prevent="saveAuthor">
          <label>{{ t('author.name') }}<input v-model="authorName" name="authorName" required></label>
          <label>{{ t('author.occupation') }}<input v-model="authorOccupation" name="authorOccupation"></label>
          <label>{{ t('author.artwork') }}<input v-model="authorArtwork" name="authorArtwork"></label>
          <label>{{ t('author.content') }}<textarea v-model="authorContent" name="authorContent" rows="5" /></label>
          <button type="submit" class="primary-button">{{ t('author.save') }}</button>
        </form>
        <div v-else class="author-basics">
          <template v-if="activeAuthor.artworkRef">
            <img :src="api.assetUrl(activeAuthor.artworkRef)" :alt="activeAuthor.name" class="author-artwork">
          </template>
          <CoverComposition
            v-else-if="authorCoverCovers.length"
            variant="author-detail"
            :cover-refs="authorCoverCovers"
            :alt="activeAuthor.name"
            :asset-url="api.assetUrl"
          />
          <div v-else class="author-artwork author-cover-placeholder">{{ activeAuthor.name.slice(0, 1).toUpperCase() }}</div>
          <div>
            <p class="eyebrow">{{ t('author.occupation') }}</p>
            <h2>
              {{ activeAuthor.name }}
              <span v-if="activeAuthor.galleryType" class="author-gallery-badge" data-testid="author-gallery-badge">
                {{ activeAuthor.galleryType }}
              </span>
            </h2>
            <small
              v-if="alternatesFor(activeAuthor.name)"
              class="author-name-alternates"
              data-testid="author-detail-alternates"
            >{{ alternatesFor(activeAuthor.name) }}</small>
            <p>{{ activeAuthor.occupation }}</p>
            <p class="author-usage-summary" data-testid="author-usage-summary">
              <span class="detail-usage-count">{{ t('usage.viewCount', { count: activeAuthor.usage.viewCount }) }}</span>
              <span v-if="activeAuthor.usage.likeCount > 0" class="detail-usage-count">👍 {{ activeAuthor.usage.likeCount }}</span>
              <span
                v-if="activeAuthor.usage.lastViewedAt"
                class="detail-usage-date"
              >{{ t('usage.lastViewed', { date: formatDate(activeAuthor.usage.lastViewedAt) }) }}</span>
            </p>
          </div>
        </div>

        <div class="author-row" data-testid="author-tag-row">
          <strong>{{ t('author.tags') }}</strong>
          <div class="tag-row">
            <span
              v-for="tag in activeAuthor.tags"
              :key="tag.tagId"
              class="author-tag"
              :data-author-tag-id="tag.tagId"
              @click="openAuthorTag(tag.tagId, tag.name)"
              @dblclick="beginTagRename(tag)"
            >
              <input
                v-if="editingTagId === tag.tagId"
                v-model="editingTagName"
                :data-rename-author-tag-id="tag.tagId"
                @keydown.enter.prevent="saveTagRename(tag.tagId)"
                @blur="saveTagRename(tag.tagId)"
              >
              <template v-else>{{ tag.name }}</template>
              <button v-if="editingAuthor" type="button" :aria-label="t('tag.remove', { name: tag.name })" @click="removeTag(tag.tagId)">×</button>
            </span>
            <button v-if="editingAuthor && !tagEditorOpen" type="button" class="add-button" @click="tagEditorOpen = true">{{ t('tag.add') }}</button>
            <form v-else-if="editingAuthor" class="compact-editor" @submit.prevent>
              <SuggestionInput
                mode="creatable-text"
                name="authorTagName"
                commit-on-blur
                :provider="suggestProducerTags"
                :exclude-ids="authorTagExcludeIds"
                :aria-label="t('tag.namePlaceholder')"
                :placeholder="t('tag.namePlaceholder')"
                @select="(suggestion) => addTag(suggestion.name)"
                @submit-text="(text) => addTag(text)"
              />
            </form>
          </div>
        </div>
        <!-- Read-mode only: while editing, the form's Content field above is
             the single editor for this text. -->
        <div v-if="!editingAuthor" class="author-row author-content-row">
          <strong>{{ t('author.content') }}</strong>
          <p>{{ activeAuthor.content }}</p>
        </div>
        <div
          v-if="activeAuthor.ratings.length > 0 || editingAuthor"
          class="author-row author-rating-row"
          data-testid="author-ratings"
        >
          <strong>{{ t('rating.title') }}</strong>
          <div class="rating-rows">
            <p v-if="activeAuthor.ratings.length === 0 && editingAuthor" class="muted">
              {{ activeAuthor.galleryType === null ? t('rating.noWorks') : t('rating.empty') }}
            </p>
            <div
              v-for="row in activeAuthor.ratings"
              :key="row.slotId"
              class="rating-row"
              :data-rating-slot-id="row.slotId"
            >
              <span class="rating-name">{{ row.name }}</span>
              <span
                v-if="editingAuthor && activeAuthor.ratings.length > 1"
                class="rating-sort-controls"
              >
                <button
                  type="button"
                  :data-move-rating-up-id="row.slotId"
                  :disabled="row.slotId === activeAuthor.ratings[0]?.slotId"
                  :aria-label="t('rating.moveUp', { name: row.name })"
                  @click="moveAuthorRatingSlot(row.slotId, -1)"
                >↑</button>
                <button
                  type="button"
                  :data-move-rating-down-id="row.slotId"
                  :disabled="row.slotId === activeAuthor.ratings[activeAuthor.ratings.length - 1]?.slotId"
                  :aria-label="t('rating.moveDown', { name: row.name })"
                  @click="moveAuthorRatingSlot(row.slotId, 1)"
                >↓</button>
              </span>
              <template v-if="editingAuthor">
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
                        @click="chooseAuthorStars(row.slotId, half / 2)"
                      />
                    </span>
                  </span>
                  <button
                    v-if="row.stars !== null"
                    type="button"
                    class="remove-tag-button"
                    :data-clear-rating-slot-id="row.slotId"
                    :aria-label="t('rating.clear', { name: row.name })"
                    @click="clearAuthorStars(row.slotId)"
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
            <button
              v-if="editingAuthor && !ratingEditorOpen"
              data-testid="add-author-rating-button"
              type="button"
              class="add-button"
              @click="ratingEditorOpen = true"
            >
              {{ t('rating.add') }}
            </button>
            <form
              v-else-if="editingAuthor"
              data-testid="create-author-rating-form"
              class="compact-editor"
              @submit.prevent="createAuthorRatingSlot"
            >
              <input
                v-model="ratingName"
                name="authorRatingName"
                required
                autocomplete="off"
                :placeholder="t('rating.namePlaceholder')"
                @blur="ratingName.trim() && createAuthorRatingSlot()"
              >
            </form>
          </div>
        </div>
      </section>

      <section class="author-works">
        <div class="works-heading">
          <h2>{{ t('author.works') }}</h2>
          <label class="sort-control">
            <span>{{ t('author.sortLabel') }}</span>
            <select v-model="authorSort" data-testid="author-sort">
              <option value="date-desc">{{ t('author.sortDateNewest') }}</option>
              <option value="date-asc">{{ t('author.sortDateOldest') }}</option>
              <option value="title-asc">{{ t('author.sortTitleAz') }}</option>
              <option value="title-desc">{{ t('author.sortTitleZa') }}</option>
              <option value="type">{{ t('author.sortType') }}</option>
              <option value="random">{{ t('sort.random') }}</option>
            </select>
          </label>
          <button
            v-if="editingAuthor && !entryMergeMode"
            data-testid="add-author-directory"
            type="button"
            class="add-button"
            @click="createDirectory()"
          >
            {{ t('directory.add') }}
          </button>
          <button
            v-if="editingAuthor && !entryMergeMode"
            data-testid="start-entry-merge"
            type="button"
            class="secondary-button"
            @click="beginEntryMerge"
          >{{ t('entryMerge.start') }}</button>
          <button
            v-else-if="editingAuthor"
            data-testid="cancel-entry-merge"
            type="button"
            class="secondary-button"
            @click="cancelEntryMerge"
          >{{ t('entryMerge.cancelMode') }}</button>
        </div>
        <p
          v-if="editingAuthor && !entryMergeMode && !filterFlat"
          data-testid="author-work-move-hint"
          class="work-move-hint"
        >{{ t('directory.organizeHint') }}</p>
        <p
          v-if="entryMergeMode"
          data-testid="entry-merge-hint"
          class="entry-merge-hint"
        >{{ t('entryMerge.selectHint', { count: entryMergeSelection.length }) }}</p>
        <div
          v-if="!entryMergeMode && authorFilterOptions && authorFilterType
            && (authorFilterOptions.facets.length > 0 || authorFilterOptions.allTags.length > 0)"
          class="author-filter-wrap"
        >
          <FacetFilterBar
            :options="authorFilterOptions"
            :model-value="authorFilters"
            hide-authors
            @update:model-value="onAuthorFiltersChange"
          />
        </div>
        <p v-if="!hasAnyCards" class="muted">
          {{ filterActive && authorHasWorks
            ? t('author.noFilteredWorks')
            : t('author.emptyWorks') }}
        </p>
        <template v-else>
          <div
            v-if="directoryCards.length > 0 && !filterFlat"
            data-testid="author-directory-row"
            class="author-card-grid directory-row"
          >
            <article
              v-for="card in directoryCards"
              :key="cardKey(card)"
              data-author-card
              class="author-card"
              :class="{
                'directory-card': card.kind === 'directory',
                'drop-target': dropTarget === cardKey(card),
              }"
              :data-author-directory-id="card.directory.id"
              :draggable="false"
              @dragenter.prevent="markDropTarget(card)"
              @dragleave="dropTarget === cardKey(card) && (dropTarget = null)"
              @dragover.prevent
              @drop.prevent="moveToDirectory(card.directory.id)"
            >
              <button
                data-directory-open
                type="button"
                class="author-card-main"
                @click="openDirectory(card.directory)"
              >
                <span class="directory-cover">
                  <template v-for="work in card.directory.entries.slice(0, 3)" :key="work.id">
                    <img v-if="work.coverRef" :src="api.assetUrl(entryCardMediaRef(work.coverRef))" :alt="work.title" loading="lazy" decoding="async">
                    <span v-else class="mini-placeholder">{{ work.title.slice(0, 1) }}</span>
                  </template>
                </span>
                <span class="author-card-meta"><strong>{{ card.directory.title }}</strong><small>{{ card.directory.entryCount ?? card.directory.entries.length }} {{ t('author.works') }}</small></span>
              </button>
              <button
                v-if="editingAuthor && draggedWorkId !== null"
                type="button"
                class="work-move-target"
                :data-move-work-to-directory-id="card.directory.id"
                @click="moveToDirectory(card.directory.id)"
              >{{ t('directory.moveHere') }}</button>
            </article>
          </div>
          <div v-if="visibleWorkCards.length > 0" class="author-card-grid">
            <EntryCard
              v-for="card in visibleWorkCards"
              :key="cardKey(card)"
              :api="api"
              :entry="card.work"
              :note="authorWorkUsageNote(card.work)"
              :pressed="entryMergeMode
                ? isEntryMergeSelected(card.work.id)
                : editingAuthor && !filterFlat
                  ? draggedWorkId === card.work.id
                  : undefined"
              main-class="author-card-main"
              data-author-card
              class="author-card"
              :class="{
                'drop-target': dropTarget === cardKey(card),
                'selected-work': entryMergeMode
                  ? isEntryMergeSelected(card.work.id)
                  : editingAuthor && draggedWorkId === card.work.id,
              }"
              :data-author-work-id="card.work.id"
              :draggable="editingAuthor && !filterFlat"
              @dragstart="beginWorkDrag(card.work.id)"
              @dragend="clearDragState"
              @dragenter.prevent="markDropTarget(card)"
              @dragleave="dropTarget === cardKey(card) && (dropTarget = null)"
              @dragover.prevent
              @drop.prevent="groupWorksIntoDirectory(card.work.id)"
              @open="openOrSelectLooseWork(card.work)"
            >
              <template #corner>
                <button
                  v-if="editingAuthor && !filterFlat && draggedWorkId !== null && draggedWorkId !== card.work.id"
                  type="button"
                  class="work-move-target"
                  :data-group-with-work-id="card.work.id"
                  @click="groupWorksIntoDirectory(card.work.id)"
                >{{ t('directory.groupWith') }}</button>
              </template>
            </EntryCard>
          </div>
        </template>
        <nav v-if="pageCount > 1" class="pagination">
          <button type="button" :disabled="page === 1" @click="setWorkPage(page - 1)">{{ t('author.previousPage') }}</button>
          <span>{{ t('author.page', { page, pages: pageCount }) }}</span>
          <button data-testid="author-next-page" type="button" :disabled="page === pageCount" @click="setWorkPage(page + 1)">{{ t('author.nextPage') }}</button>
        </nav>
      </section>

      <div
        v-if="entryMergeConfirmationOpen && entryMergeSelection.length === 2"
        class="entry-merge-overlay"
        role="presentation"
      >
        <section
          class="entry-merge-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="t('entryMerge.confirmTitle')"
          data-testid="entry-merge-confirmation"
        >
          <h2>{{ t('entryMerge.confirmTitle') }}</h2>
          <p class="muted">{{ t('entryMerge.confirmDescription') }}</p>

          <fieldset>
            <legend>{{ t('entryMerge.chooseKeeper') }}</legend>
            <label
              v-for="work in entryMergeSelection"
              :key="work.id"
              class="entry-merge-option"
              :data-merge-keeper-entry-id="work.id"
            >
              <input
                type="radio"
                name="entryMergeKeeper"
                :value="work.id"
                :checked="entryMergeKeepId === work.id"
                :data-merge-keeper-radio-id="work.id"
                @change="chooseEntryMergeKeeper(work.id)"
              >
              <span class="entry-merge-option-body">
                <strong>{{ work.title }}</strong>
                <small
                  v-for="source in entryMergeSourcesFor(work.id)"
                  :key="`${source.contentId}:${source.url}`"
                >{{ source.url }}</small>
                <small v-if="entryMergeSourcesFor(work.id).length === 0" class="muted">
                  {{ t('entryMerge.noSource') }}
                </small>
                <em v-if="entryMergeKeepId !== null" class="entry-merge-marker">
                  {{ entryMergeKeepId === work.id ? t('entryMerge.willKeep') : t('entryMerge.willDelete') }}
                </em>
              </span>
            </label>
          </fieldset>

          <fieldset>
            <legend>{{ t('entryMerge.chooseTitle') }}</legend>
            <label v-for="work in entryMergeSelection" :key="work.id" class="entry-merge-option">
              <input
                type="radio"
                name="entryMergeTitleSource"
                :value="work.id"
                :checked="entryMergeTitleSourceId === work.id"
                :data-merge-title-source-id="work.id"
                @change="chooseEntryMergeTitleSource(work.id)"
              >
              <span>{{ work.title }}</span>
            </label>
            <label class="entry-merge-option entry-merge-title-field">
              <span class="muted">{{ t('entryMerge.titleOverride') }}</span>
              <input
                v-model="entryMergeTitleDraft"
                type="text"
                data-testid="entry-merge-title-input"
                :aria-label="t('entryMerge.titleOverride')"
              >
            </label>
          </fieldset>

          <label class="entry-merge-option">
            <input v-model="entryMergeCopyTags" type="checkbox" data-testid="entry-merge-copy-tags">
            <span>{{ t('entryMerge.mergeTags') }}</span>
          </label>

          <fieldset>
            <legend>{{ t('entryMerge.sourceUrls') }}</legend>
            <p v-if="entryMergeAvailableSources().length === 0" class="muted">
              {{ t('entryMerge.noSources') }}
            </p>
            <label
              v-for="source in entryMergeAvailableSources()"
              :key="`${source.contentId}:${source.url}`"
              class="entry-merge-source-option"
            >
              <input v-model="entryMergeSelectedUrls" type="checkbox" :value="source.url">
              <span><strong>{{ source.sourceName }}</strong><small>{{ source.url }}</small></span>
            </label>
          </fieldset>

          <p class="entry-merge-warning">
            {{ t('entryMerge.deleteWarning', { title: entryMergeAbsorbedWork()?.title ?? '' }) }}
          </p>
          <div class="entry-merge-actions">
            <button type="button" class="secondary-button" :disabled="entryMergeSubmitting" @click="entryMergeConfirmationOpen = false">
              {{ t('entryMerge.back') }}
            </button>
            <button
              type="button"
              class="primary-button"
              data-testid="confirm-entry-merge"
              :disabled="entryMergeSubmitting || entryMergeTitleInvalid"
              @click="confirmEntryMerge"
            >{{ entryMergeSubmitting ? t('entryMerge.merging') : t('entryMerge.confirm') }}</button>
          </div>
        </section>
      </div>
    </template>

    <template v-else>
      <header class="author-list-heading">
        <p class="eyebrow">{{ t('author.navigation') }}</p>
        <h2>{{ t('author.title') }} <span class="muted" data-testid="author-list-count">{{ t('author.count', { count: authorListTotal }) }}</span></h2>
        <p>{{ t('author.subtitle') }}</p>
      </header>
      <div class="author-list-controls">
        <div class="author-type-filter" data-testid="author-type-filter">
          <button
            type="button"
            class="recent-tab"
            :class="{ 'recent-tab-active': authorTypeFilter === '' }"
            @click="authorTypeFilter = ''"
          >{{ t('filter.allTags') }}</button>
          <button
            v-for="type in authorGalleryTypes"
            :key="type"
            type="button"
            class="recent-tab"
            :class="{ 'recent-tab-active': authorTypeFilter === type }"
            :data-author-type-filter="type"
            @click="authorTypeFilter = type"
          >{{ type }}</button>
        </div>
        <div class="recent-mode-switch" role="group" :aria-label="t('sort.groupLabel')">
          <button
            type="button"
            class="recent-mode-button author-mode-star"
            :class="{ 'recent-mode-active': authorUsageMode === 'lastViewed' }"
            data-testid="author-mode-last-viewed"
            :aria-pressed="authorUsageMode === 'lastViewed'"
            :aria-label="t('author.sortByLastViewed')"
            :title="t('author.sortByLastViewed')"
            @click="authorUsageMode = authorUsageMode === 'lastViewed' ? null : 'lastViewed'"
          ><AppIcon name="history" :size="16" /></button>
          <button
            type="button"
            class="recent-mode-button author-mode-heart"
            :class="{ 'recent-mode-active': authorUsageMode === 'mostViewed' }"
            data-testid="author-mode-most-viewed"
            :aria-pressed="authorUsageMode === 'mostViewed'"
            :aria-label="t('author.sortByViews')"
            :title="t('author.sortByViews')"
            @click="authorUsageMode = authorUsageMode === 'mostViewed' ? null : 'mostViewed'"
          ><AppIcon name="view-count" :size="16" /></button>
          <button
            type="button"
            class="recent-mode-button author-mode-like"
            :class="{ 'recent-mode-active': authorUsageMode === 'mostLiked' }"
            data-testid="author-mode-most-liked"
            :aria-pressed="authorUsageMode === 'mostLiked'"
            :aria-label="t('author.sortByLikes')"
            :title="t('author.sortByLikes')"
            @click="authorUsageMode = authorUsageMode === 'mostLiked' ? null : 'mostLiked'"
          ><AppIcon name="thumb-up" :size="16" /></button>
          <button
            type="button"
            class="recent-mode-button"
            :class="{ 'recent-mode-active': authorUsageMode === 'random' }"
            data-testid="author-mode-random"
            :aria-pressed="authorUsageMode === 'random'"
            :aria-label="t('sort.random')"
            :title="t('sort.random')"
            @click="authorUsageMode = authorUsageMode === 'random' ? null : 'random'"
          ><AppIcon name="shuffle" :size="16" /></button>
        </div>
      </div>
      <div class="author-list-tag-filters" data-testid="author-list-tag-filters">
        <div class="author-list-filter-actions">
          <button
            type="button"
            class="add-button"
            data-testid="add-author-tag-filter"
            :disabled="authorTagFilters.length >= authorListFilterOptions.authorTags.length"
            @click="addAuthorTagFilter"
          >{{ t('author.addAuthorTagFilter') }}</button>
          <button
            type="button"
            class="add-button"
            data-testid="add-work-tag-filter"
            :disabled="workTagFilters.length >= authorListFilterOptions.workTags.length"
            @click="addWorkTagFilter"
          >{{ t('author.addWorkTagFilter') }}</button>
        </div>
        <div
          v-for="(_tagId, index) in authorTagFilters"
          :key="`author-tag-${index}`"
          class="author-list-filter-row"
        >
          <label>
            <span>{{ t('author.authorTags') }}</span>
            <TagCombobox
              :model-value="authorTagFilters[index] ?? null"
              :options="authorListFilterOptions.authorTags.map((tag) => ({ id: tag.tagId, name: tag.name }))"
              test-id-prefix="author-tag"
              :taken-ids="authorTagFilters.filter((id): id is number => id !== null && id !== authorTagFilters[index])"
              @update:model-value="(value) => { authorTagFilters[index] = value; applyAuthorListFilters(); }"
            />
          </label>
          <button
            type="button"
            class="remove-tag-filter"
            :aria-label="t('author.removeTagFilter')"
            @click="removeAuthorTagFilter(index)"
          >×</button>
        </div>
        <div
          v-for="(_tagId, index) in workTagFilters"
          :key="`work-tag-${index}`"
          class="author-list-filter-row"
        >
          <label>
            <span>{{ t('author.worksContainTags') }}</span>
            <TagCombobox
              :model-value="workTagFilters[index] ?? null"
              :options="authorListFilterOptions.workTags.map((tag) => ({ id: tag.tagId, name: tag.name }))"
              test-id-prefix="work-tag"
              :taken-ids="workTagFilters.filter((id): id is number => id !== null && id !== workTagFilters[index])"
              @update:model-value="(value) => { workTagFilters[index] = value; applyAuthorListFilters(); }"
            />
          </label>
          <button
            type="button"
            class="remove-tag-filter"
            :aria-label="t('author.removeTagFilter')"
            @click="removeWorkTagFilter(index)"
          >×</button>
        </div>
      </div>
      <p v-if="authorListTotal === 0" class="muted">{{ t('author.noFilteredAuthors') }}</p>
      <PagedCardGrid
        v-else
        :items="visibleAuthors"
        grid-class="author-list"
        page-key="author-list"
        :total-items="authorListTotal"
        :external-page="authorListPage"
        @update:page="changeAuthorListPage"
        @update:page-size="changeAuthorListPageSize"
        v-slot="{ items }"
      >
        <button v-for="author in items" :key="author.id" type="button" class="author-list-card" :data-author-id="author.id" @click="openAuthor(author.id)">
          <CoverComposition
            v-if="author.covers.length"
            variant="author-card"
            :cover-refs="author.covers"
            :alt="author.name"
            :asset-url="api.assetUrl"
          />
          <span v-else class="author-list-badge">{{ author.name.slice(0, 1).toUpperCase() }}</span>
          <strong>{{ author.name }}</strong>
          <small v-if="author.galleryType" class="author-gallery-badge" data-testid="author-list-gallery">
            {{ author.galleryType }}
          </small>
          <small v-if="alternatesFor(author.name)" class="author-name-alternates">
            {{ alternatesFor(author.name) }}
          </small>
          <small v-if="authorUsageMode !== null && authorUsageMode !== 'random'" class="author-usage-note" data-testid="author-usage-note">
            {{ authorUsageMode === 'mostLiked'
              ? t('card.likeCount', { count: author.likeCount })
              : authorUsageMode === 'mostViewed'
                ? t('card.viewCount', { count: author.viewCount })
                : t('author.lastViewed', { date: author.lastViewedAt ? formatDate(author.lastViewedAt) : '—' }) }}
          </small>
        </button>
      </PagedCardGrid>
    </template>
    <IconButton
      v-if="activeAuthor"
      class="scroll-top-fab"
      icon="arrow-up"
      :label="t('navigation.scrollTop')"
      data-testid="author-scroll-top"
      @click="scrollToTop"
    />
  </section>
</template>

<style scoped>
.author-page { display: grid; gap: 1rem; }
.scroll-top-fab {
  position: fixed;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  z-index: 30;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
}
.author-list-controls { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.author-type-filter { display: flex; flex-wrap: wrap; align-items: end; gap: 0.25rem; padding: 0 0.55rem; }
.author-list-tag-filters { display: grid; gap: 0.55rem; }
.author-list-filter-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
.author-list-filter-actions .add-button:disabled { cursor: default; opacity: 0.45; }
.author-list-filter-row { display: flex; align-items: end; gap: 0.45rem; max-width: 28rem; }
.author-list-filter-row label { display: grid; flex: 1; gap: 0.25rem; color: var(--text-muted); font-size: 0.75rem; font-weight: 700; }
.author-list-filter-row select { min-width: 0; padding: 0.48rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; }
.remove-tag-filter { width: 2.15rem; height: 2.15rem; padding: 0; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-muted); background: transparent; font: inherit; cursor: pointer; }
.author-usage-note { color: var(--text-muted); font-size: 0.75rem; }
.rating-rows { display: grid; gap: 0.35rem; justify-items: start; }
.rating-row { display: flex; align-items: center; gap: 0.85rem; min-height: 2rem; }
.author-usage-summary { display: flex; align-items: baseline; gap: 0.8rem; margin: 0.35rem 0 0; color: var(--text-muted); font-size: 0.82rem; }
.detail-usage-count { font-weight: 700; color: var(--text-primary); }
.works-heading, .pagination { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
/* Back link stays left; Done / Delete and the edit button group on the right. */
.author-toolbar { display: flex; align-items: center; gap: 0.75rem; }
.author-toolbar .text-button { margin-right: auto; }
.directory-edit-actions { display: grid; justify-items: stretch; gap: 0.35rem; }
.directory-remove-target { padding: 0.35rem 0.6rem; border: 1px dashed #b84a4a; border-radius: 0.5rem; color: #a12626; background: transparent; font: inherit; cursor: pointer; transition: transform 140ms ease, background 140ms ease; }
.directory-remove-target.drop-target { transform: scale(1.04); background: color-mix(in srgb, #b84a4a 14%, transparent); }
.text-button { padding: 0; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
.secondary-button, .primary-button, .add-button, .pagination button { padding: 0.45rem 0.7rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; cursor: pointer; }
.danger-button { border-color: #a12626; color: #a12626; }
.armable-armed { border-color: #a12626; color: #a12626; background: #fff0f0; }
.primary-button { color: white; border-color: var(--accent); background: var(--accent); }
.add-button { border-style: dashed; color: var(--text-muted); background: transparent; }
.author-information-board { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.9rem; background: var(--surface-muted); }
.author-information-board > * { margin: 0; padding: 1rem; }
.author-information-board > * + * { border-top: 1px solid var(--border-subtle); }
.author-basics { display: flex; align-items: center; gap: 1rem; }
.author-basics h2 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.4rem); }
.author-basics p { margin: 0.25rem 0 0; color: var(--text-muted); }
.author-artwork { width: 7rem; height: 7rem; border-radius: 0.8rem; object-fit: cover; }
.author-cover-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.sort-control { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; color: var(--text-muted); font-size: 0.85rem; }
.sort-control select { min-height: var(--control-min-height); padding: 0.3rem 0.6rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--text-primary); background: var(--surface); font: inherit; }
.recent-mode-switch { display: inline-flex; gap: 0.3rem; }
/* Sort state buttons share one look; active is expressed by container colors,
   never by a filled icon (icon brief §4). */
.recent-mode-button {
  display: inline-grid;
  place-items: center;
  box-sizing: border-box;
  width: var(--icon-button-size);
  height: var(--icon-button-size);
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  color: var(--icon-muted);
  background: transparent;
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease;
}
.recent-mode-button:hover {
  color: var(--accent);
  background: var(--surface-hover);
  border-color: var(--border-strong);
}
.recent-mode-button:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.recent-mode-button.recent-mode-active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
/* Kept for the existing test selectors; the glyphs themselves are unified. */
.author-mode-star, .author-mode-heart, .author-mode-like { color: inherit; }
.recent-mode-button.recent-mode-active.author-mode-star,
.recent-mode-button.recent-mode-active.author-mode-heart,
.recent-mode-button.recent-mode-active.author-mode-like { color: var(--accent); }
.author-row { display: grid; grid-template-columns: 7rem minmax(0, 1fr); align-items: start; gap: 1rem; }
.author-row > strong { font-size: 0.8rem; }
.author-content-row p { margin: 0; white-space: pre-wrap; }
.rating-rows { display: grid; gap: 0.35rem; }
.rating-row { display: flex; align-items: center; gap: 0.85rem; min-height: 2rem; }
.rating-name { min-width: 7rem; color: var(--text-muted); font-size: 0.8rem; }
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
.tag-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.author-tag { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.6rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--tag-text); background: var(--tag-background); font-size: 0.78rem; }
.author-tag button { border: 0; color: inherit; background: transparent; cursor: pointer; }
.author-edit-form { display: grid; gap: 0.8rem; }
.author-edit-form label { display: grid; gap: 0.35rem; color: var(--text-muted); font-size: 0.8rem; font-weight: 700; }
.author-edit-form input, .author-edit-form textarea, .compact-editor input { padding: 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.55rem; color: var(--text-primary); background: var(--surface); font: inherit; }
.author-works { display: grid; gap: 0.85rem; margin-top: 0.5rem; }
.works-heading h2 { margin: 0; }
.author-card-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.8rem; }
.directory-row {
  padding-bottom: 0.9rem;
  margin-bottom: 0.4rem;
  border-bottom: 1px dashed var(--border-subtle);
}
@media (max-width: 52rem) {
  .author-card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 30rem) {
  .author-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.author-card { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); transition: transform 140ms ease, border-color 140ms ease; }
.author-card[draggable='true'] { cursor: grab; }
.author-card:hover, .author-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.author-card.drop-target { z-index: 1; border-color: var(--accent); transform: scale(1.045); box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--accent) 18%, transparent); }
.author-card.selected-work { z-index: 1; border-color: var(--accent); box-shadow: 0 0 0 0.22rem color-mix(in srgb, var(--accent) 24%, transparent); }
.author-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.work-move-hint { margin: 0; color: var(--text-muted); font-size: 0.82rem; }
.entry-merge-hint {
  margin: 0;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--accent);
  border-radius: 0.65rem;
  color: var(--text-primary);
  background: var(--accent-soft);
  font-size: 0.86rem;
  font-weight: 700;
}
.entry-merge-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: color-mix(in srgb, #000 58%, transparent);
}
.entry-merge-dialog {
  display: grid;
  gap: 1rem;
  width: min(36rem, 100%);
  max-height: min(44rem, calc(100vh - 2rem));
  padding: 1.2rem;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 0.9rem;
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
}
.entry-merge-dialog h2, .entry-merge-dialog p { margin: 0; }
.entry-merge-dialog fieldset { display: grid; gap: 0.55rem; margin: 0; padding: 0.8rem; border: 1px solid var(--border-subtle); border-radius: 0.65rem; }
.entry-merge-dialog legend { padding: 0 0.3rem; font-weight: 750; }
.entry-merge-option, .entry-merge-source-option { display: flex; align-items: flex-start; gap: 0.55rem; }
.entry-merge-option-body { display: grid; min-width: 0; gap: 0.2rem; }
.entry-merge-option-body strong { font-weight: 650; }
.entry-merge-option-body small { overflow-wrap: anywhere; color: var(--text-muted); }
.entry-merge-marker { color: var(--text-muted); font-size: 0.78rem; font-style: normal; }
.entry-merge-option:has(input:checked) .entry-merge-marker { color: var(--accent); font-weight: 650; }
.entry-merge-title-field { display: grid; gap: 0.3rem; }
.entry-merge-title-field input { width: 100%; }
.entry-merge-source-option > span { display: grid; min-width: 0; gap: 0.2rem; }
.entry-merge-source-option small { overflow-wrap: anywhere; color: var(--text-muted); }
.entry-merge-warning { padding: 0.7rem; border-radius: 0.55rem; color: #a12626; background: #fff0f0; }
.entry-merge-actions { display: flex; justify-content: flex-end; gap: 0.55rem; }
.work-move-target { width: 100%; min-height: 44px; padding: 0.5rem 0.7rem; border: 0; border-top: 1px solid var(--border-subtle); color: var(--accent); background: var(--accent-soft); font: inherit; font-size: 0.78rem; font-weight: 750; cursor: pointer; }
.work-move-target:hover, .work-move-target:focus-visible { background: color-mix(in srgb, var(--accent) 18%, var(--surface)); }
.author-card-main > img, .cover-placeholder, .directory-cover { width: 100%; height: 8rem; }
.author-card-main > img { display: block; object-fit: contain; }
.cover-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.author-card-meta { display: grid; gap: 0.25rem; padding: 0.8rem; }
.author-card-meta small { color: var(--text-muted); }
.directory-cover { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2rem; padding: 0.45rem; background: color-mix(in srgb, var(--tag-background) 65%, var(--surface)); }
.directory-cover img, .mini-placeholder { width: 100%; height: 100%; min-width: 0; object-fit: cover; border-radius: 0.35rem; }
.mini-placeholder { display: grid; place-items: center; color: var(--tag-text); background: var(--surface); }
.author-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.8rem; }
.author-list-card { display: grid; gap: 0.45rem; padding: 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.8rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; align-content: start; }
.author-list-badge { display: grid; place-items: center; width: 100%; aspect-ratio: 3 / 4; border-radius: 0.5rem; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.author-list-card > strong { font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.author-name-alternates { font-size: 0.66rem; font-weight: 400; color: var(--text-muted); opacity: 0.72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.author-basics .author-name-alternates { font-size: 0.8rem; margin-top: 0.1rem; }
.directory-heading p, .author-list-heading p, .muted { color: var(--text-muted); }
.pagination { justify-content: center; }
.pagination button:disabled { cursor: default; opacity: 0.4; }
.author-error { padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
.author-filter-wrap { margin-bottom: 0.35rem; }
.author-gallery-badge {
  display: inline-block;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: 0.68rem;
  font-weight: 700;
  vertical-align: middle;
}
.author-basics h2 .author-gallery-badge { margin-left: 0.4rem; }
.author-list-card > .author-gallery-badge { justify-self: start; }
.eyebrow { margin-bottom: 0.35rem; color: var(--accent); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
@media (max-width: 44rem) {
  .author-toolbar,
  .works-heading { align-items: flex-start; flex-wrap: wrap; }
  .author-toolbar .text-button { display: inline-flex; min-height: 44px; align-items: center; }
  .author-toolbar .secondary-button,
  .author-edit-form input,
  .author-edit-form textarea,
  .author-edit-form .primary-button,
  .author-row .add-button,
  .author-row .compact-editor input { min-height: 44px; }
  .author-tag { min-height: 44px; }
  .author-tag button { min-width: 32px; min-height: 42px; }
  .author-row .rating-sort-controls button { min-width: 44px; min-height: 44px; }
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
  .sort-control { width: 100%; margin-left: 0; flex-wrap: wrap; }
  .sort-control select { min-width: 0; max-width: 100%; min-height: 44px; }
  .author-list-filter-row { max-width: 100%; }
  .author-list-filter-row select,
  .remove-tag-filter { min-height: 44px; }
}
@media (max-width: 38rem) { .author-row { grid-template-columns: 1fr; gap: 0.4rem; } }
</style>
