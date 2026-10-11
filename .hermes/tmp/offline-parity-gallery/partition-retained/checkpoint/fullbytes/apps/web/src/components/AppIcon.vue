<script setup lang="ts">
import { computed } from 'vue';
import { iconMarkup, type IconName } from './icons.js';

/**
 * THE single SVG graphics outlet (icon brief §9). Always 24×24, stroked with
 * `currentColor` and hidden from assistive tech — the accessible name lives
 * on the parent button, never on the icon.
 */
const props = withDefaults(defineProps<{
  name: IconName;
  size?: 16 | 20 | 24;
}>(), {
  size: 20,
});

const markup = computed(() => iconMarkup[props.name]);
</script>

<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="markup"
  />
</template>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
