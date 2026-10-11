// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PendingEntryMetadataEditor from '../src/components/PendingEntryMetadataEditor.vue';
import type { PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
function fixture(overrides: Partial<PendingOfflineEntryCreate> = {}) {
  const entry: PendingOfflineEntryCreate = { localKey: 'local:22222222-2222-4222-8222-222222222222', title: 'Draft',
    type: 'game', uploadDate: null, pageCount: null, status: 'pending', canEditMetadata: true, ...overrides };
  const saveMetadata = vi.fn().mockResolvedValue(undefined);
  const wrapper = mount(PendingEntryMetadataEditor, { props: { entry, saveMetadata } });
  return { wrapper, saveMetadata };
}
it('retains rejected basic-information values for an explicit retry', async () => {
  const { wrapper, saveMetadata } = fixture();
  saveMetadata.mockRejectedValueOnce(new Error('Outbox failed'));
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('New draft');
  await wrapper.get('[data-testid="pending-metadata-pages"]').setValue('7');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-metadata-error"]').text()).toContain('Outbox failed');
  expect(wrapper.get('[data-testid="pending-metadata-title"]').element).toHaveProperty('value', 'New draft');
  expect(wrapper.emitted('saved')).toBeUndefined();
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  expect(saveMetadata).toHaveBeenCalledTimes(2);
  expect(wrapper.emitted('saved')).toEqual([[{ title: 'New draft', uploadDate: null, pageCount: 7 }]]);
});
it('does not save unchanged fields or resubmit a committed write', async () => {
  const { wrapper, saveMetadata } = fixture();
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  expect(saveMetadata).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('New draft');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  expect(saveMetadata).toHaveBeenCalledTimes(1);
});
it.each(['-1', '1.5', 'not a number', '9007199254740992'])('rejects invalid page count %s', async count => {
  const { wrapper, saveMetadata } = fixture();
  await wrapper.get('[data-testid="pending-metadata-pages"]').setValue(count);
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  expect(saveMetadata).not.toHaveBeenCalled();
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
});
it('rejects a whitespace-only title', async () => {
  const { wrapper, saveMetadata } = fixture();
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('   ');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  expect(saveMetadata).not.toHaveBeenCalled();
});
it.each([{ status: 'conflict' as const }, { status: 'failed' as const }, { canEditMetadata: false }])('fails closed for %j', overrides => {
  const { wrapper, saveMetadata } = fixture(overrides);
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="pending-metadata-error"]').text()).toContain('unavailable');
  expect(saveMetadata).not.toHaveBeenCalled();
});
