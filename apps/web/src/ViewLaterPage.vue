<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GalleryApi, GalleryAuthorSummary, GalleryEntrySummary } from './api/gallery.js';
import AppIcon from './components/AppIcon.vue';
import EntryCard from './components/EntryCard.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import LazyCardImage from './components/LazyCardImage.vue';
import { useI18n } from './i18n.js';
import { shuffledCopy } from './random-sort.js';
import { useNavigationMemory } from './navigation-memory.js';
import { entryCardMediaRef } from './entry-media-stack.js';
import {
  removeAuthorFromViewLater,
  removeEntryFromViewLater,
  showNsfw,
  viewLaterAuthorIds,
  viewLaterIds,
} from './stores/preferences.js';

type EntityKind = 'entry' | 'author';
type RecentMode = 'lastViewed' | 'mostViewed' | 'mostLiked' | 'random' | null;

interface GalleryTab {
  type: string;
  entryCount: number;
}

const props = defineProps<{
  api: GalleryApi;
  initialKind?: EntityKind;
  initialTab?: string;
}>();
const emit = defineEmits<{
  'open-entry': [entryId: number];
  'open-author': [authorId: number];
  'active-tab-change': [type: string];
}>();
const { t } = useI18n();
const navigationMemory = useNavigationMemory();
const savedState = navigationMemory.states.get('view-later') as { mode?: RecentMode } | undefined;

const loading = ref(false);
const error = ref<string | null>(null);
const entries = ref<GalleryEntrySummary[]>([]);
const authors = ref<GalleryAuthorSummary[]>([]);
const tabs = ref<GalleryTab[]>([]);
const activeTab = ref(props.initialTab ?? '');
const entityKind = ref<EntityKind>(props.initialKind ?? 'entry');
const mode = ref<RecentMode>(savedState?.mode ?? null);
watch(mode, (currentMode) => navigationMemory.states.set('view-later', { mode: currentMode }));
const TAB_ORDER_KEY = 't3.view-later-tabs.order';
const tabOrder = ref<string[]>(restoreTabOrder());
const draggedTab = ref<string | null>(null);
const dropTargetTab = ref<string | null>(null);
const organizingTabs = ref(false);

function restoreTabOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(TAB_ORDER_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveTabOrder(): void {
  try {
    window.localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(tabOrder.value));
  } catch {
    // Storage unavailable — the default order still works.
  }
}

const orderedTabs = computed(() => {
  const known = tabs.value.map((gallery) => gallery.type);
  const saved = tabOrder.value.filter((type) => known.includes(type));
  const orderedTypes = [...saved, ...known.filter((type) => !saved.includes(type))];
  const byType = new Map(tabs.value.map((gallery) => [gallery.type, gallery]));
  return orderedTypes.map((type) => byType.get(type)).filter((tab): tab is GalleryTab => tab !== undefined);
});

const allowedGalleries = computed(() => orderedTabs.value.filter((gallery) => showNsfw.value || !gallery.type.toLowerCase().includes('nsfw')));

const savedEntries = computed(() => {
  const byId = new Map(entries.value.map((entry) => [entry.id, entry]));
  return viewLaterIds.value
    .map((id) => byId.get(id))
    .filter((entry): entry is GalleryEntrySummary => entry !== undefined);
});

const activeEntries = computed(() => {
  const current = savedEntries.value.filter((entry) => entry.type === activeTab.value);
  if (mode.value === 'random') return shuffledCopy(current);
  return [...current].sort((left, right) => {
    if (mode.value === 'mostViewed') return right.viewCount - left.viewCount || left.title.localeCompare(right.title);
    if (mode.value === 'mostLiked') return right.likeCount - left.likeCount || left.title.localeCompare(right.title);
    if (mode.value === 'lastViewed') {
      const leftTime = left.lastViewedAt ? Date.parse(left.lastViewedAt) : -1;
      const rightTime = right.lastViewedAt ? Date.parse(right.lastViewedAt) : -1;
      return rightTime - leftTime || left.title.localeCompare(right.title);
    }
    return viewLaterIds.value.indexOf(left.id) - viewLaterIds.value.indexOf(right.id);
  });
});

const savedAuthors = computed(() => {
  const byId = new Map(authors.value.map((author) => [author.id, author]));
  const current = viewLaterAuthorIds.value
    .map((id) => byId.get(id))
    .filter((author): author is GalleryAuthorSummary => author !== undefined)
    .filter((author) => showNsfw.value || !author.nsfw);
  if (mode.value === 'random') return shuffledCopy(current);
  return [...current].sort((left, right) => {
    if (mode.value === 'mostViewed') return right.viewCount - left.viewCount || left.name.localeCompare(right.name);
    if (mode.value === 'mostLiked') return right.likeCount - left.likeCount || left.name.localeCompare(right.name);
    if (mode.value === 'lastViewed') {
      const leftTime = left.lastViewedAt ? Date.parse(left.lastViewedAt) : -1;
      const rightTime = right.lastViewedAt ? Date.parse(right.lastViewedAt) : -1;
      return rightTime - leftTime || left.name.localeCompare(right.name);
    }
    return viewLaterAuthorIds.value.indexOf(left.id) - viewLaterAuthorIds.value.indexOf(right.id);
  });
});

watch(allowedGalleries, (visibleTabs) => {
  if (tabs.value.length > 0 && !visibleTabs.some((tab) => tab.type === activeTab.value)) {
    activeTab.value = visibleTabs[0]?.type ?? '';
  }
  if (visibleTabs.length < 2) organizingTabs.value = false;
}, { immediate: true });

watch(activeTab, (type) => emit('active-tab-change', type));

watch(entityKind, () => {
  organizingTabs.value = false;
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

function usageNote(item: { viewCount: number; likeCount: number; lastViewedAt: string | null }): string {
  if (mode.value === 'mostLiked') return t('card.likeCount', { count: item.likeCount });
  if (mode.value === 'lastViewed') {
    return item.lastViewedAt ? t('card.lastViewed', { date: formatDate(item.lastViewedAt) }) : '';
  }
  return t('card.viewCount', { count: item.viewCount });
}

function onTabDragStart(type: string): void {
  draggedTab.value = type;
}

function onTabDragOver(type: string): void {
  if (draggedTab.value && draggedTab.value !== type) dropTargetTab.value = type;
}

function placeTab(sourceType: string, targetType: string): void {
  if (sourceType === targetType) return;
  const ordered = [...orderedTabs.value];
  const fromIndex = ordered.findIndex((tab) => tab.type === sourceType);
  const toIndex = ordered.findIndex((tab) => tab.type === targetType);
  if (fromIndex < 0 || toIndex < 0) return;
  const [moved] = ordered.splice(fromIndex, 1);
  if (!moved) return;
  ordered.splice(toIndex, 0, moved);
  tabOrder.value = ordered.map((tab) => tab.type);
  saveTabOrder();
}

const activeTabPosition = computed(() => allowedGalleries.value.findIndex((tab) => tab.type === activeTab.value));

function moveActiveTab(direction: -1 | 1): void {
  const target = allowedGalleries.value[activeTabPosition.value + direction];
  if (target) placeTab(activeTab.value, target.type);
}

function onTabDrop(targetType: string): void {
  const sourceType = draggedTab.value;
  draggedTab.value = null;
  dropTargetTab.value = null;
  if (!sourceType || sourceType === targetType) return;
  placeTab(sourceType, targetType);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [galleries, authorSummaries, savedEntrySummaries] = await Promise.all([
      props.api.listGalleries(),
      loadSavedAuthors(),
      loadSavedEntries(),
    ]);
    entries.value = savedEntrySummaries;
    authors.value = authorSummaries;
    tabs.value = galleries.map((gallery) => ({
      type: gallery.type,
      entryCount: savedEntrySummaries.filter((entry) => entry.type === gallery.type).length,
    }));
    if (!allowedGalleries.value.some((tab) => tab.type === activeTab.value)) {
      activeTab.value = allowedGalleries.value[0]?.type ?? '';
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  } finally {
    loading.value = false;
  }
}

async function loadSavedAuthors(): Promise<GalleryAuthorSummary[]> {
  if (viewLaterAuthorIds.value.length === 0) return [];
  const loaded: GalleryAuthorSummary[] = [];
  let page = 1;
  while (true) {
    const result = await props.api.queryProducerPage({
      producerIds: viewLaterAuthorIds.value,
      ownTagIds: [],
      relatedEntryTagIds: [],
      includeNsfw: true,
      sort: 'source-order',
      page,
      pageSize: 100,
    });
    loaded.push(...result.items);
    if (loaded.length >= result.total || result.items.length === 0) return loaded;
    page += 1;
  }
}

async function loadSavedEntries(): Promise<GalleryEntrySummary[]> {
  if (viewLaterIds.value.length === 0) return [];
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
      entryIds: viewLaterIds.value,
      sort: 'source-order',
      page,
      pageSize: 100,
    });
    loaded.push(...result.items);
    if (loaded.length >= result.total || result.items.length === 0) return loaded;
    page += 1;
  }
}

onMounted(load);

function openEntry(entryId: number): void {
  emit('open-entry', entryId);
}

async function removeEntry(entryId: number): Promise<void> {
  error.value = null;
  try {
    await removeEntryFromViewLater(props.api, entryId);
    tabs.value = tabs.value.map((tab) => ({
      ...tab,
      entryCount: entries.value.filter((entry) => entry.type === tab.type && viewLaterIds.value.includes(entry.id)).length,
    }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntries');
  }
}

async function removeAuthor(authorId: number): Promise<void> {
  error.value = null;
  try {
    await removeAuthorFromViewLater(props.api, authorId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadAuthors');
  }
}
</script>

<template>
  <section data-testid="view-later-page" class="recent-page">
    <header class="recent-toolbar">
      <h2>{{ t('viewLater.title') }}</h2>
      <div class="recent-mode-switch" role="group" :aria-label="t('sort.groupLabel')">
        <button type="button" class="recent-mode-button" :class="{ 'recent-mode-active': mode === 'lastViewed' }" data-testid="view-later-mode-last-viewed" :aria-label="t('recent.lastViewed')" :title="t('recent.lastViewed')" @click="mode = mode === 'lastViewed' ? null : 'lastViewed'"><AppIcon name="history" :size="16" /></button>
        <button type="button" class="recent-mode-button" :class="{ 'recent-mode-active': mode === 'mostViewed' }" data-testid="view-later-mode-most-viewed" :aria-label="t('recent.mostViewed')" :title="t('recent.mostViewed')" @click="mode = mode === 'mostViewed' ? null : 'mostViewed'"><AppIcon name="view-count" :size="16" /></button>
        <button type="button" class="recent-mode-button" :class="{ 'recent-mode-active': mode === 'mostLiked' }" data-testid="view-later-mode-most-liked" :aria-label="t('recent.mostLiked')" :title="t('recent.mostLiked')" @click="mode = mode === 'mostLiked' ? null : 'mostLiked'"><AppIcon name="thumb-up" :size="16" /></button>
        <button type="button" class="recent-mode-button" :class="{ 'recent-mode-active': mode === 'random' }" data-testid="view-later-mode-random" :aria-label="t('sort.random')" :title="t('sort.random')" @click="mode = mode === 'random' ? null : 'random'"><AppIcon name="shuffle" :size="16" /></button>
        <button
          v-if="entityKind === 'entry' && allowedGalleries.length > 1 && !organizingTabs"
          type="button"
          class="recent-mode-button"
          data-testid="view-later-tab-order-toggle"
          :aria-label="t('tabs.reorder')"
          :title="t('tabs.reorder')"
          @click="organizingTabs = true"
        ><AppIcon name="reorder" :size="16" /></button>
        <template v-else-if="entityKind === 'entry' && allowedGalleries.length > 1">
          <button
            type="button"
            class="recent-mode-button tab-order-button"
            data-testid="view-later-tab-move-earlier"
            :disabled="activeTabPosition <= 0"
            :aria-label="t('tabs.moveEarlier', { name: activeTab })"
            @click="moveActiveTab(-1)"
          >←</button>
          <button
            type="button"
            class="recent-mode-button tab-order-button"
            data-testid="view-later-tab-move-later"
            :disabled="activeTabPosition < 0 || activeTabPosition >= allowedGalleries.length - 1"
            :aria-label="t('tabs.moveLater', { name: activeTab })"
            @click="moveActiveTab(1)"
          >→</button>
        </template>
      </div>
    </header>

    <div class="entity-tabs" role="tablist" :aria-label="t('viewLater.title')">
      <button type="button" class="entity-tab" :class="{ 'entity-tab-active': entityKind === 'entry' }" data-testid="view-later-kind-entry" role="tab" :aria-selected="entityKind === 'entry'" @click="entityKind = 'entry'">
        {{ t('viewLater.entries') }} <span>{{ viewLaterIds.length }}</span>
      </button>
      <button type="button" class="entity-tab" :class="{ 'entity-tab-active': entityKind === 'author' }" data-testid="view-later-kind-author" role="tab" :aria-selected="entityKind === 'author'" @click="entityKind = 'author'">
        {{ t('viewLater.authors') }} <span>{{ viewLaterAuthorIds.length }}</span>
      </button>
    </div>

    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="muted">{{ t('import.preparing') }}</p>

    <div v-else-if="entityKind === 'entry'" class="recent-tab-shell">
      <div class="recent-tabs" data-testid="view-later-tabs" role="tablist">
        <button
          v-for="tab in allowedGalleries"
          :key="tab.type"
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': tab.type === activeTab, 'recent-tab-drop': tab.type === dropTargetTab }"
          draggable="true"
          role="tab"
          :aria-selected="tab.type === activeTab"
          :data-view-later-tab="tab.type"
          @click="activeTab = tab.type; organizingTabs = false"
          @dragstart="onTabDragStart(tab.type)"
          @dragover.prevent="onTabDragOver(tab.type)"
          @drop.prevent="onTabDrop(tab.type)"
          @dragend="draggedTab = null; dropTargetTab = null"
        >
          {{ tab.type }} <span class="recent-tab-count">{{ savedEntries.filter((entry) => entry.type === tab.type).length }}</span>
        </button>
      </div>
      <div class="recent-tab-panel" data-testid="view-later-panel" role="tabpanel">
        <p v-if="activeEntries.length === 0" class="muted">{{ t('viewLater.empty') }}</p>
        <PagedCardGrid v-else :items="activeEntries" :page-key="`view-later:entries:${activeTab}:${mode ?? 'saved'}`" grid-class="recent-grid recent-grid-compact" grid-testid="view-later-entry-grid" v-slot="{ items }">
          <EntryCard v-for="entry in items" :key="entry.id" :api="api" :entry="entry" :note="usageNote(entry)" data-testid="view-later-entry-card" @open="openEntry(entry.id)">
            <template #corner>
              <button type="button" class="view-later-remove" :data-testid="'view-later-remove-' + entry.id" :aria-label="t('entry.viewLaterRemove')" @click.stop="removeEntry(entry.id)">×</button>
            </template>
          </EntryCard>
        </PagedCardGrid>
      </div>
    </div>

    <div v-else class="recent-tab-panel author-panel" role="tabpanel">
      <p v-if="savedAuthors.length === 0" class="muted" data-testid="view-later-author-empty">{{ t('viewLater.authorEmpty') }}</p>
      <PagedCardGrid v-else :items="savedAuthors" page-key="view-later:authors" grid-class="author-grid" grid-testid="view-later-author-grid" v-slot="{ items }">
        <article v-for="author in items" :key="author.id" class="author-card" :data-view-later-author-id="author.id">
          <button type="button" class="author-card-main" @click="emit('open-author', author.id)">
            <span v-if="author.covers.length" class="author-cover-grid">
              <LazyCardImage v-for="coverRef in author.covers.slice(0, 4)" :key="coverRef" :src="api.assetUrl(entryCardMediaRef(coverRef))" :alt="author.name" loading="lazy" decoding="async" />
            </span>
            <span v-else class="author-placeholder">{{ author.name.slice(0, 1).toUpperCase() }}</span>
            <span class="author-card-meta">
              <strong>{{ author.name }}</strong>
              <small v-if="author.galleryType">{{ author.galleryType }}</small>
              <small class="entry-usage-note">{{ usageNote(author) }}</small>
            </span>
          </button>
          <button type="button" class="view-later-remove" :data-remove-view-later-author-id="author.id" :aria-label="t('entry.viewLaterRemove')" @click.stop="removeAuthor(author.id)">×</button>
        </article>
      </PagedCardGrid>
    </div>
  </section>
</template>

<style scoped>
.recent-page { display: grid; gap: 1rem; }
.view-later-remove { position: absolute; top: 0.05rem; left: 0.05rem; z-index: 2; display: grid; width: 44px; height: 44px; padding: 0; place-items: center; border: 0; border-radius: 50%; background: radial-gradient(circle, rgb(0 0 0 / 58%) 0 0.68rem, transparent 0.72rem); color: #fff; font: inherit; font-size: 0.9rem; line-height: 1; cursor: pointer; touch-action: manipulation; }
.view-later-remove:hover { background: radial-gradient(circle, rgb(0 0 0 / 78%) 0 0.68rem, transparent 0.72rem); }
.recent-toolbar { display: flex; align-items: center; gap: 1rem; }
.recent-toolbar h2 { margin: 0; flex: 1; }
.recent-mode-switch { display: inline-flex; gap: 0.3rem; }
.recent-mode-button { display: inline-grid; place-items: center; width: var(--icon-button-size); height: var(--icon-button-size); padding: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--icon-muted); background: transparent; line-height: 1; cursor: pointer; transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.recent-mode-button:hover { color: var(--accent); background: var(--surface-hover); border-color: var(--border-strong); }
.recent-mode-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.tab-order-button { color: var(--accent); font-size: 1.1rem; }
.tab-order-button:disabled { opacity: 0.35; cursor: default; }
.recent-mode-active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.entity-tabs { display: flex; gap: 0.45rem; border-bottom: 1px solid var(--border-subtle); }
.entity-tab { display: flex; align-items: center; gap: 0.4rem; padding: 0.55rem 0.8rem; border: 0; border-bottom: 2px solid transparent; color: var(--text-muted); background: transparent; font: inherit; font-weight: 700; cursor: pointer; }
.entity-tab span { min-width: 1.35rem; padding: 0.05rem 0.35rem; border-radius: 999px; background: var(--surface-muted); font-size: 0.75rem; text-align: center; }
.entity-tab-active { border-bottom-color: var(--accent); color: var(--accent); }
.author-panel { min-height: 10rem; }
.author-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.8rem; }
.author-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); transition: border-color var(--transition-duration) ease, transform var(--transition-duration) ease; }
.author-card:hover, .author-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.author-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.author-cover-grid { display: grid; width: 100%; aspect-ratio: 1 / 1; grid-template-columns: repeat(2, 1fr); overflow: hidden; background: var(--tag-background); }
.author-cover-grid img { width: 100%; height: 100%; min-width: 0; object-fit: cover; }
.author-placeholder { display: grid; width: 100%; aspect-ratio: 1 / 1; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.author-card-meta { display: grid; gap: 0.2rem; min-width: 0; padding: 0.75rem; }
.author-card-meta strong { overflow-wrap: anywhere; }
.author-card-meta small, .entry-usage-note { color: var(--text-muted); }

@media (max-width: 52rem) {
  .author-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 44rem) {
  .recent-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .recent-toolbar h2 { flex-basis: 100%; }
  .entity-tabs { max-width: 100%; overflow-x: auto; }
  .entity-tab { min-height: 44px; flex: 0 0 auto; }
  .view-later-remove { width: 44px; height: 44px; }
}

@media (max-width: 30rem) {
  .author-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
