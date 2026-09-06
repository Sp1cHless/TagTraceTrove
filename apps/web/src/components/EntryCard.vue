<script setup lang="ts">
import { entryStackLayerStyle, entryStackLayers } from '../entry-media-stack.js';
import { useI18n } from '../i18n.js';

/**
 * THE shared work-card, used identically by the Gallery grid, Recently
 * viewed, View later and Collection member lists. Visual source of truth:
 * the Gallery grid card (stacked covers + title + type + optional note).
 */
export interface EntryCardEntry {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRefs: readonly string[];
}

const props = defineProps<{
  api: GalleryApiLike;
  entry: EntryCardEntry;
  /** Optional muted footnote under the meta (e.g. view count). */
  note?: string | null;
}>();

const emit = defineEmits<{ open: [] }>();

const { t } = useI18n();

interface GalleryApiLike {
  assetUrl(path: string): string;
}
</script>

<template>
  <article class="entry-card" data-testid="shared-entry-card">
    <button type="button" class="entry-card-main" :data-entry-id="entry.id" @click="emit('open')">
      <div class="entry-stack">
        <img
          v-for="(ref, index) in entryStackLayers(entry)"
          :key="ref"
          class="entry-stack-image"
          :src="props.api.assetUrl(ref)"
          :alt="entry.title"
          :style="entryStackLayerStyle(index, entryStackLayers(entry).length)"
        >
        <span v-if="entryStackLayers(entry).length === 0" class="entry-placeholder" aria-hidden="true">
          {{ entry.title.slice(0, 1).toUpperCase() }}
        </span>
      </div>
      <span class="entry-meta">
        <strong>{{ entry.title }}</strong>
        <small>{{ entry.type }}</small>
        <small v-if="note" class="entry-usage-note" data-testid="shared-card-note">{{ note }}</small>
      </span>
    </button>
    <slot name="corner" />
  </article>
</template>

<style scoped>
.entry-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-card); background: var(--surface-muted); }
.entry-card:hover, .entry-card:focus-within { border-color: var(--accent); transform: translateY(-1px); }
.entry-card-main { display: block; width: 100%; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.entry-card-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.entry-stack { position: relative; aspect-ratio: 4 / 3; overflow: hidden; isolation: isolate; background: var(--surface-muted); perspective: 28rem; perspective-origin: 50% 50%; transform-style: preserve-3d; }
.entry-stack-image { position: absolute; display: block; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent); border-radius: 0.15rem; box-shadow: 0 0.18rem 0.45rem rgb(15 23 42 / 16%); transform-style: preserve-3d; }
.entry-stack-image:first-child { box-shadow: 0 0.28rem 0.7rem rgb(15 23 42 / 22%); }
.entry-placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: var(--tag-text); background: var(--tag-background); font-size: 2rem; font-weight: 850; }
.entry-meta { display: grid; gap: 0.25rem; padding: 0.85rem; }
.entry-meta small { color: var(--text-muted); }
.entry-usage-note { color: var(--text-muted); }
</style>
