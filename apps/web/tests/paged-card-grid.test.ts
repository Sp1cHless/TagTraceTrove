// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import PagedCardGrid from '../src/components/PagedCardGrid.vue';

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
