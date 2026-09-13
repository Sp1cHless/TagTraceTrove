<script setup lang="ts">
import { computed } from 'vue';
import { entryCardMediaRef } from '../entry-media-stack.js';

type CoverCompositionVariant = 'author-card' | 'author-detail' | 'collection';

const props = defineProps<{
  variant: CoverCompositionVariant;
  coverRefs: readonly string[];
  alt: string;
  assetUrl: (ref: string) => string;
}>();

const visibleCoverRefs = computed(() => (
  [...new Set(props.coverRefs)].slice(0, props.variant === 'collection' ? 3 : 4)
));
const columnCount = computed(() => (
  props.variant === 'collection'
    ? Math.max(1, visibleCoverRefs.value.length)
    : visibleCoverRefs.value.length === 1 ? 1 : 2
));
const rowCount = computed(() => (
  props.variant === 'collection' || visibleCoverRefs.value.length <= 2 ? 1 : 2
));
const variantClasses = computed(() => {
  if (props.variant === 'author-detail') return ['author-artwork', 'author-cover-grid'];
  if (props.variant === 'collection') return ['directory-cover'];
  return ['author-list-cover'];
});
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columnCount.value}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${rowCount.value}, minmax(0, 1fr))`,
}));
</script>

<template>
  <span
    class="cover-composition"
    :class="variantClasses"
    :data-cover-count="visibleCoverRefs.length"
    :style="gridStyle"
    :aria-label="alt"
  >
    <img
      v-for="coverRef in visibleCoverRefs"
      :key="coverRef"
      :src="assetUrl(entryCardMediaRef(coverRef))"
      :alt="alt"
      :loading="variant === 'author-detail' ? 'eager' : 'lazy'"
      decoding="async"
    >
    <span
      v-if="visibleCoverRefs.length === 0 && variant === 'collection'"
      class="cover-composition-placeholder mini-placeholder"
      aria-hidden="true"
    />
  </span>
</template>

<style scoped>
.cover-composition {
  display: grid;
  gap: 0.15rem;
  overflow: hidden;
  background: var(--tag-background);
}
.cover-composition img {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  object-fit: cover;
}
.author-list-cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 0.5rem;
}
.author-cover-grid {
  width: 7rem;
  height: 7rem;
  padding: 0;
  border-radius: 0.8rem;
}
.author-cover-grid img { border-radius: 0.15rem; }
.directory-cover {
  width: 100%;
  height: 8rem;
  padding: 0.45rem;
  gap: 0.2rem;
  background: color-mix(in srgb, var(--tag-background) 65%, var(--surface));
}
.directory-cover img,
.cover-composition-placeholder {
  border-radius: 0.35rem;
}
.cover-composition-placeholder {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  place-items: center;
  color: var(--tag-text);
  background: var(--surface);
}
</style>
