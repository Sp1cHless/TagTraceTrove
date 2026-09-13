<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { normalizeTag, type SearchScope, type TagSearchHit } from '@t3/shared';
import type {
  GalleryApi,
  GalleryAuthorSummary,
  GalleryEntrySummary,
} from './api/gallery.js';
import { entryCardMediaRef, entryStackLayerStyle, entryStackLayers } from './entry-media-stack.js';
import PagedCardGrid from './components/PagedCardGrid.vue';
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
  if (scope.value === 'entries') return entryTotal.value;
  if (scope.value === 'tags') return tags.value.length;
  return authorTotal.value;
});

async function runSearch(resetPage = true): Promise<void> {
  const nextQuery = query.value.trim();
  const sequence = ++requestSequence;
  error.value = null;
  if (!nextQuery) {
    entries.value = [];
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
      const result = await props.api.queryEntryPage({
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
      });
      entries.value = result.items;
      entryTotal.value = result.total;
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

    <PagedCardGrid
      v-if="scope === 'entries' && visibleEntries.length"
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
            <img
              v-for="(mediaRef, index) in entryStackLayers(entry)"
              :key="`${mediaRef}-${index}`"
              class="search-entry-image"
              :src="api.assetUrl(entryCardMediaRef(mediaRef))"
              :style="entryStackLayerStyle(index, entryStackLayers(entry).length)"
              :alt="entry.title"
              loading="lazy"
              decoding="async"
            >
            <span v-if="entryStackLayers(entry).length === 0" class="search-placeholder">{{ entry.title.slice(0, 1).toUpperCase() }}</span>
            <span v-if="entry.likeCount > 0" class="search-like">👍 {{ entry.likeCount }}</span>
          </div>
          <span class="search-meta"><strong>{{ entry.title }}</strong><small>{{ entry.type }}</small></span>
        </button>
      </article>
    </PagedCardGrid>

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
            <img v-for="cover in author.covers.slice(0, 4)" :key="cover" :src="api.assetUrl(entryCardMediaRef(cover))" :alt="author.name" loading="lazy" decoding="async">
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
.search-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.search-card { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); }
.search-card:hover, .search-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
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
