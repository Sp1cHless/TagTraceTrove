<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GalleryApi, GalleryEntrySummary } from './api/gallery.js';
import EntryCard from './components/EntryCard.vue';
import AppIcon from './components/AppIcon.vue';
import PagedCardGrid from './components/PagedCardGrid.vue';
import { showNsfw, viewLaterIds } from './stores/preferences.js';
import { useI18n } from './i18n.js';

const props = defineProps<{
  api: GalleryApi;
}>();

const emit = defineEmits<{
  'open-entry': [entryId: number];
}>();

const { t } = useI18n();

type RecentMode = 'lastViewed' | 'mostViewed' | 'mostLiked';

const galleries = ref<Array<{ type: string; entryCount: number; nsfw: boolean }>>([]);
const entriesByType = ref<Map<string, GalleryEntrySummary[]>>(new Map());
const activeTab = ref<string>('');
const mode = ref<RecentMode | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const TAB_ORDER_KEY = 't3.view-later-tabs.order';
const draggedTab = ref<string | null>(null);
const dropTargetTab = ref<string | null>(null);

onMounted(load);
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    galleries.value = await props.api.listGalleries();
    const lists = await Promise.all(
      galleries.value.map(async (gallery) => [gallery.type, await props.api.listEntries(gallery.type)] as const),
    );
    entriesByType.value = new Map(lists);
    if (!tabs.value.some((tab) => tab.type === activeTab.value)) {
      activeTab.value = tabs.value[0]?.type ?? '';
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('error.loadEntry');
  } finally {
    loading.value = false;
  }
}

// Every Gallery is a permanent tab (empty ones too); the saved order is a
// display preference stored locally, most-used tabs can be dragged leftward.
const tabOrder = ref<string[]>(restoreTabOrder());

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

const tabs = computed(() => {
  const known = galleries.value.map((gallery) => gallery.type);
  const saved = tabOrder.value.filter((type) => known.includes(type));
  const rest = known.filter((type) => !saved.includes(type));
  return [...saved, ...rest].map((type) => ({
    type,
    entryCount: galleries.value.find((gallery) => gallery.type === type)?.entryCount ?? 0,
  }));
});

function onTabDragStart(type: string): void {
  draggedTab.value = type;
}

function onTabDragOver(type: string): void {
  if (draggedTab.value !== null) dropTargetTab.value = type;
}

function onTabDrop(type: string): void {
  const dragged = draggedTab.value;
  draggedTab.value = null;
  dropTargetTab.value = null;
  if (!dragged || dragged === type) return;
  const current = tabs.value.map((tab) => tab.type);
  const from = current.indexOf(dragged);
  const to = current.indexOf(type);
  if (from < 0 || to < 0) return;
  current.splice(to, 0, ...current.splice(from, 1));
  tabOrder.value = current;
  saveTabOrder();
}

const hiddenTypes = computed(() => new Set(galleries.value.filter((g) => g.nsfw).map((g) => g.type)));
const savedIds = computed(() => new Set(viewLaterIds.value));

const activeEntries = computed(() => {
  const list = (entriesByType.value.get(activeTab.value) ?? [])
    .filter((entry) => savedIds.value.has(entry.id)
      && (showNsfw.value || !hiddenTypes.value.has(entry.type)));
  const sorted = [...list];
  if (mode.value === 'mostViewed') {
    sorted.sort((left, right) => right.viewCount - left.viewCount || left.id - right.id);
  } else if (mode.value === 'mostLiked') {
    sorted.sort((left, right) => right.likeCount - left.likeCount || left.id - right.id);
  } else if (mode.value === 'lastViewed') {
    sorted.sort((left, right) => {
      const leftTime = left.lastViewedAt ?? '';
      const rightTime = right.lastViewedAt ?? '';
      return rightTime.localeCompare(leftTime) || left.id - right.id;
    });
  }
  // null mode = no sort: the natural listing order stays.
  return sorted;
});

function cardNote(entry: GalleryEntrySummary): string {
  if (mode.value === 'mostLiked') {
    return t('card.likeCount', { count: entry.likeCount });
  }
  if (mode.value === 'lastViewed') {
    return t('card.lastViewed', { date: entry.lastViewedAt ? formatDate(entry.lastViewedAt) : '—' });
  }
  return t('card.viewCount', { count: entry.viewCount });
}

function formatDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? isoTimestamp.slice(0, 10) : date.toISOString().slice(0, 10);
}

function openEntry(entryId: number): void {
  emit('open-entry', entryId);
}

function removeEntry(entryId: number): void {
  viewLaterIds.value = viewLaterIds.value.filter((id) => id !== entryId);
}
</script>

<template>
  <section data-testid="view-later-page" class="recent-page">
    <header class="recent-toolbar">
      <h2>{{ t('viewLater.title') }}</h2>
      <div class="recent-mode-switch" role="group" :aria-label="t('sort.groupLabel')">
        <button
          type="button"
          class="recent-mode-button"
          :class="{ 'recent-mode-active': mode === 'lastViewed' }"
          data-testid="view-later-mode-last-viewed"
          :aria-label="t('recent.lastViewed')"
          :title="t('recent.lastViewed')"
          @click="mode = mode === 'lastViewed' ? null : 'lastViewed'"
        ><AppIcon name="history" :size="16" /></button>
        <button
          type="button"
          class="recent-mode-button"
          :class="{ 'recent-mode-active': mode === 'mostViewed' }"
          data-testid="view-later-mode-most-viewed"
          :aria-label="t('recent.mostViewed')"
          :title="t('recent.mostViewed')"
          @click="mode = mode === 'mostViewed' ? null : 'mostViewed'"
        ><AppIcon name="view-count" :size="16" /></button>
        <button
          type="button"
          class="recent-mode-button"
          :class="{ 'recent-mode-active': mode === 'mostLiked' }"
          data-testid="view-later-mode-most-liked"
          :aria-label="t('recent.mostLiked')"
          :title="t('recent.mostLiked')"
          @click="mode = mode === 'mostLiked' ? null : 'mostLiked'"
        ><AppIcon name="thumb-up" :size="16" /></button>
      </div>
    </header>

    <div class="recent-tab-shell">
      <div class="recent-tabs" data-testid="view-later-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.type"
          type="button"
          class="recent-tab"
          :class="{ 'recent-tab-active': tab.type === activeTab, 'recent-tab-drop': tab.type === dropTargetTab }"
          draggable="true"
          role="tab"
          :aria-selected="tab.type === activeTab"
          :data-view-later-tab="tab.type"
          @click="activeTab = tab.type"
          @dragstart="onTabDragStart(tab.type)"
          @dragover.prevent="onTabDragOver(tab.type)"
          @drop.prevent="onTabDrop(tab.type)"
          @dragend="draggedTab = null; dropTargetTab = null"
        >
          {{ tab.type }}
          <span class="recent-tab-count">{{ tab.entryCount }}</span>
        </button>
      </div>

      <div class="recent-tab-panel" data-testid="view-later-panel" role="tabpanel">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <p v-else-if="loading" class="muted">{{ t('import.preparing') }}</p>
        <p v-else-if="activeEntries.length === 0" class="muted">{{ t('viewLater.empty') }}</p>
        <PagedCardGrid
          v-else
          :items="activeEntries"
          grid-class="recent-grid recent-grid-compact"
          grid-testid="view-later-entry-grid"
          v-slot="{ items }"
        >
          <EntryCard
            v-for="entry in items"
            :key="entry.id"
            :api="api"
            :entry="entry"
            :note="cardNote(entry)"
            data-testid="view-later-entry-card"
            @open="openEntry(entry.id)"
          >
            <template #corner>
              <button
                type="button"
                class="view-later-remove"
                :data-testid="'view-later-remove-' + entry.id"
                :aria-label="t('entry.viewLaterRemove')"
                @click.stop="removeEntry(entry.id)"
              >×</button>
            </template>
          </EntryCard>
        </PagedCardGrid>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recent-page { display: grid; gap: 1rem; }
.view-later-remove { position: absolute; top: 0.3rem; right: 0.3rem; z-index: 2; width: 1.3rem; height: 1.3rem; border: 0; border-radius: 50%; background: rgb(0 0 0 / 55%); color: #fff; font: inherit; line-height: 1; cursor: pointer; }
.view-later-remove:hover { background: rgb(0 0 0 / 75%); }
.recent-toolbar { display: flex; align-items: center; gap: 1rem; }
.recent-toolbar h2 { margin: 0; flex: 1; }
.recent-mode-switch { display: inline-flex; gap: 0.3rem; }
/* Same sort-state-button look as the Author page (icon brief §4). */
.recent-mode-button { display: inline-grid; place-items: center; width: var(--icon-button-size); height: var(--icon-button-size); padding: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); color: var(--icon-muted); background: transparent; line-height: 1; cursor: pointer; transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease; }
.recent-mode-button:hover { color: var(--accent); background: var(--surface-hover); border-color: var(--border-strong); }
.recent-mode-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.recent-mode-active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.8rem; }
.entry-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 0.8rem; background: var(--surface-muted); }
.entry-card:hover, .entry-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.entry-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.entry-stack { position: relative; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; background: var(--surface-muted); perspective: 28rem; perspective-origin: 50% 50%; transform-style: preserve-3d; }
.entry-stack-image { position: absolute; display: block; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent); border-radius: 0.15rem; box-shadow: 0 0.18rem 0.45rem rgb(15 23 42 / 16%); transform-style: preserve-3d; }
.entry-stack-image:first-child { box-shadow: 0 0.28rem 0.7rem rgb(15 23 42 / 22%); }
.entry-placeholder { display: grid; width: 100%; height: 100%; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.entry-meta { display: grid; gap: 0.25rem; min-width: 0; padding: 0.75rem; }
.entry-meta strong { overflow-wrap: anywhere; }
.entry-usage-note { color: var(--text-muted); }

@media (max-width: 52rem) {
  .recent-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 30rem) {
  .recent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
