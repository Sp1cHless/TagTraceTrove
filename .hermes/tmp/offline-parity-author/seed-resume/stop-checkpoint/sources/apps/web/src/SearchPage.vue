<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { normalizeTag, type SearchScope, type TagSearchHit } from '@t3/shared';
import type {
  GalleryApi,
  GalleryAuthorSummary,
  GalleryEntrySummary,
  PendingOfflineEntryCreate,
  PendingOfflineEntryTagValue,
} from './api/gallery.js';
import { entryCardMediaRef, entryStackLayerStyle, entryStackLayers } from './entry-media-stack.js';
import PagedCardGrid from './components/PagedCardGrid.vue';
import LazyCardImage from './components/LazyCardImage.vue';
import PendingEntryTagEditor from './components/PendingEntryTagEditor.vue';
import PendingEntryAuthorEditor from './components/PendingEntryAuthorEditor.vue';
import PendingEntryMetadataEditor from './components/PendingEntryMetadataEditor.vue';
import PendingEntryContentEditor from './components/PendingEntryContentEditor.vue';
import { showNsfw } from './stores/preferences.js';
import { useI18n } from './i18n.js';
import { useNavigationMemory } from './navigation-memory.js';

const props = defineProps<{
  api: GalleryApi;
  initialQuery: string;
  initialScope: SearchScope;
  nsfwEntryTypes: string[];
}>();
const emit = defineEmits<{
  back: [];
  'open-entry': [entry: GalleryEntrySummary, query: string, scope: SearchScope];
  'open-author': [author: GalleryAuthorSummary, query: string, scope: SearchScope];
  'open-tag': [tag: TagSearchHit, query: string, scope: SearchScope];
}>();
const { t } = useI18n();
const navigationMemory = useNavigationMemory();

const query = ref(props.initialQuery);
const scope = ref<SearchScope>(props.initialScope);
const entries = ref<GalleryEntrySummary[]>([]);
const pendingEntries = ref<PendingOfflineEntryCreate[]>([]);
const editingPendingKey = ref<string | null>(null);
const editingTagsKey = ref<string | null>(null);
const editingAuthorsKey = ref<string | null>(null);
const editingMetadataKey = ref<string | null>(null);
const pendingMetadataSaving = ref(false);
const editingContentsKey = ref<string | null>(null);
const pendingContentsSaving = ref(false);
const pendingContentsNotice = ref<string | null>(null);
const pendingContentsNoticeKey = ref<string | null>(null);
let pendingContentsRefreshVersion = 0;
const pendingMetadataNotice = ref<string | null>(null);
const pendingMetadataNoticeKey = ref<string | null>(null);
let pendingMetadataRefreshVersion = 0;
const pendingAuthorsSaving = ref(false);
const pendingAuthorsNotice = ref<string | null>(null);
const pendingAuthorsNoticeKey = ref<string | null>(null);
let pendingAuthorsRefreshVersion = 0;
const pendingTagsSaving = ref(false);
const pendingTagsNotice = ref<string | null>(null);
const pendingTagsNoticeKey = ref<string | null>(null);
let pendingTagsRefreshVersion = 0;
const pendingContentType = ref('');
const pendingContentText = ref('');
const pendingSaving = ref(false);
const pendingError = ref<string | null>(null);
const pendingErrorKey = ref<string | null>(null);
const entryTotal = ref(0);
const entryPage = ref(navigationMemory.pages.get(`search:entries:${props.initialQuery.trim()}`) ?? 1);
const entryPageSize = ref(30);
const tags = ref<TagSearchHit[]>([]);
const authors = ref<GalleryAuthorSummary[]>([]);
const authorTotal = ref(0);
const authorPage = ref(navigationMemory.pages.get(`search:authors:${props.initialQuery.trim()}`) ?? 1);
const authorPageSize = ref(30);
const loading = ref(false);
const searched = ref(false);
const error = ref<string | null>(null);
let requestSequence = 0;

const hiddenTypes = computed(() => new Set(props.nsfwEntryTypes));
const visibleEntries = computed(() => entries.value.filter((entry) => (
  showNsfw.value || !hiddenTypes.value.has(entry.type)
)));
const visibleAuthors = computed(() => authors.value.filter((author) => showNsfw.value || !author.nsfw));

// An author is found through the alias spellings recorded for them, so the card
// shows those spellings: otherwise a search for `ishikei` would look like it
// matched a card named 石恵 for no reason.
const authorAlternates = ref<Map<string, string[]>>(new Map());

function alternatesFor(name: string): string {
  return (authorAlternates.value.get(normalizeTag(name)) ?? []).join(' / ');
}

async function loadAuthorAlternates(): Promise<void> {
  try {
    const aliases = await props.api.listTaxonomyAliases('producer');
    const map = new Map<string, string[]>();
    for (const alias of aliases) {
      // Placeholder rows (imported name, canonical not filled yet) belong to no
      // author and must not appear anywhere.
      if (alias.normalizedCanonical === '') continue;
      const names = map.get(alias.normalizedCanonical) ?? [];
      if (!names.includes(alias.alias)) names.push(alias.alias);
      map.set(alias.normalizedCanonical, names);
    }
    authorAlternates.value = map;
  } catch {
    authorAlternates.value = new Map();
  }
}
const resultCount = computed(() => {
  if (scope.value === 'entries') return entryTotal.value + pendingEntries.value.length;
  if (scope.value === 'tags') return tags.value.length;
  return authorTotal.value;
});

function openPendingContent(entry: PendingOfflineEntryCreate): void {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value) return;
  editingMetadataKey.value = null;
  editingContentsKey.value = null;
  editingTagsKey.value = null;
  editingAuthorsKey.value = null;
  if (editingPendingKey.value !== entry.localKey) {
    pendingContentType.value = '';
    pendingContentText.value = '';
  }
  editingPendingKey.value = entry.localKey;
  pendingError.value = null;
  pendingErrorKey.value = null;
}

async function appendPendingContent(entry: PendingOfflineEntryCreate): Promise<void> {
  if (pendingSaving.value || entry.status !== 'pending' || !props.api.enqueueOfflinePendingEntryContent) return;
  const contentType = pendingContentType.value.trim();
  const content = pendingContentText.value.trim();
  if (!contentType || !content) return;
  pendingError.value = null;
  pendingErrorKey.value = entry.localKey;
  pendingSaving.value = true;
  try {
    await props.api.enqueueOfflinePendingEntryContent(entry.localKey, { contentType, content });
  } catch (cause) {
    pendingError.value = cause instanceof Error ? cause.message : t('search.pendingContentError');
    pendingSaving.value = false;
    return;
  }
  // The Outbox has committed. Never offer a second submit merely because a
  // subsequent read of the local projection fails.
  editingPendingKey.value = null;
  pendingContentType.value = '';
  pendingContentText.value = '';
  try {
    const updated = await props.api.listPendingOfflineEntryCreates?.();
    const replacement = updated?.find((candidate) => candidate.localKey === entry.localKey);
    if (replacement) pendingEntries.value = pendingEntries.value.map((candidate) => (
      candidate.localKey === entry.localKey ? replacement : candidate
    ));
  } catch {
    pendingError.value = t('search.pendingContentRefreshError');
  } finally {
    pendingSaving.value = false;
  }
}

function openPendingTags(entry: PendingOfflineEntryCreate): void {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || entry.status !== 'pending' || entry.canEditTags !== true) return;
  editingPendingKey.value = null;
  editingAuthorsKey.value = null;
  editingMetadataKey.value = null;
  editingContentsKey.value = null;
  pendingTagsNotice.value = null;
  pendingTagsNoticeKey.value = null;
  editingTagsKey.value = entry.localKey;
}

async function createPendingFacet(key: string, name: string, sectionId: number): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryFacetCreate) throw new Error(t('search.pendingTagsUnavailable'));
  pendingTagsSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryFacetCreate(key, name, sectionId); }
  finally { pendingTagsSaving.value = false; }
}

async function createPendingTag(key: string, name: string, facetId: number): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryTagCreate) throw new Error(t('search.pendingTagsUnavailable'));
  pendingTagsSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryTagCreate(key, name, facetId); }
  finally { pendingTagsSaving.value = false; }
}

async function enqueuePendingTags(key: string, desired: PendingOfflineEntryTagValue[]): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryTags) throw new Error(t('search.pendingTagsUnavailable'));
  // Own the in-flight lock above the editor: changing Search can unmount the
  // editor while its durable write is still pending.
  pendingTagsSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryTags(key, desired); }
  finally { pendingTagsSaving.value = false; }
}

async function savedPendingTags(entry: PendingOfflineEntryCreate, desired: PendingOfflineEntryTagValue[]): Promise<void> {
  // The local write committed before this event. A failed projection refresh
  // must not re-open the editor and invite an accidental duplicate write.
  const version = ++pendingTagsRefreshVersion;
  const sequence = requestSequence;
  editingTagsKey.value = null;
  pendingTagsSaving.value = false;
  pendingEntries.value = pendingEntries.value.map((candidate) => candidate.localKey === entry.localKey
    ? { ...candidate, tags: desired.map((tag) => ({ ...tag })), tagEditStatus: 'pending', tagEditError: null }
    : candidate);
  try {
    const updated = await props.api.listPendingOfflineEntryCreates?.();
    if (version !== pendingTagsRefreshVersion || sequence !== requestSequence) return;
    const replacement = updated?.find((candidate) => candidate.localKey === entry.localKey);
    if (replacement) pendingEntries.value = pendingEntries.value.map((candidate) => candidate.localKey === entry.localKey ? replacement : candidate);
  } catch {
    if (version !== pendingTagsRefreshVersion || sequence !== requestSequence) return;
    pendingTagsNotice.value = t('search.pendingTagsRefreshError');
    pendingTagsNoticeKey.value = entry.localKey;
  }
}

function openPendingAuthors(entry: PendingOfflineEntryCreate): void {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || entry.status !== 'pending' || entry.canEditAuthors !== true) return;
  editingMetadataKey.value = null;
  editingContentsKey.value = null;
  editingPendingKey.value = null;
  editingTagsKey.value = null;
  pendingAuthorsNotice.value = null;
  pendingAuthorsNoticeKey.value = null;
  editingAuthorsKey.value = entry.localKey;
}

async function enqueuePendingAuthors(key: string, desired: string[]): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryAuthors) throw new Error(t('search.pendingAuthorsUnavailable'));
  pendingAuthorsSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryAuthors(key, desired); }
  finally { pendingAuthorsSaving.value = false; }
}

async function createPendingAuthor(key: string, name: string): Promise<{ producerUid: string; name: string }> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryAuthorCreate) throw new Error(t('search.pendingAuthorsUnavailable'));
  pendingAuthorsSaving.value = true;
  try { return await props.api.enqueueOfflinePendingEntryAuthorCreate(key, name); }
  finally { pendingAuthorsSaving.value = false; }
}

async function savedPendingAuthors(entry: PendingOfflineEntryCreate, desired: Array<{ producerUid: string; name: string }>): Promise<void> {
  const version = ++pendingAuthorsRefreshVersion;
  const sequence = requestSequence;
  editingAuthorsKey.value = null;
  pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey
    ? { ...candidate, authors: desired.map(row => ({ ...row })), authorStatus: 'pending', authorLastError: null }
    : candidate);
  try {
    const updated = await props.api.listPendingOfflineEntryCreates?.();
    if (version !== pendingAuthorsRefreshVersion || sequence !== requestSequence) return;
    const replacement = updated?.find(candidate => candidate.localKey === entry.localKey);
    if (replacement) pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey ? replacement : candidate);
  } catch {
    if (version !== pendingAuthorsRefreshVersion || sequence !== requestSequence) return;
    pendingAuthorsNotice.value = t('search.pendingAuthorsRefreshError');
    pendingAuthorsNoticeKey.value = entry.localKey;
  }
}

function openPendingMetadata(entry: PendingOfflineEntryCreate): void {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || entry.status !== 'pending' || entry.canEditMetadata !== true) return;
  editingContentsKey.value = null;
  editingPendingKey.value = null;
  editingTagsKey.value = null;
  editingAuthorsKey.value = null;
  pendingMetadataNotice.value = null;
  pendingMetadataNoticeKey.value = null;
  editingMetadataKey.value = entry.localKey;
}

async function enqueuePendingMetadata(key: string, values: { title: string; uploadDate: string | null; pageCount: number | null }): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryMetadata) throw new Error(t('search.pendingMetadataUnavailable'));
  pendingMetadataSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryMetadata(key, values); }
  finally { pendingMetadataSaving.value = false; }
}

async function savedPendingMetadata(entry: PendingOfflineEntryCreate, values: { title: string; uploadDate: string | null; pageCount: number | null }): Promise<void> {
  const version = ++pendingMetadataRefreshVersion;
  const sequence = requestSequence;
  editingMetadataKey.value = null;
  editingContentsKey.value = null;
  pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey
    ? { ...candidate, ...values, metadataEditStatus: 'pending', metadataEditError: null } : candidate);
  try {
    const updated = await props.api.listPendingOfflineEntryCreates?.();
    if (version !== pendingMetadataRefreshVersion || sequence !== requestSequence) return;
    const replacement = updated?.find(candidate => candidate.localKey === entry.localKey);
    if (replacement) pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey ? replacement : candidate);
  } catch {
    if (version !== pendingMetadataRefreshVersion || sequence !== requestSequence) return;
    pendingMetadataNotice.value = t('search.pendingMetadataRefreshError');
    pendingMetadataNoticeKey.value = entry.localKey;
  }
}

function openPendingContents(entry: PendingOfflineEntryCreate): void {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || entry.status !== 'pending' || entry.canEditContents !== true) return;
  editingPendingKey.value = null;
  editingTagsKey.value = null;
  editingAuthorsKey.value = null;
  editingMetadataKey.value = null;
  pendingContentsNotice.value = null;
  pendingContentsNoticeKey.value = null;
  editingContentsKey.value = entry.localKey;
}

async function enqueuePendingContents(key: string, desired: Array<{ syncUid: string; contentType: string; content: string; sortOrder: number }>): Promise<void> {
  if (pendingSaving.value || pendingTagsSaving.value || pendingAuthorsSaving.value || pendingMetadataSaving.value || pendingContentsSaving.value || !props.api.enqueueOfflinePendingEntryContents) throw new Error(t('search.pendingContentsUnavailable'));
  pendingContentsSaving.value = true;
  try { await props.api.enqueueOfflinePendingEntryContents(key, desired); }
  finally { pendingContentsSaving.value = false; }
}

async function savedPendingContents(entry: PendingOfflineEntryCreate, desired: Array<{ syncUid: string; contentType: string; content: string; sortOrder: number }>): Promise<void> {
  const version = ++pendingContentsRefreshVersion;
  const sequence = requestSequence;
  editingContentsKey.value = null;
  pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey
    ? { ...candidate, contents: desired.map(row => ({ ...row })), contentEditStatus: 'pending', contentEditError: null } : candidate);
  try {
    const updated = await props.api.listPendingOfflineEntryCreates?.();
    if (version !== pendingContentsRefreshVersion || sequence !== requestSequence) return;
    const replacement = updated?.find(candidate => candidate.localKey === entry.localKey);
    if (replacement) pendingEntries.value = pendingEntries.value.map(candidate => candidate.localKey === entry.localKey ? replacement : candidate);
  } catch {
    if (version !== pendingContentsRefreshVersion || sequence !== requestSequence) return;
    pendingContentsNotice.value = t('search.pendingContentsRefreshError');
    pendingContentsNoticeKey.value = entry.localKey;
  }
}

async function runSearch(resetPage = true): Promise<void> {
  const nextQuery = query.value.trim();
  const sequence = ++requestSequence;
  error.value = null;
  if (!nextQuery) {
    entries.value = [];
    pendingEntries.value = [];
    tags.value = [];
    authors.value = [];
    entryTotal.value = 0;
    authorTotal.value = 0;
    searched.value = false;
    return;
  }
  if (resetPage) {
    entryPage.value = 1;
    authorPage.value = 1;
  }
  loading.value = true;
  try {
    if (scope.value === 'entries') {
      const [result, localCreates] = await Promise.all([
        props.api.queryEntryPage({
          conditions: [],
          authorIds: [],
          ratingConditions: [],
          ratingSort: null,
          usageConditions: [],
          usageSort: null,
          searchQuery: nextQuery,
          excludeEntryTypes: showNsfw.value ? [] : props.nsfwEntryTypes,
          sort: 'title-asc',
          page: entryPage.value,
          pageSize: entryPageSize.value,
        }),
        props.api.listPendingOfflineEntryCreates?.() ?? Promise.resolve([]),
      ]);
      entries.value = result.items;
      entryTotal.value = result.total;
      const normalizedQuery = nextQuery.toLocaleLowerCase();
      pendingEntries.value = entryPage.value === 1
        ? localCreates.filter((entry) => (
          entry.title.toLocaleLowerCase().includes(normalizedQuery)
          && (showNsfw.value || !hiddenTypes.value.has(entry.type))
        ))
        : [];
    } else if (scope.value === 'tags') tags.value = await props.api.searchTags(nextQuery, showNsfw.value);
    else {
      const result = await props.api.queryProducerPage({
        searchQuery: nextQuery,
        ownTagIds: [],
        relatedEntryTagIds: [],
        includeNsfw: showNsfw.value,
        sort: 'relevance',
        page: authorPage.value,
        pageSize: authorPageSize.value,
      });
      authors.value = result.items;
      authorTotal.value = result.total;
    }
    if (sequence === requestSequence) searched.value = true;
  } catch (cause) {
    if (sequence === requestSequence) {
      error.value = cause instanceof Error ? cause.message : t('search.error');
    }
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function changeEntryPage(page: number): void {
  entryPage.value = page;
  void runSearch(false);
}

function changeEntryPageSize(pageSize: number): void {
  if (entryPageSize.value === pageSize) return;
  entryPageSize.value = pageSize;
  entryPage.value = 1;
  void runSearch(false);
}

function changeAuthorPage(page: number): void {
  authorPage.value = page;
  void runSearch(false);
}

function changeAuthorPageSize(pageSize: number): void {
  if (authorPageSize.value === pageSize) return;
  authorPageSize.value = pageSize;
  authorPage.value = 1;
  void runSearch(false);
}

function selectScope(nextScope: SearchScope): void {
  if (scope.value === nextScope) return;
  scope.value = nextScope;
}

watch(scope, () => {
  if (query.value.trim()) void runSearch();
});
watch(showNsfw, () => {
  if (query.value.trim()) void runSearch();
});
onMounted(() => {
  void loadAuthorAlternates();
  if (query.value.trim()) void runSearch(false);
});
</script>

<template>
  <section class="search-page" data-testid="search-page">
    <button class="back-button" type="button" @click="emit('back')">
      {{ t('entry.back', { type: t('gallery.title') }) }}
    </button>
    <header class="search-heading">
      <p class="eyebrow">{{ t('search.eyebrow') }}</p>
      <h2>{{ t('search.title') }}</h2>
      <p class="muted">{{ t('search.hint') }}</p>
    </header>

    <form class="search-main-form" data-testid="search-main-form" @submit.prevent="runSearch()">
      <input
        v-model="query"
        data-testid="search-main-input"
        type="search"
        :placeholder="t('search.placeholder')"
        :aria-label="t('search.title')"
        autofocus
      >
      <button class="primary-button" type="submit" :disabled="loading || !query.trim()">
        {{ loading ? t('search.searching') : t('search.submit') }}
      </button>
    </form>

    <nav class="search-scopes" :aria-label="t('search.scope')">
      <button
        v-for="option in (['entries', 'tags', 'producers'] as const)"
        :key="option"
        type="button"
        class="search-scope"
        :class="{ active: scope === option }"
        :data-testid="`search-scope-${option}`"
        @click="selectScope(option)"
      >
        {{ t(`search.scope.${option}`) }}
      </button>
    </nav>

    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-else-if="searched" class="search-count">
      {{ t('search.count', { count: resultCount }) }}
    </p>

    <div
      v-if="scope === 'entries' && (pendingEntries.length || visibleEntries.length)"
      class="search-entry-results"
    >
      <div v-if="pendingEntries.length" class="search-card-grid" data-testid="search-pending-entries">
        <article
          v-for="entry in pendingEntries"
          :key="entry.localKey"
          class="search-card search-card--pending"
          :class="{ 'search-card--editing': editingPendingKey === entry.localKey }"
          :data-testid="`search-pending-entry-${entry.localKey}`"
        >
          <div class="search-card-main">
            <div class="search-entry-stack">
              <span class="search-placeholder">{{ entry.title.slice(0, 1).toUpperCase() }}</span>
            </div>
            <span class="search-meta">
              <strong>{{ entry.title }}</strong>
              <small>{{ entry.type }} · {{ t(entry.status === 'failed' ? 'search.syncFailed' : entry.status === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</small>
              <small v-if="entry.status !== 'pending' && entry.lastError" data-testid="pending-create-error">{{ entry.lastError }}</small>
              <small v-for="(row, index) in entry.contents ?? []" :key="index">
                {{ row.contentType }}: {{ row.content }}
                <span v-if="row.status" data-testid="pending-content-status"> · {{ t(row.status === 'failed' ? 'search.syncFailed' : row.status === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</span>
                <span v-if="row.status && row.status !== 'pending' && row.lastError" data-testid="pending-content-error"> · {{ row.lastError }}</span>
              </small>
            </span>
          </div>
          <small v-if="entry.uploadDate" data-testid="pending-metadata-date-summary">{{ entry.uploadDate }}</small>
          <small v-if="entry.pageCount !== null" data-testid="pending-metadata-pages-summary">{{ t('search.pendingMetadataPages') }}: {{ entry.pageCount }}</small>
          <small v-if="entry.contentEditStatus" data-testid="pending-contents-status">{{ t(entry.contentEditStatus === 'failed' ? 'search.syncFailed' : entry.contentEditStatus === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</small>
          <p v-if="entry.contentEditStatus && entry.contentEditStatus !== 'pending' && entry.contentEditError" role="alert" data-testid="pending-contents-status-error">{{ entry.contentEditError }}</p>
          <button v-if="entry.status === 'pending' && entry.canEditContents === true && api.getPendingOfflineEntryContentOptions && api.enqueueOfflinePendingEntryContents"
            type="button" class="secondary-button" data-testid="pending-edit-contents" :disabled="pendingSaving || pendingTagsSaving || pendingAuthorsSaving || pendingMetadataSaving || pendingContentsSaving" @click="openPendingContents(entry)">{{ t('search.pendingEditContents') }}</button>
          <PendingEntryContentEditor v-if="editingContentsKey === entry.localKey" :key="entry.localKey" :entry="entry" :api="api" :save-contents="enqueuePendingContents" @saved="savedPendingContents(entry, $event)" @cancel="editingContentsKey = null" />
          <p v-if="pendingContentsNotice && pendingContentsNoticeKey === entry.localKey" role="alert">{{ pendingContentsNotice }}</p>
          <small v-if="entry.metadataEditStatus" data-testid="pending-metadata-status">{{ t(entry.metadataEditStatus === 'failed' ? 'search.syncFailed' : entry.metadataEditStatus === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</small>
          <p v-if="entry.metadataEditStatus && entry.metadataEditStatus !== 'pending' && entry.metadataEditError" role="alert" data-testid="pending-metadata-status-error">{{ entry.metadataEditError }}</p>
          <button v-if="entry.status === 'pending' && entry.canEditMetadata === true && api.enqueueOfflinePendingEntryMetadata"
            type="button" class="secondary-button" data-testid="pending-edit-metadata" :disabled="pendingSaving || pendingTagsSaving || pendingAuthorsSaving || pendingMetadataSaving || pendingContentsSaving" @click="openPendingMetadata(entry)">{{ t('search.pendingEditMetadata') }}</button>
          <PendingEntryMetadataEditor v-if="editingMetadataKey === entry.localKey" :key="entry.localKey" :entry="entry" :save-metadata="enqueuePendingMetadata"
            @saved="savedPendingMetadata(entry, $event)" @cancel="editingMetadataKey = null" />
          <p v-if="pendingMetadataNotice && pendingMetadataNoticeKey === entry.localKey" role="alert">{{ pendingMetadataNotice }}</p>
          <small v-if="entry.authors?.length" data-testid="pending-author-summary">{{ t('search.pendingAuthorSummary') }}: {{ entry.authors.map(author => author.name).join(', ') }}</small>
          <small v-if="entry.authorStatus" data-testid="pending-author-status">{{ t(entry.authorStatus === 'failed' ? 'search.syncFailed' : entry.authorStatus === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</small>
          <p v-if="entry.authorStatus && entry.authorStatus !== 'pending' && entry.authorLastError" role="alert" data-testid="pending-author-status-error">{{ entry.authorLastError }}</p>
          <button v-if="entry.status === 'pending' && entry.canEditAuthors === true && api.getPendingOfflineEntryAuthorOptions && api.enqueueOfflinePendingEntryAuthors"
            type="button" class="secondary-button" data-testid="pending-edit-authors" :disabled="pendingSaving || pendingTagsSaving || pendingAuthorsSaving || pendingMetadataSaving || pendingContentsSaving" @click="openPendingAuthors(entry)">{{ t('search.pendingEditAuthors') }}</button>
          <PendingEntryAuthorEditor v-if="editingAuthorsKey === entry.localKey" :key="entry.localKey" :api="api" :entry="entry"
            :save-authors="enqueuePendingAuthors" :create-author="api.enqueueOfflinePendingEntryAuthorCreate ? createPendingAuthor : undefined" @saved="savedPendingAuthors(entry, $event)" @cancel="editingAuthorsKey = null" />
          <p v-if="pendingAuthorsNotice && pendingAuthorsNoticeKey === entry.localKey" role="alert">{{ pendingAuthorsNotice }}</p>
          <small v-if="entry.tags?.length" data-testid="pending-tag-summary">{{ t('search.pendingTagSummary') }}: {{ entry.tags.map((tag) => tag.name).join(', ') }}</small>
          <small v-if="entry.tagEditStatus" data-testid="pending-tag-status">{{ t(entry.tagEditStatus === 'failed' ? 'search.syncFailed' : entry.tagEditStatus === 'conflict' ? 'search.syncConflict' : 'search.pendingSync') }}</small>
          <p v-if="entry.tagEditStatus && entry.tagEditStatus !== 'pending' && entry.tagEditError" role="alert">{{ entry.tagEditError }}</p>
          <button
            v-if="entry.status === 'pending' && entry.canEditTags === true && api.getPendingOfflineEntryTagOptions && api.enqueueOfflinePendingEntryTags"
            type="button" class="secondary-button" data-testid="pending-edit-tags"
            :disabled="pendingSaving || pendingTagsSaving || pendingAuthorsSaving || pendingMetadataSaving || pendingContentsSaving" @click="openPendingTags(entry)"
          >{{ t('search.pendingEditTags') }}</button>
          <PendingEntryTagEditor v-if="editingTagsKey === entry.localKey" :key="entry.localKey" :api="api" :entry="entry"
            :save-tags="enqueuePendingTags" :create-tag="createPendingTag" :create-facet="createPendingFacet" @saved="savedPendingTags(entry, $event)" @cancel="editingTagsKey = null" />
          <p v-if="pendingTagsNotice && pendingTagsNoticeKey === entry.localKey" role="alert">{{ pendingTagsNotice }}</p>
          <button
            v-if="entry.status === 'pending' && entry.canAppendContent === true && api.enqueueOfflinePendingEntryContent"
            type="button"
            class="secondary-button"
            data-testid="pending-add-content"
            :disabled="pendingSaving || pendingTagsSaving || pendingAuthorsSaving || pendingMetadataSaving || pendingContentsSaving"
                        @click="openPendingContent(entry)"
          >{{ t('search.pendingAddContent') }}</button>
          <form
            v-if="editingPendingKey === entry.localKey"
            class="pending-content-form"
            data-testid="pending-content-submit"
            @submit.prevent="appendPendingContent(entry)"
          >
            <input v-model="pendingContentType" data-testid="pending-content-type" :aria-label="t('search.pendingContentType')" :placeholder="t('search.pendingContentType')" required>
            <textarea v-model="pendingContentText" data-testid="pending-content-text" :aria-label="t('search.pendingContentText')" :placeholder="t('search.pendingContentText')" required />
            <button type="submit" class="primary-button" :disabled="pendingSaving || !pendingContentType.trim() || !pendingContentText.trim()">{{ t('search.pendingSaveContent') }}</button>
            <p v-if="pendingError && pendingErrorKey === entry.localKey" role="alert">{{ pendingError }}</p>
          </form>
          <p v-if="pendingError && pendingErrorKey === entry.localKey && editingPendingKey !== entry.localKey" class="pending-content-notice" role="alert">{{ pendingError }}</p>
        </article>
      </div>

      <PagedCardGrid
        v-if="visibleEntries.length"
        :items="visibleEntries"
        :page-key="`search:entries:${query.trim()}`"
        :total-items="entryTotal"
        :external-page="entryPage"
        @update:page="changeEntryPage"
        @update:page-size="changeEntryPageSize"
        v-slot="{ items }"
      >
        <article v-for="entry in items" :key="entry.id" class="search-card">
          <button
            type="button"
            class="search-card-main"
            :data-testid="`search-result-entry-${entry.id}`"
            @click="emit('open-entry', entry, query.trim(), scope)"
          >
            <div class="search-entry-stack">
              <LazyCardImage
                v-for="(mediaRef, index) in entryStackLayers(entry)"
                :key="`${mediaRef}-${index}`"
                class="search-entry-image"
                :src="api.assetUrl(entryCardMediaRef(mediaRef))"
                :style="entryStackLayerStyle(index, entryStackLayers(entry).length)"
                :alt="entry.title"
                loading="lazy"
                decoding="async"
              />
              <span v-if="entryStackLayers(entry).length === 0" class="search-placeholder">{{ entry.title.slice(0, 1).toUpperCase() }}</span>
              <span v-if="entry.likeCount > 0" class="search-like">👍 {{ entry.likeCount }}</span>
            </div>
            <span class="search-meta"><strong>{{ entry.title }}</strong><small>{{ entry.type }}</small></span>
          </button>
        </article>
      </PagedCardGrid>
    </div>

    <PagedCardGrid
      v-else-if="scope === 'producers' && visibleAuthors.length"
      :items="visibleAuthors"
      :page-key="`search:authors:${query.trim()}`"
      :total-items="authorTotal"
      :external-page="authorPage"
      @update:page="changeAuthorPage"
      @update:page-size="changeAuthorPageSize"
      v-slot="{ items }"
    >
      <article v-for="author in items" :key="author.id" class="search-card">
        <button
          type="button"
          class="search-card-main"
          :data-testid="`search-result-author-${author.id}`"
          @click="emit('open-author', author, query.trim(), scope)"
        >
          <span v-if="author.covers.length === 0" class="search-placeholder">{{ author.name.slice(0, 1).toUpperCase() }}</span>
          <span v-else class="search-author-covers">
            <LazyCardImage v-for="cover in author.covers.slice(0, 4)" :key="cover" :src="api.assetUrl(entryCardMediaRef(cover))" :alt="author.name" loading="lazy" decoding="async" />
          </span>
          <span class="search-meta">
            <strong>{{ author.name }}</strong>
            <small v-if="author.galleryType">{{ author.galleryType }}</small>
            <small
              v-if="alternatesFor(author.name)"
              class="author-name-alternates"
              :data-testid="`search-result-author-alternates-${author.id}`"
            >{{ alternatesFor(author.name) }}</small>
          </span>
        </button>
      </article>
    </PagedCardGrid>

    <ul v-else-if="scope === 'tags' && tags.length" class="search-tag-list">
      <li v-for="tag in tags" :key="tag.tagId">
        <button
          type="button"
          :data-testid="`search-result-tag-${tag.tagId}`"
          @click="emit('open-tag', tag, query.trim(), scope)"
        >
          <span># {{ tag.name }}</span>
          <small>{{ t('search.tagUses', { count: tag.entryCount }) }}</small>
        </button>
      </li>
    </ul>

    <p v-else-if="searched && !loading" class="search-empty">{{ t('search.empty') }}</p>
  </section>
</template>

<style scoped>
.search-page { display: grid; gap: 1.1rem; }
.search-heading h2 { margin: 0 0 0.35rem; font-size: clamp(1.8rem, 4vw, 2.5rem); letter-spacing: -0.04em; }
.search-heading p { margin-bottom: 0; }
.search-main-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.6rem; }
.search-main-form input { width: 100%; padding: 0.85rem 1rem; border: 1px solid var(--border-subtle); border-radius: 0.75rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; font-size: 1rem; }
.search-main-form input:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 20%, transparent); }
.search-scopes { display: flex; gap: 0.4rem; border-bottom: 1px solid var(--border-subtle); }
.search-scope { padding: 0.55rem 0.8rem; border: 0; border-bottom: 2px solid transparent; color: var(--text-muted); background: transparent; font: inherit; cursor: pointer; }
.search-scope.active { border-bottom-color: var(--accent); color: var(--accent); font-weight: 750; }
.search-count { margin: 0; color: var(--text-muted); font-size: 0.8rem; }
.search-entry-results { display: grid; gap: 1rem; }
.search-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.search-card { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); }
.search-card:hover, .search-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.search-card--pending { border-style: dashed; }
.search-card--editing { grid-column: span 2; }
.search-card--pending:hover { border-color: var(--border-subtle); transform: none; }
.search-card--pending .search-card-main { cursor: default; }
.search-card--pending > .secondary-button { margin: 0 0.65rem 0.65rem; padding: 0.4rem 0.55rem; border: 1px solid var(--border-subtle); border-radius: 0.45rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; font-size: 0.78rem; cursor: pointer; }
.pending-content-form { display: grid; gap: 0.45rem; padding: 0.65rem; }
.pending-content-form input, .pending-content-form textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 0.45rem; border: 1px solid var(--border-subtle); border-radius: 0.4rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; }
.pending-content-form textarea { min-height: 5rem; resize: vertical; }
.pending-content-form .primary-button { padding: 0.45rem; font-size: 0.8rem; }
.pending-content-form [role="alert"], .pending-content-notice { margin: 0; color: #a12626; font-size: 0.78rem; overflow-wrap: anywhere; }
.pending-content-notice { padding: 0 0.65rem 0.65rem; }
.author-name-alternates { font-size: 0.66rem; font-weight: 400; color: var(--text-muted); opacity: 0.72; }
.search-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.search-entry-stack { position: relative; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; perspective: 28rem; perspective-origin: 50% 50%; transform-style: preserve-3d; }
.search-entry-image { position: absolute; display: block; box-sizing: border-box; border: 1px solid var(--border-subtle); box-shadow: 0 0.2rem 0.5rem rgb(15 23 42 / 18%); transform-style: preserve-3d; }
.search-placeholder { display: grid; min-height: 8rem; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.search-like { position: absolute; z-index: 20; bottom: 0.35rem; left: 0.35rem; padding: 0.1rem 0.35rem; border-radius: 999px; color: white; background: rgb(15 23 42 / 72%); font-size: 0.68rem; }
.search-meta { display: grid; gap: 0.2rem; padding: 0.75rem; }
.search-meta small { color: var(--text-muted); }
.search-author-covers { display: grid; min-height: 8rem; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr); background: var(--tag-background); }
.search-author-covers img { width: 100%; height: 4rem; object-fit: cover; }
.search-tag-list { display: grid; gap: 0.45rem; margin: 0; padding: 0; list-style: none; }
.search-tag-list button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0.75rem 0.9rem; border: 1px solid var(--border-subtle); border-radius: 0.65rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; }
.search-tag-list button:hover { border-color: var(--accent); }
.search-tag-list small, .muted, .search-empty { color: var(--text-muted); }
.search-empty { margin: 1.5rem 0; text-align: center; }
.primary-button, .back-button { font: inherit; cursor: pointer; }
.primary-button { padding: 0.7rem 1rem; border: 1px solid var(--accent); border-radius: 0.7rem; color: white; background: var(--accent); font-weight: 750; }
.primary-button:disabled { opacity: 0.55; cursor: default; }
.back-button { justify-self: start; border: 0; color: var(--accent); background: transparent; }
.eyebrow { margin: 0 0 0.35rem; color: var(--accent); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
.error-message { margin: 0; padding: 0.75rem; border-radius: 0.6rem; color: #a12626; background: #fff0f0; }
@media (max-width: 34rem) { .search-main-form { grid-template-columns: 1fr; } }
</style>
