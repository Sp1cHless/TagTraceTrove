<script setup lang="ts" generic="T extends { id: number }">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CardPagination from './CardPagination.vue';
import { rowsPerPage } from '../stores/preferences.js';
import { useNavigationMemory } from '../navigation-memory.js';

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
  pageKey?: string;
  /** When supplied with externalPage, items is already one server page. */
  totalItems?: number | undefined;
  externalPage?: number | undefined;
}>(), {
  gridClass: '',
  gridTestid: undefined,
  pageKey: '',
});

const emit = defineEmits<{
  'update:page': [page: number];
  'update:page-size': [pageSize: number];
}>();
const navigationMemory = useNavigationMemory();

const gridElement = ref<HTMLElement | null>(null);
const columns = ref(6);
const rowMultiplier = ref(1);
const layoutMeasured = ref(false);
let observer: ResizeObserver | undefined;

// auto-fill minmax(7.5rem, 1fr) + 0.8rem gap → columns from the real width.
const MIN_CARD_PX = 120;
const GAP_PX = 12.8;

function measure(): void {
  rowMultiplier.value = typeof window.matchMedia === 'function'
    ? (window.matchMedia('(max-width: 44rem)').matches ? 2 : 1)
    : (window.innerWidth <= 704 ? 2 : 1);
  const width = gridElement.value?.clientWidth ?? 0;
  if (width > 0) {
    columns.value = Math.max(1, Math.floor((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)));
  }
}

onMounted(() => {
  measure();
  layoutMeasured.value = true;
  window.addEventListener('resize', measure);
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(measure);
    if (gridElement.value) observer.observe(gridElement.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', measure);
});

const pageSize = computed(() => Math.max(
  1,
  columns.value * rowsPerPage.value * rowMultiplier.value,
));
const serverPaging = computed(() => props.totalItems !== undefined && props.externalPage !== undefined);
const serverPageSize = computed(() => Math.min(100, pageSize.value));
const pageCount = computed(() => Math.max(1, Math.ceil(
  (serverPaging.value ? props.totalItems! : props.items.length)
    / (serverPaging.value ? serverPageSize.value : pageSize.value),
)));
const page = ref(serverPaging.value
  ? props.externalPage!
  : (props.pageKey ? (navigationMemory.pages.get(props.pageKey) ?? 1) : 1));

watch(() => props.pageKey, (nextKey) => {
  if (!serverPaging.value) {
    page.value = nextKey ? (navigationMemory.pages.get(nextKey) ?? 1) : 1;
  }
});

watch(() => props.externalPage, (nextPage) => {
  if (serverPaging.value && nextPage !== undefined) page.value = nextPage;
});

watch([serverPaging, serverPageSize, layoutMeasured], ([isServerPaging, nextPageSize, measured]) => {
  // The 6-column setup value is only a SSR/jsdom-safe fallback. Emitting it
  // before the first real measurement makes a remounted phone page briefly
  // report the desktop page size and can clamp a remembered page 4/5 to 3.
  if (isServerPaging && measured) emit('update:page-size', nextPageSize);
}, { immediate: true });

watch([pageSize, () => serverPaging.value ? props.totalItems : props.items.length], () => {
  if (page.value > pageCount.value) {
    setPage(pageCount.value);
  }
});

const visibleItems = computed(() => {
  if (serverPaging.value) return props.items;
  const start = (page.value - 1) * pageSize.value;
  return props.items.slice(start, start + pageSize.value);
});

function setPage(next: number): void {
  const bounded = Math.min(Math.max(1, Math.floor(next)), pageCount.value);
  page.value = bounded;
  if (props.pageKey) navigationMemory.pages.set(props.pageKey, bounded);
  if (serverPaging.value) emit('update:page', bounded);
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
