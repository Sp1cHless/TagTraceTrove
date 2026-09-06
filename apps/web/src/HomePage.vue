<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { GalleryApi, GalleryEntrySummary } from './api/gallery.js';
import type { GallerySummary } from '@t3/shared';
import EntryCard from './components/EntryCard.vue';
import { showNsfw } from './stores/preferences.js';
import { useI18n } from './i18n.js';

/**
 * Home: the welcome page and the default view of the app (T³ homepage design
 * guide). A light "welcome + continue" entry — hero first, one ambient fact
 * at a time, a handful of recently viewed entries and three gallery doors.
 * All data comes from the existing gallery/entry APIs; no new endpoints.
 */
const props = defineProps<{ api: GalleryApi }>();

const emit = defineEmits<{
  'open-entry': [entryId: number];
  'open-gallery': [galleryType: string];
  'create-entry': [];
  'create-author': [];
}>();

const { locale, t } = useI18n();

const loading = ref(true);
const loadFailed = ref(false);
const totalCount = ref(0);
const galleries = ref<GallerySummary[]>([]);
const recentEntries = ref<GalleryEntrySummary[]>([]);
const recentError = ref(false);

onMounted(load);
async function load(): Promise<void> {
  try {
    const galleryList = await props.api.listGalleries();
    totalCount.value = galleryList.reduce((sum, gallery) => sum + gallery.entryCount, 0);
    galleries.value = galleryList.filter((gallery) => showNsfw.value || !gallery.nsfw);
    // Same aggregation path as the Recently viewed page: per-gallery entry
    // lists already carry lastViewedAt, so Home adds no second history store.
    const results = await Promise.allSettled(
      galleries.value.map((gallery) => props.api.listEntries(gallery.type)),
    );
    const nsfwTypes = new Set(galleryList.filter((gallery) => gallery.nsfw).map((gallery) => gallery.type));
    const entries = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    recentEntries.value = entries
      .filter((entry) => entry.lastViewedAt !== null && (showNsfw.value || !nsfwTypes.has(entry.type)))
      .sort((left, right) => String(right.lastViewedAt).localeCompare(String(left.lastViewedAt)))
      .slice(0, 4);
    // Partial failures degrade silently; only an empty result set is an error.
    recentError.value = galleries.value.length > 0
      && results.every((result) => result.status === 'rejected');
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

const isEmptyHome = computed(() => !loading.value && !loadFailed.value && totalCount.value === 0);
const galleryPreview = computed(() => galleries.value.slice(0, 3));

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return t('greeting.morning');
  if (hour >= 12 && hour < 18) return t('greeting.afternoon');
  return t('greeting.evening');
});

function galleryCountText(count: number): string {
  return t(count === 1 ? 'gallery.entryCountOne' : 'gallery.entryCount', { count });
}

// Relative time via Intl (guide §19): 刚刚 / 12 分钟前 / 昨天 / 3 天前,
// localized through the active locale.
const relativeFormatter = computed(() => new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }));

function relativeTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return '';
  const time = new Date(isoTimestamp).getTime();
  if (Number.isNaN(time)) return isoTimestamp.slice(0, 10);
  const diffMinutes = Math.round((time - Date.now()) / 60000);
  if (Math.abs(diffMinutes) < 1) return t('home.time.justNow');
  if (Math.abs(diffMinutes) < 60) return relativeFormatter.value.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return relativeFormatter.value.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 7) return relativeFormatter.value.format(diffDays, 'day');
  return isoTimestamp.slice(0, 10);
}

// Ambient summary: one fact at a time (guide §4-6). Rotates every 5.2s,
// pausing on hover, focus, hidden tab and reduced-motion.
const ambientIndex = ref(0);
let ambientTimer: number | undefined;
let ambientHovered = false;

const ambientItems = computed(() => {
  const items = [
    { id: 'entries', title: t('home.ambient.entries', { count: totalCount.value }), detail: t('home.ambient.entriesDetail') },
    { id: 'galleries', title: t('home.ambient.galleries', { count: galleries.value.length }), detail: t('home.ambient.galleriesDetail') },
  ];
  const latest = recentEntries.value[0];
  if (latest && latest.lastViewedAt) {
    items.push({
      id: 'recent',
      title: t('home.ambient.recent', { title: latest.title }),
      detail: relativeTime(latest.lastViewedAt),
    });
  }
  return items;
});

const ambientItem = computed(() => {
  const items = ambientItems.value;
  return items[Math.min(ambientIndex.value, items.length - 1)] ?? items[0]!;
});

function stopAmbientRotation(): void {
  if (ambientTimer !== undefined) {
    window.clearInterval(ambientTimer);
    ambientTimer = undefined;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function startAmbientRotation(): void {
  stopAmbientRotation();
  if (ambientHovered || document.hidden) return;
  if (ambientItems.value.length <= 1) return;
  if (prefersReducedMotion()) return;
  ambientTimer = window.setInterval(() => {
    ambientIndex.value = (ambientIndex.value + 1) % ambientItems.value.length;
  }, 5200);
}

function showAmbientItem(index: number): void {
  ambientIndex.value = index;
  startAmbientRotation();
}

function pauseAmbient(): void {
  ambientHovered = true;
  stopAmbientRotation();
}

function resumeAmbient(): void {
  ambientHovered = false;
  startAmbientRotation();
}

function onVisibilityChange(): void {
  if (document.hidden) stopAmbientRotation();
  else startAmbientRotation();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  startAmbientRotation();
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopAmbientRotation();
});
</script>

<template>
  <section data-testid="home-page" class="home-page">
    <template v-if="!isEmptyHome">
      <div class="home-hero">
        <div class="home-hero-copy">
          <p class="eyebrow">{{ greeting }} · {{ t('home.eyebrow') }}</p>
          <h2 class="home-title">{{ t('home.title') }}</h2>
          <p class="home-subtitle">{{ t('home.subtitle') }}</p>
          <div class="home-hero-actions">
            <button
              data-testid="home-add-entry"
              class="primary-button"
              type="button"
              @click="emit('create-entry')"
            >
              {{ t('home.cta.newEntry') }}
            </button>
          </div>
        </div>
        <aside
          class="home-ambient"
          data-testid="home-ambient"
          role="group"
          :aria-label="t('home.ambient.label')"
          @mouseenter="pauseAmbient"
          @mouseleave="resumeAmbient"
          @focusin="stopAmbientRotation()"
          @focusout="startAmbientRotation()"
        >
          <p class="home-ambient-label">{{ t('home.ambient.label') }}</p>
          <div class="home-ambient-value-wrap">
            <div v-if="loading" class="home-ambient-skeleton" aria-hidden="true" />
            <Transition v-else name="home-ambient" mode="out-in">
              <div :key="ambientItem.id" class="home-ambient-message" data-testid="home-ambient-message">
                <strong>{{ ambientItem.title }}</strong>
                <span>{{ ambientItem.detail }}</span>
              </div>
            </Transition>
          </div>
          <div class="home-ambient-dots">
            <button
              v-for="(item, index) in ambientItems"
              :key="item.id"
              type="button"
              class="home-ambient-dot"
              :class="{ 'home-ambient-dot-active': index === ambientIndex }"
              :aria-label="`${index + 1} / ${ambientItems.length}`"
              @click="showAmbientItem(index)"
            />
          </div>
        </aside>
      </div>

      <section class="home-section" data-testid="home-recent">
        <div class="home-section-head">
          <h3>{{ t('home.recent.title') }}</h3>
          <span>{{ t('home.recent.note') }}</span>
        </div>
        <p v-if="recentError" class="muted" data-testid="home-recent-error">
          {{ t('home.recent.error') }}
        </p>
        <div v-else-if="loading" class="home-recent-grid">
          <div v-for="slot in 4" :key="slot" class="home-skeleton-card" aria-hidden="true" />
        </div>
        <p v-else-if="recentEntries.length === 0" class="muted">
          {{ t('home.recent.empty') }}
        </p>
        <div v-else class="home-recent-grid">
          <EntryCard
            v-for="entry in recentEntries"
            :key="entry.id"
            :api="api"
            :entry="entry"
            :note="relativeTime(entry.lastViewedAt)"
            data-testid="home-recent-card"
            @open="emit('open-entry', entry.id)"
          />
        </div>
      </section>

      <section class="home-section" data-testid="home-galleries">
        <div class="home-section-head">
          <h3>{{ t('home.galleries.title') }}</h3>
          <span>{{ t('home.galleries.note') }}</span>
        </div>
        <div class="home-gallery-grid">
          <button
            v-for="(gallery, index) in galleryPreview"
            :key="gallery.type"
            type="button"
            class="home-gallery-card"
            :data-home-gallery="gallery.type"
            @click="emit('open-gallery', gallery.type)"
          >
            <span class="home-gallery-mark" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="home-gallery-text">
              <strong>{{ gallery.type }}</strong>
              <small>{{ galleryCountText(gallery.entryCount) }}</small>
            </span>
          </button>
        </div>
      </section>
    </template>

    <div v-else class="home-empty" data-testid="home-empty">
      <span class="home-empty-symbol" aria-hidden="true">+</span>
      <p class="eyebrow">{{ t('home.empty.eyebrow') }}</p>
      <h2>{{ t('home.empty.title') }}</h2>
      <p>{{ t('home.empty.body') }}</p>
      <div class="home-hero-actions home-empty-actions">
        <button
          data-testid="home-add-first-entry"
          class="primary-button"
          type="button"
          @click="emit('create-entry')"
        >
          {{ t('home.empty.primary') }}
        </button>
        <button class="secondary-button" type="button" @click="emit('create-author')">
          {{ t('author.new') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-page { display: grid; }

.home-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(240px, 0.7fr);
  gap: var(--space-8);
  align-items: center;
  padding-bottom: var(--space-8);
  border-bottom: 1px solid var(--border-subtle);
}

.home-title {
  margin: var(--space-3) 0 0;
  font-size: clamp(2.1rem, 3.4vw, 2.75rem);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.home-subtitle { max-width: 32rem; margin: var(--space-3) 0 0; color: var(--text-muted); font-size: var(--font-size-secondary); line-height: 1.6; }
.home-hero-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }

.home-ambient {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 10.75rem;
  padding: var(--space-6);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface-muted);
}

.home-ambient-label { margin: 0; color: var(--text-muted); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.home-ambient-value-wrap { display: flex; min-height: 4rem; align-items: center; }
.home-ambient-message strong { display: block; font-size: 1.15rem; font-weight: 700; line-height: 1.3; letter-spacing: -0.01em; }
.home-ambient-message span { display: block; margin-top: var(--space-2); color: var(--text-muted); font-size: 0.8rem; line-height: 1.45; }
.home-ambient-skeleton { width: 100%; height: 3rem; border-radius: var(--radius-control); background: var(--surface-hover); }

.home-ambient-dots { display: flex; gap: var(--space-1); }
.home-ambient-dot { width: 1.4rem; height: 0.25rem; padding: 0; border: 0; border-radius: 999px; background: var(--border-subtle); cursor: pointer; transition: background-color var(--transition-duration) ease; }
.home-ambient-dot:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.home-ambient-dot-active { background: var(--accent); }

.home-ambient-enter-active,
.home-ambient-leave-active { transition: opacity 300ms ease, transform 300ms ease; }
.home-ambient-enter-from { opacity: 0; transform: translateY(6px); }
.home-ambient-leave-to { opacity: 0; transform: translateY(-4px); }

.home-section { padding-top: var(--space-8); }
.home-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-6); margin-bottom: var(--space-4); }
.home-section-head h3 { margin: 0; font-size: 1.05rem; font-weight: 700; }
.home-section-head > span { color: var(--text-muted); font-size: 0.8rem; }

/* Compact cards: Home shows doors back into the collection, not full cards. */
.home-recent-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-4); }
.home-recent-grid :deep(.entry-meta) { gap: 0.15rem; padding: 0.6rem 0.7rem; }
.home-recent-grid :deep(.entry-meta strong) { font-size: 0.85rem; }
.home-recent-grid :deep(.entry-meta small) { font-size: 0.72rem; }
.home-skeleton-card { height: 10rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface-muted); }

.home-gallery-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); }
.home-gallery-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  color: var(--text-primary);
  background: var(--surface-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--transition-duration) ease, background-color var(--transition-duration) ease, border-color var(--transition-duration) ease, transform var(--transition-duration) ease;
}
.home-gallery-card:hover, .home-gallery-card:focus-visible { border-color: var(--accent); transform: translateY(-2px); }
.home-gallery-card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.home-gallery-mark { display: grid; width: 2.4rem; height: 2.4rem; flex-shrink: 0; place-items: center; border-radius: var(--radius-control); color: var(--accent); background: var(--accent-soft); font-size: 0.85rem; font-weight: 800; }
.home-gallery-text { display: grid; gap: 0.1rem; min-width: 0; }
.home-gallery-text strong { overflow-wrap: anywhere; font-size: 0.95rem; }
.home-gallery-text small { color: var(--text-muted); font-size: 0.78rem; }

.home-empty { max-width: 36rem; margin: 6rem auto; text-align: center; }
.home-empty-symbol { display: grid; width: 4.5rem; height: 4.5rem; margin: 0 auto var(--space-4); place-items: center; border-radius: var(--radius-card); color: var(--accent); background: var(--accent-soft); font-size: 2rem; font-weight: 700; }
.home-empty h2 { font-size: var(--font-size-page-title); font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
.home-empty p { color: var(--text-muted); line-height: 1.5; }
.home-empty-actions { justify-content: center; }

@media (max-width: 64rem) {
  .home-hero { grid-template-columns: 1fr; }
  .home-recent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .home-gallery-grid { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .home-ambient-enter-active,
  .home-ambient-leave-active { transition: none; }
  .home-gallery-card:hover { transform: none; }
}
</style>
