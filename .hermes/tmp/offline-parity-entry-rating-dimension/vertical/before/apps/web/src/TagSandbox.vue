<script setup lang="ts">
import { computed, ref } from 'vue';
import TagBoard, { type TagItem } from './components/tags/TagBoard.vue';

type Theme = 'light' | 'dark';

const theme = ref<Theme>('light');
const tags = ref<TagItem[]>([
  { id: 'romance', label: 'Romance' },
  { id: 'school-life', label: 'School Life' },
  { id: 'full-color', label: 'Full Color' },
  { id: 'completed', label: 'Completed' },
  { id: 'favorite', label: 'Favorite' },
]);

const nextTheme = computed<Theme>(() => (theme.value === 'light' ? 'dark' : 'light'));

function toggleTheme(): void {
  theme.value = nextTheme.value;
}
</script>

<template>
  <div class="tag-sandbox" :data-theme="theme">
    <header class="sandbox-header">
      <div>
        <p class="eyebrow">T³ visual foundation</p>
        <h1>Tag interaction sandbox</h1>
      </div>
      <button
        class="theme-toggle"
        type="button"
        :aria-label="`Switch to ${nextTheme} theme`"
        @click="toggleTheme"
      >
        <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☀' }}</span>
        {{ nextTheme === 'dark' ? 'Dark' : 'Light' }}
      </button>
    </header>

    <main class="sandbox-main">
      <section class="sandbox-panel" aria-labelledby="tag-board-title">
        <div class="panel-heading">
          <div>
            <p class="section-label">Interactive component</p>
            <h2 id="tag-board-title">Rounded tag grid</h2>
          </div>
          <span class="memory-badge">Memory only</span>
        </div>

        <p class="panel-description">
          Drag tags to reorder them. Use × to remove a tag. Refreshing restores the fixture.
        </p>

        <TagBoard v-model="tags" />

        <p class="tag-count" aria-live="polite">{{ tags.length }} tags in this fixture</p>
      </section>

      <aside class="sandbox-panel notes-panel">
        <p class="section-label">Current boundary</p>
        <h2>Visual behavior only</h2>
        <ul>
          <li>Rounded rectangular tag cells</li>
          <li>Light and dark color tokens</li>
          <li>Native drag-and-drop ordering</li>
          <li>No API or database persistence</li>
        </ul>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.tag-sandbox {
  min-height: 100vh;
  padding: clamp(1rem, 4vw, 3.5rem);
  color: var(--text-primary);
  background: var(--page-background);
  transition:
    color 180ms ease,
    background-color 180ms ease;
}

.sandbox-header,
.sandbox-main {
  width: min(68rem, 100%);
  margin-inline: auto;
}

.sandbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.eyebrow,
.section-label {
  margin: 0 0 0.35rem;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  font-size: clamp(1.65rem, 4vw, 2.4rem);
  letter-spacing: -0.035em;
}

h2 {
  margin-bottom: 0;
  font-size: 1.15rem;
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.8rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.7rem;
  color: var(--text-primary);
  background: var(--surface);
  cursor: pointer;
}

.theme-toggle:hover,
.theme-toggle:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.sandbox-main {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(14rem, 1fr);
  gap: 1rem;
}

.sandbox-panel {
  padding: clamp(1rem, 3vw, 1.5rem);
  border: 1px solid var(--border-subtle);
  border-radius: 1rem;
  background: var(--surface);
  box-shadow: 0 0.5rem 1.5rem rgb(15 23 42 / 6%);
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.memory-badge {
  padding: 0.3rem 0.55rem;
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--surface-muted);
  font-size: 0.75rem;
  white-space: nowrap;
}

.panel-description,
.tag-count,
.notes-panel li {
  color: var(--text-muted);
  line-height: 1.6;
}

.panel-description {
  margin: 1rem 0;
}

.tag-count {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
}

.notes-panel ul {
  margin: 1rem 0 0;
  padding-left: 1.2rem;
}

.notes-panel li + li {
  margin-top: 0.35rem;
}

@media (max-width: 44rem) {
  .sandbox-header {
    align-items: flex-start;
  }

  .sandbox-main {
    grid-template-columns: 1fr;
  }
}
</style>