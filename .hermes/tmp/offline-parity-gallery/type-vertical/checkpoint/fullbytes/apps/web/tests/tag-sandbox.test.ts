// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TagSandbox from '../src/TagSandbox.vue';

describe('TagSandbox', () => {
  it('switches between light and dark visual themes', async () => {
    const wrapper = mount(TagSandbox);

    expect(wrapper.get('.tag-sandbox').attributes('data-theme')).toBe('light');

    await wrapper.get('[aria-label="Switch to dark theme"]').trigger('click');

    expect(wrapper.get('.tag-sandbox').attributes('data-theme')).toBe('dark');
    expect(wrapper.get('[aria-label="Switch to light theme"]').text()).toContain('Light');
  });
});