<script setup lang="ts">
import { computed } from 'vue';

/**
 * What a work's card shows in the cover slot when the work has no image of its own.
 *
 * The text is the work's own: its first Content, or, when it has none, its tags — the choice is
 * `pickDefaultCoverText` in `@t3/shared`, made by the server for an entry list and by the app for a
 * queued work. Only when the work carries nothing readable does the title's first letter come back,
 * which is what every cover-less card showed before.
 *
 * The outer element of a card's cover slot stays where it is, and this fills it: the slot's own
 * sizing (its absolute inset, its minimum height) belongs to the page that placed it.
 */
const props = defineProps<{
  title: string;
  /** The work's cover text, already cut to what a cover holds. */
  text?: string | null | undefined;
}>();

const letter = computed(() => props.title.slice(0, 1).toUpperCase());
const coverText = computed(() => (props.text ?? '').trim());
</script>

<template>
  <span class="cover-fallback">
    <span v-if="coverText" class="cover-fallback-text" data-testid="entry-cover-text">{{ coverText }}</span>
    <span v-else class="cover-fallback-letter">{{ letter }}</span>
  </span>
</template>

<style scoped>
.cover-fallback { display: grid; width: 100%; height: 100%; place-items: center; }
.cover-fallback-letter { font-size: 2rem; font-weight: 850; }
.cover-fallback-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  /* Four lines is what the smallest cover the grid lays out holds whole (a 7.5rem card is 90px
     tall, and four 18px lines plus this padding is 87px), so a full cover's worth of text is never
     cut through a line by the box; a narrower card than that does not exist. */
  -webkit-line-clamp: 4;
  overflow: hidden;
  width: 100%;
  max-width: 100%;
  padding: 0.45rem;
  overflow-wrap: anywhere;
  text-align: center;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.45;
}
</style>
