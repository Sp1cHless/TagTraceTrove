<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { EntryTagUsage, FacetFilterOptions, GallerySummary } from '@t3/shared';
import type { GalleryApi, GalleryAuthorSummary, GalleryEntrySummary } from './api/gallery.js';
import EntryCard from './components/EntryCard.vue';
import FacetFilterBar, { type GalleryFacetFilters } from './components/FacetFilterBar.vue';
import { showNsfw } from './stores/preferences.js';
import { useI18n } from './i18n.js';
import { useNavigationMemory } from './navigation-memory.js';
import { entryCardMediaRef } from './entry-media-stack.js';

/**
 * Random recommendation: a clean filter-style page. Works can be drawn with
 * no criteria at all or from one Gallery with the full facet filter applied;
 * Authors and Tags can also be drawn at random. One click of the random
 * button deals one page of results; every click re-deals.
 */

type RandomMode = 'works' | 'authors' | 'tags';

const RANDOM_PAGE_SIZE = 24;

const props = defineProps<{ api: GalleryApi }>();
const emit = defineEmits<{
  'open-entry': [entryId: number];
  'open-author': [authorId: number];
  'open-tag': [tag: { id: number; name: string }];
}>();

const { t } = useI18n();
const navigationMemory = useNavigationMemory();
const savedState = navigationMemory.states.get('random') as {
  mode?: RandomMode;
  selectedType?: string;
  filters?: GalleryFacetFilters;
  works?: GalleryEntrySummary[] | null;
  authors?: GalleryAuthorSummary[];
  tags?: EntryTagUsage[] | null;
} | undefined;

const mode = ref<RandomMode>(savedState?.mode ?? 'works');
const error = ref<string | null>(null);
const dealing = ref(false);
let dealRequestSequence = 0;

const galleries = ref<GallerySummary[]>([]);
const selectedType = ref<string>(savedState?.selectedType ?? ''); // '' = all galleries
const filters = ref<GalleryFacetFilters>(savedState?.filters ?? {
  conditions: [],
  authorIds: [],
  ratingConditions: [],
  ratingSort: null,
  usageConditions: [],
  usageSort: null,
});
const filterOptions = ref<FacetFilterOptions | null>(null);

const works = ref<GalleryEntrySummary[] | null>(savedState?.works ?? null);
const authors = ref<GalleryAuthorSummary[]>(savedState?.authors ?? []);
const tags = ref<EntryTagUsage[] | null>(savedState?.tags ?? null);

watch([mode, selectedType, filters, works, authors, tags], () => {
  navigationMemory.states.set('random', {
    mode: mode.value,
    selectedType: selectedType.value,
    filters: JSON.parse(JSON.stringify(filters.value)) as GalleryFacetFilters,
    works: works.value,
    authors: authors.value,
    tags: tags.value,
  });
}, { deep: true });

const visibleGalleries = computed(() => (
  galleries.value.filter((gallery) => showNsfw.value || !gallery.nsfw)
));
// More than one visible gallery → an extra "all galleries" deal is offered.
const allowAllGalleries = computed(() => visibleGalleries.value.length > 1);

function shuffle<T>(list: T[]): T[] {
  const result = [...list];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function dealWorks(): Promise<void> {
  const requestSequence = ++dealRequestSequence;
  dealing.value = true;
  error.value = null;
  try {
    const selectedFilters = selectedType.value === '' ? {
      conditions: [],
      authorIds: [],
      ratingConditions: [],
      ratingSort: null,
      usageConditions: [],
      usageSort: null,
    } : {
      conditions: filters.value.conditions.filter((condition) => condition.tagIds.length > 0),
      authorIds: filters.value.authorIds,
      ratingConditions: filters.value.ratingConditions,
      ratingSort: filters.value.ratingSort,
      usageConditions: filters.value.usageConditions,
      usageSort: filters.value.usageSort,
    };
    const result = await props.api.queryEntryPage({
      ...(selectedType.value === '' ? {} : { entryType: selectedType.value }),
      ...selectedFilters,
      sort: 'random',
      page: 1,
      pageSize: RANDOM_PAGE_SIZE,
    });
    if (requestSequence !== dealRequestSequence) return;
    works.value = result.items;
  } catch (cause) {
    if (requestSequence === dealRequestSequence) {
      error.value = cause instanceof Error ? cause.message : t('random.error');
    }
  } finally {
    if (requestSequence === dealRequestSequence) dealing.value = false;
  }
}

async function dealAuthors(): Promise<void> {
  const requestSequence = ++dealRequestSequence;
  dealing.value = true;
  error.value = null;
  try {
    const result = await props.api.queryProducerPage({
      ownTagIds: [],
      relatedEntryTagIds: [],
      includeNsfw: showNsfw.value,
      sort: 'random',
      randomSeed: Math.floor(Math.random() * 2_147_483_648),
      page: 1,
      pageSize: RANDOM_PAGE_SIZE,
    });
    if (requestSequence !== dealRequestSequence) return;
    authors.value = result.items;
  } catch (cause) {
    if (requestSequence === dealRequestSequence) {
      error.value = cause instanceof Error ? cause.message : t('random.error');
    }
  } finally {
    if (requestSequence === dealRequestSequence) dealing.value = false;
  }
}

async function dealTags(): Promise<void> {
  const requestSequence = ++dealRequestSequence;
  dealing.value = true;
  error.value = null;
  try {
    const batches = await Promise.all(
      visibleGalleries.value.map((gallery) => props.api.listGalleryTags(gallery.type)),
    );
    if (requestSequence !== dealRequestSequence) return;
    const byId = new Map<number, EntryTagUsage>();
    for (const tag of batches.flat()) {
      const existing = byId.get(tag.id);
      byId.set(tag.id, existing
        ? { ...existing, entryCount: existing.entryCount + tag.entryCount }
        : tag);
    }
    // One tag per deal — pick again for another.
    tags.value = shuffle([...byId.values()]).slice(0, 1);
  } catch (cause) {
    if (requestSequence === dealRequestSequence) {
      error.value = cause instanceof Error ? cause.message : t('random.error');
    }
  } finally {
    if (requestSequence === dealRequestSequence) dealing.value = false;
  }
}

function deal(): void {
  if (mode.value === 'works') void dealWorks();
  else if (mode.value === 'authors') void dealAuthors();
  else void dealTags();
}

async function loadFilterOptions(): Promise<void> {
  if (selectedType.value === '') {
    filterOptions.value = null;
    return;
  }
  try {
    filterOptions.value = await props.api.listFacetFilterOptions(selectedType.value, undefined);
  } catch {
    filterOptions.value = null;
  }
}

watch(selectedType, () => {
  dealRequestSequence += 1;
  dealing.value = false;
  filters.value = {
    conditions: [],
    authorIds: [],
    ratingConditions: [],
    ratingSort: null,
    usageConditions: [],
    usageSort: null,
  };
  works.value = null;
  void loadFilterOptions();
});

watch(showNsfw, () => {
  dealRequestSequence += 1;
  dealing.value = false;
  works.value = null;
  authors.value = [];
  tags.value = null;
  if (!visibleGalleries.value.some((gallery) => gallery.type === selectedType.value)) {
    selectedType.value = visibleGalleries.value[0]?.type ?? '';
  }
});

function switchMode(next: RandomMode): void {
  if (mode.value === next) return;
  mode.value = next;
  error.value = null;
}

onMounted(async () => {
  try {
    galleries.value = await props.api.listGalleries();
    if (!savedState && visibleGalleries.value.length > 0) {
      selectedType.value = visibleGalleries.value[0]!.type;
    } else if (selectedType.value !== ''
      && !visibleGalleries.value.some((gallery) => gallery.type === selectedType.value)) {
      selectedType.value = visibleGalleries.value[0]?.type ?? '';
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('random.error');
  }
});
</script>

<template>
  <section data-testid="random-page" class="recent-page">
    <header class="recent-toolbar">
      <h2>{{ t('random.title') }}</h2>
      <button
        data-testid="random-deal-button"
        class="primary-button"
        type="button"
        :disabled="dealing"
        @click="deal"
      >
        {{ dealing ? t('random.dealing') : t('random.deal') }}
      </button>
    </header>

    <div class="recent-tab-shell">
      <div class="recent-tabs" data-testid="random-mode-tabs" role="tablist">
        <button
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': mode === 'works' }"
          data-testid="random-mode-works"
          @click="switchMode('works')"
        >{{ t('random.works') }}</button>
        <button
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': mode === 'authors' }"
          data-testid="random-mode-authors"
          @click="switchMode('authors')"
        >{{ t('random.authors') }}</button>
        <button
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': mode === 'tags' }"
          data-testid="random-mode-tags"
          @click="switchMode('tags')"
        >{{ t('random.tags') }}</button>
      </div>

      <div class="recent-tab-panel" data-testid="random-panel" role="tabpanel">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>

        <template v-if="mode === 'works'">
          <div class="random-type-row" data-testid="random-type-row">
            <button
              v-if="allowAllGalleries"
              type="button"
              class="recent-tab"
              :class="{ 'recent-tab-active': selectedType === '' }"
              data-testid="random-type-all"
              @click="selectedType = ''"
            >{{ t('random.allGalleries') }}</button>
            <button
              v-for="gallery in visibleGalleries"
              :key="gallery.type"
              type="button"
              class="recent-tab"
              :class="{ 'recent-tab-active': selectedType === gallery.type }"
              :data-testid="`random-type-${gallery.type}`"
              @click="selectedType = gallery.type"
            >{{ gallery.type }}</button>
          </div>
          <div v-if="filterOptions && selectedType !== ''" class="random-filter-row">
            <FacetFilterBar
              :options="filterOptions"
              :model-value="filters"
              @update:model-value="(value) => (filters = value)"
            />
          </div>
          <p v-if="works !== null && works.length === 0" class="muted" data-testid="random-empty">
            {{ t('random.empty') }}
          </p>
          <div v-else-if="works !== null" class="recent-grid recent-grid-compact" data-testid="random-works">
            <EntryCard
              v-for="entry in works"
              :key="entry.id"
              :api="api"
              :entry="entry"
              data-testid="random-entry-card"
              @open="emit('open-entry', entry.id)"
            />
          </div>
          <p v-else class="muted">{{ t('random.hint') }}</p>
        </template>

        <template v-else-if="mode === 'authors'">
          <p v-if="authors.length === 0" class="muted">{{ t('random.hint') }}</p>
          <div v-else class="author-list" data-testid="random-authors">
            <button
              v-for="author in authors"
              :key="author.id"
              type="button"
              class="author-list-card"
              :data-author-id="author.id"
              @click="emit('open-author', author.id)"
            >
              <span v-if="author.covers.length" class="author-list-cover">
                <img v-for="coverRef in author.covers" :key="coverRef" :src="api.assetUrl(entryCardMediaRef(coverRef))" :alt="author.name">
              </span>
              <span v-else class="author-list-badge">{{ author.name.slice(0, 1).toUpperCase() }}</span>
              <strong>{{ author.name }}</strong>
            </button>
          </div>
        </template>

        <template v-else>
          <p v-if="tags === null || tags.length === 0" class="muted">{{ t('random.hint') }}</p>
          <div v-else class="random-tag-cloud" data-testid="random-tags">
            <button
              v-for="tag in tags"
              :key="tag.id"
              type="button"
              class="random-tag-single"
              data-testid="random-tag-card"
              :data-random-tag-id="tag.id"
              @click="emit('open-tag', { id: tag.id, name: tag.name })"
            >
              <span class="random-tag-mark" aria-hidden="true">#</span>
              <strong class="random-tag-name" data-testid="random-tag-name">{{ tag.name }}</strong>
              <small class="random-tag-count" data-testid="random-tag-count">{{ tag.entryCount }}</small>
            </button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recent-page { display: grid; gap: 1rem; }
.recent-toolbar { display: flex; align-items: center; gap: 1rem; }
.recent-toolbar h2 { margin: 0; flex: 1; }
.random-type-row { display: flex; flex-wrap: wrap; gap: 0.4rem; padding-bottom: 0.6rem; border-bottom: 1px dashed var(--border-subtle); margin-bottom: 0.7rem; }
.random-type-row .recent-tab { margin-bottom: 0; border-radius: 999px; }
.random-filter-row { margin-bottom: 0.7rem; }
.recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.recent-grid-compact { grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.author-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.8rem; }
.author-list-card { display: grid; gap: 0.45rem; padding: 0.6rem; border: 1px solid var(--border-subtle); border-radius: 0.8rem; color: var(--text-primary); background: var(--surface-muted); font: inherit; text-align: left; cursor: pointer; align-content: start; }
.author-list-cover { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.15rem; width: 100%; aspect-ratio: 3 / 4; overflow: hidden; border-radius: 0.5rem; background: var(--tag-background); }
.author-list-cover img { width: 100%; height: 100%; object-fit: cover; min-width: 0; }
.author-list-badge { display: grid; place-items: center; width: 100%; aspect-ratio: 3 / 4; border-radius: 0.5rem; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.random-tag-cloud { display: grid; min-height: 18rem; padding: clamp(2.5rem, 8vh, 5rem) 1rem; place-items: center; }
.random-tag-single {
  position: relative;
  display: grid;
  width: min(100%, 34rem);
  min-height: 12rem;
  padding: clamp(1.5rem, 4vw, 2.5rem);
  place-items: center;
  gap: 0.65rem;
  overflow: hidden;
  border: 1px solid var(--tag-border);
  border-radius: var(--radius-panel);
  color: var(--tag-text);
  background: linear-gradient(135deg, var(--accent-soft), var(--surface));
  box-shadow: var(--shadow-panel);
  font: inherit;
  text-align: center;
  cursor: pointer;
  transition: transform var(--transition-duration) ease,
    border-color var(--transition-duration) ease,
    box-shadow var(--transition-duration) ease;
}
.random-tag-single::before {
  position: absolute;
  width: 11rem;
  height: 11rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  content: '';
  transform: translate(11rem, -5rem);
}
.random-tag-single:hover { border-color: var(--accent); box-shadow: var(--shadow-overlay); transform: translateY(-3px); }
.random-tag-single:active { transform: translateY(-1px) scale(0.99); }
.random-tag-single:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 3px; }
.random-tag-mark { color: var(--accent); font-size: 1.2rem; font-weight: 850; }
.random-tag-name { z-index: 1; max-width: 100%; overflow-wrap: anywhere; font-size: clamp(1.8rem, 4vw, 3rem); line-height: 1.08; }
.random-tag-count { z-index: 1; min-width: 2.25rem; padding: 0.25rem 0.65rem; border: 1px solid var(--tag-border); border-radius: 999px; color: var(--text-muted); background: var(--surface); font-size: 0.8rem; }
@media (prefers-reduced-motion: reduce) {
  .random-tag-single { transition: none; }
  .random-tag-single:hover,
  .random-tag-single:active { transform: none; }
}
.primary-button { padding: 0.45rem 0.9rem; border: 1px solid var(--accent); border-radius: 0.55rem; color: white; background: var(--accent); font: inherit; cursor: pointer; }
.primary-button:disabled { opacity: 0.55; cursor: default; }
.muted { color: var(--text-muted); }
@media (max-width: 44rem) {
  .recent-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .recent-toolbar h2 { flex-basis: 100%; }
  .random-tag-cloud { min-height: 12rem; padding: 1rem 0; }
}
</style>
