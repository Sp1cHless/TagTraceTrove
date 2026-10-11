<script setup lang="ts">
import { ref } from 'vue';
import type { CreateProducerRequest } from '@t3/shared';
import { useI18n } from './i18n.js';

const props = defineProps<{ submitting: boolean }>();
const emit = defineEmits<{ back: []; submit: [draft: CreateProducerRequest] }>();
const { t } = useI18n();
const name = ref('');
const occupation = ref('');
const artworkRef = ref('');
const content = ref('');

function submit(): void {
  emit('submit', {
    name: name.value.trim(),
    occupation: occupation.value.trim() || null,
    artworkRef: artworkRef.value.trim() || null,
    content: content.value.trim() || null,
  });
}
</script>

<template>
  <section data-testid="add-author-page" class="add-author-page">
    <header class="add-page-toolbar">
      <button class="back-button" type="button" @click="emit('back')">
        {{ t('entry.back', { type: t('author.navigation') }) }}
      </button>
      <h2>{{ t('author.newPage') }}</h2>
    </header>
    <form class="author-card-editor" @submit.prevent="submit">
      <div class="author-artwork-placeholder" aria-hidden="true">+</div>
      <div class="author-fields">
        <label>{{ t('author.name') }}<input v-model="name" name="name" required autocomplete="off"></label>
        <label>{{ t('author.occupation') }}<input v-model="occupation" name="occupation" autocomplete="off"></label>
        <label>{{ t('author.artwork') }}<input v-model="artworkRef" name="artworkRef" autocomplete="off"></label>
        <label>{{ t('author.content') }}<textarea v-model="content" name="content" rows="5" /></label>
        <button class="primary-button" type="submit" :disabled="props.submitting">
          {{ props.submitting ? t('author.creating') : t('author.create') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.add-author-page { display: grid; gap: 1.5rem; }
.add-page-toolbar { display: flex; align-items: center; gap: 1rem; }
.add-page-toolbar h2 { margin: 0; }
.author-card-editor { display: grid; grid-template-columns: minmax(180px, .6fr) minmax(280px, 1fr); gap: 1.5rem; padding: 1.25rem; border: 1px solid var(--border-subtle); border-radius: 20px; background: var(--surface); }
.author-artwork-placeholder { min-height: 280px; display: grid; place-items: center; border: 1px dashed var(--border-subtle); border-radius: 16px; background: var(--surface-muted); color: var(--text-muted); font-size: 2.6rem; }
.author-fields { display: grid; align-content: start; gap: 1rem; }
.author-fields label { display: grid; gap: .4rem; }
.author-fields textarea { font: inherit; resize: vertical; }
/* The single-column form, and why the breakpoint is this wide.
 *
 * The two-column form needs 584px (a 240px media column, a 280px fields column, their gap and the
 * card's padding), and the shell keeps its 288px sidebar until 44rem — so a two-column form needs a
 * **936px** viewport before it has room. Measured on a real window: at 768, 844 and 920 the page laid
 * out 936px wide in the viewport and the document scrolled sideways (34 elements past the edge, the
 * field inputs at 852). This page's own breakpoint used to be 760px, which is the width *the form*
 * wants in a world without the sidebar — hence the 761-936px window where the page was neither.
 * Phones are unaffected: measured at 320, 360, 390 and 430 with no overflow either way. */
@media (max-width: 60rem) {
  .add-page-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .add-page-toolbar h2 { flex-basis: 100%; }
  .author-card-editor { grid-template-columns: 1fr; padding: 0.8rem; gap: 1rem; }
  .author-artwork-placeholder { min-height: 9rem; }
  .author-fields input,
  .author-fields textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; }
  .author-fields textarea { min-height: 7rem; }
  .author-fields .primary-button { width: 100%; min-height: 44px; }
}
</style>
