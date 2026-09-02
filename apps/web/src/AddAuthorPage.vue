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
@media (max-width: 760px) { .author-card-editor { grid-template-columns: 1fr; } }
</style>
