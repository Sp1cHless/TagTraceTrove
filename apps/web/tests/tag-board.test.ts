// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TagBoard from '../src/components/tags/TagBoard.vue';

describe('TagBoard', () => {
  it('emits reordered tags after a drag and drop', async () => {
    const wrapper = mount(TagBoard, {
      props: {
        modelValue: [
          { id: 'a', label: 'Romance' },
          { id: 'b', label: 'School Life' },
          { id: 'c', label: 'Full Color' },
        ],
      },
    });

    await wrapper.get('[data-tag-id="a"]').trigger('dragstart');
    await wrapper.get('[data-tag-id="c"]').trigger('drop');

    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual([
      { id: 'b', label: 'School Life' },
      { id: 'c', label: 'Full Color' },
      { id: 'a', label: 'Romance' },
    ]);
  });
});