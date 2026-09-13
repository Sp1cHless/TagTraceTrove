// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import PagedCardGrid from '../src/components/PagedCardGrid.vue';
import { createNavigationMemory, navigationMemoryKey } from '../src/navigation-memory.js';

const LocalHarness = defineComponent({
  components: { PagedCardGrid },
  props: { items: { type: Array, required: true } },
  template: `
    <PagedCardGrid :items="items" page-key="batch:Comic:1" v-slot="{ items: visible }">
      <button v-for="item in visible" :key="item.id" class="visible-item">{{ item.id }}</button>
    </PagedCardGrid>
  `,
});

const Harness = defineComponent({
  components: { PagedCardGrid },
  template: `
    <PagedCardGrid
      :items="items"
      :total-items="1000"
      :external-page="2"
      @update:page="$emit('requested', $event)"
      @update:page-size="$emit('resized', $event)"
      v-slot="{ items: visible }"
    >
      <button v-for="item in visible" :key="item.id" class="visible-item">{{ item.id }}</button>
    </PagedCardGrid>
  `,
  emits: ['requested', 'resized'],
  setup() {
    return { items: [{ id: 31 }, { id: 32 }] };
  },
});

describe('PagedCardGrid server paging', () => {
  it('renders the supplied SQL page without slicing and requests another page', async () => {
    const wrapper = mount(Harness);
    await nextTick();

    expect(wrapper.findAll('.visible-item').map((item) => item.text())).toEqual(['31', '32']);
    expect(wrapper.get('[aria-current="page"]').text()).toBe('2');
    expect(wrapper.emitted('resized')).toEqual([[30]]);

    await wrapper.get('[aria-label="Next page"]').trigger('click');
    expect(wrapper.emitted('requested')).toEqual([[3]]);
  });
});

describe('PagedCardGrid local paging', () => {
  it('never slices past the end when a remembered page outlives its data', async () => {
    // The temporary batch review keeps one page key per Gallery run, so a page
    // remembered from a longer earlier batch is restored for a shorter one.
    const memory = createNavigationMemory();
    memory.pages.set('batch:Comic:1', 3);
    const wrapper = mount(LocalHarness, {
      props: { items: [{ id: 1 }, { id: 2 }] },
      global: { provide: { [navigationMemoryKey as symbol]: memory } },
    });
    await nextTick();

    // The cards are shown rather than a blank page, and no page bar appears
    // because the short list has a single page.
    expect(wrapper.findAll('.visible-item').map((item) => item.text())).toEqual(['1', '2']);
    expect(wrapper.find('[aria-current="page"]').exists()).toBe(false);
  });
});
