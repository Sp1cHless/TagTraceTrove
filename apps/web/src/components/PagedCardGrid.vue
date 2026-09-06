<script setup lang="ts" generic="T extends { id: number }">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CardPagination from './CardPagination.vue';
import { rowsPerPage } from '../stores/preferences.js';

/**
 * THE shared paged card grid: every view that can show a large number of
 * cards renders its cards through this component. Page size = rowsPerPage
 * preference × the grid's real column count (measured from the rendered
 * width, matching the auto-fill minmax(7.5rem, 1fr) layout below). The page
 * bar appears above AND below the cards; with a single page it disappears
 * entirely.
 */
const props = withDefaults(defineProps<{
  items: T[];
  /** Extra marker classes the pages/tests expect on the grid element. */
  gridClass?: string;
  gridTestid?: string | undefined;
}>(), {
  gridClass: '',
  gridTestid: undefined,
});

const gridElement = ref<HTMLElement | null>(null);
const columns = ref(6);
let observer: ResizeObserver | undefined;

// auto-fill minmax(7.5rem, 1fr) + 0.8rem gap → columns from the real width.
const MIN_CARD_PX = 120;
const GAP_PX = 12.8;

function measure(): void {
  const width = gridElement.value?.clientWidth ?? 0;
  if (width > 0) {
    columns.value = Math.max(1, Math.floor((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)));
  }
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(measure);
    if (gridElement.value) observer.observe(gridElement.value);
  }
});

onBeforeUnmount(() => observer?.disconnect());

const pageSize = computed(() => Math.max(1, columns.value * rowsPerPage.value));
const pageCount = computed(() => Math.max(1, Math.ceil(props.items.length / pageSize.value)));
const page = ref(1);

watch([pageSize, () => props.items.length], () => {
  if (page.value > pageCount.value) page.value = pageCount.value;
});

const visibleItems = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return props.items.slice(start, start + pageSize.value);
});

function setPage(next: number): void {
  page.value = Math.min(Math.max(1, Math.floor(next)), pageCount.value);
}
</script>

<template>
  <CardPagination
    v-if="pageCount > 1"
    :page="page"
    :page-count="pageCount"
    @update:page="setPage"
  />
  <div ref="gridElement" class="paged-grid" :class="gridClass" :data-testid="gridTestid">
    <slot :items="visibleItems" />
  </div>
  <CardPagination
    v-if="pageCount > 1"
    :page="page"
    :page-count="pageCount"
    @update:page="setPage"
  />
</template>

<style scoped>
.paged-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
  gap: 0.8rem;
}

@media (max-width: 52rem) {
  .paged-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 30rem) {
  .paged-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
