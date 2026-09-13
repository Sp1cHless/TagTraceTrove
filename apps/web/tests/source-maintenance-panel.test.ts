// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import SourceMaintenancePanel from '../src/SourceMaintenancePanel.vue';
import type { GalleryApi } from '../src/api/gallery.js';

enableAutoUnmount(afterEach);

type SourceLibraryRecordDto = {
  sourceKey: string;
  sourceName: string;
  hosts: string[];
  entryCount: number;
  entryUrlCount: number;
  state: 'active' | 'invalid';
  statusNote: string | null;
};

function createSourceApi(): GalleryApi {
  let runStatus: string = 'draft';
  const runRecord = () => ({
    id: 1,
    originSourceKey: 'known:hitomi',
    adapterKey: 'fake',
    targetOrigin: 'https://fake.test',
    status: runStatus,
    markOriginInvalid: true,
    counts: {
      total: 2,
      processed: runStatus === 'review' ? 2 : 0,
      matched: runStatus === 'review' ? 1 : 0,
      ambiguous: 0,
      noMatch: runStatus === 'review' ? 1 : 0,
      errors: 0,
    },
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  });
  const items = [
    {
      entryId: 11,
      entryTitleSnapshot: 'Blue Box',
      originUrls: ['https://hitomi.la/g/1.html'],
      queryTitles: ['blue box'],
      candidates: [{
        url: 'https://fake.test/work/100',
        title: 'Blue Box',
        band: 'exact-safe',
        reasons: ['normalized title equals trusted alias'],
        adapterEvidence: {},
        catalogIds: ['fixture:blue-box'],
      }],
      decision: 'pending',
      selectedUrl: 'https://fake.test/work/100',
      errorText: null,
      updatedAt: '2026-09-13T00:00:00Z',
    },
    {
      entryId: 12,
      entryTitleSnapshot: 'Other Work',
      originUrls: ['https://hitomi.la/g/2.html'],
      queryTitles: ['other work'],
      candidates: [],
      decision: 'pending',
      selectedUrl: null,
      errorText: null,
      updatedAt: '2026-09-13T00:00:00Z',
    },
  ];
  return {
    async listSourceLibrary() {
      return [{
        sourceKey: 'known:hitomi',
        sourceName: 'Hitomi',
        hosts: ['hitomi.la'],
        entryCount: 2,
        entryUrlCount: 2,
        state: 'invalid',
        statusNote: null,
      }] satisfies SourceLibraryRecordDto[];
    },
    async probeSourceTarget() {
      return { ok: true, adapterKey: 'fake', displayName: 'QA fake target', origin: 'https://fake.test' };
    },
    async createSourceMaintenanceRun(input: Parameters<GalleryApi['createSourceMaintenanceRun']>[0]) {
      return {
        id: 1,
        originSourceKey: input.originSourceKey,
        adapterKey: input.adapterKey,
        targetOrigin: 'https://fake.test',
        status: 'draft',
        markOriginInvalid: input.markOriginInvalid,
        counts: { total: 0, processed: 0, matched: 0, ambiguous: 0, noMatch: 0, errors: 0 },
        createdAt: '2026-09-13T00:00:00Z',
        updatedAt: '2026-09-13T00:00:00Z',
      };
    },
    async getSourceMaintenanceRun() {
      return {
        id: 1,
        originSourceKey: 'known:hitomi',
        adapterKey: 'fake',
        targetOrigin: 'https://fake.test',
        status: runStatus as 'draft',
        markOriginInvalid: true,
        counts: {
          total: 2,
          processed: runStatus === 'review' ? 2 : 0,
          matched: runStatus === 'review' ? 1 : 0,
          ambiguous: 0,
          noMatch: runStatus === 'review' ? 1 : 0,
          errors: 0,
        },
        createdAt: '2026-09-13T00:00:00Z',
        updatedAt: '2026-09-13T00:00:00Z',
      };
    },
    async startSourceMaintenanceRun() {
      runStatus = 'review';
      return runRecord();
    },
    async pauseSourceMaintenanceRun() { return runRecord(); },
    async resumeSourceMaintenanceRun() { return runRecord(); },
    async cancelSourceMaintenanceRun() { return runRecord(); },
    async listSourceMaintenanceItems() {
      return { run: runRecord(), items, total: items.length };
    },
    async patchSourceMaintenanceItem(
      _runId: number,
      entryId: number,
      patch: { decision?: 'pending' | 'accept' | 'skip' | 'conflict' | 'error'; selectedUrl?: string | null },
    ) {
      const item = items.find((entry) => entry.entryId === entryId)!;
      if (patch.decision !== undefined) item.decision = patch.decision;
      if (patch.selectedUrl !== undefined) item.selectedUrl = patch.selectedUrl;
      return item;
    },
    async commitSourceMaintenanceRun() {
      return {
        runId: 1,
        status: 'committed',
        createdCount: 1,
        skippedCount: 0,
        unresolvedCount: 1,
        originMarkedInvalid: true,
        backupDir: 'C:/data/backups/backup-1',
      };
    },
  } as unknown as GalleryApi;
}

describe('SourceMaintenancePanel', () => {
  it('walks the fake-adapter wizard without any network: probe → start → review → commit', async () => {
    const api = createSourceApi();
    const wrapper = mount(SourceMaintenancePanel, { props: { api } });
    await flushPromises();

    // Step 1: the origin list shows the derived Source groups with badges.
    const origin = wrapper.get('[data-testid="source-maintenance"]');
    expect(origin.text()).toContain('Hitomi');
    expect(origin.text()).toContain('invalid');

    // Step 2: probe a supported homepage.
    await wrapper.get('[data-testid="sm-target-homepage"]').setValue('https://fake.test/');
    await wrapper.get('button.secondary-button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('QA fake target');

    // Step 1b: select the origin source.
    await wrapper.get('input[name="sm-origin-source"]').setValue(true);

    // Steps 3-4: start the job and land in review with a preselected exact-safe hit.
    await wrapper.get('[data-testid="sm-start"]').trigger('click');
    await flushPromises();
    const review = wrapper.get('[data-testid="sm-review"]');
    expect(review.text()).toContain('Blue Box');
    expect(review.text()).toContain('exact-safe');

    // Step 5: the commit button is gated on a review run and uses two-click arm.
    const commitButton = wrapper.get('.sm-commit button');
    expect(commitButton.attributes('disabled')).toBeUndefined();
    await commitButton.trigger('click');
    await flushPromises();
    expect((commitButton.element as HTMLButtonElement).classList.contains('armable-armed')).toBe(true);
    await commitButton.trigger('click');
    await flushPromises();
    expect(wrapper.get('.sm-notice').text()).toContain('1');
  });

  it('keeps the start button disabled without a probed supported target', async () => {
    const api = createSourceApi();
    const wrapper = mount(SourceMaintenancePanel, { props: { api } });
    await flushPromises();
    expect((wrapper.get('[data-testid="sm-start"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
