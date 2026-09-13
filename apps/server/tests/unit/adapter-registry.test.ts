import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../../src/source-maintenance/adapters/fake.js';
import {
  getSourceAdapter,
  listSourceAdapters,
  probeTargetHomepage,
  registerSourceAdapter,
} from '../../src/source-maintenance/adapter-registry.js';

describe('adapter registry', () => {
  it('registers the QA adapter exactly once and fails closed on unknown keys', () => {
    expect(listSourceAdapters().map((adapter) => adapter.key)).toContain('fake');
    expect(getSourceAdapter('fake')).toBe(fakeAdapter);
    expect(getSourceAdapter('unknown-site')).toBeNull();
    const duplicate = { ...fakeAdapter };
    expect(() => registerSourceAdapter(duplicate)).toThrow('already registered');
  });

  it('accepts the fake origin only through the QA adapter', () => {
    const probe = probeTargetHomepage('https://fake.test/some/path?q=1');
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.adapter.key).toBe('fake');
      expect(probe.homepage.toString()).toBe('https://fake.test/');
    }
  });

  it('fails closed for every unsafe or unsupported target shape', () => {
    const cases: Array<{ url: string; reason: string }> = [
      { url: 'http://fake.test/', reason: 'scheme' },
      { url: 'not a url', reason: 'unparsable' },
      { url: 'https://user:pass@fake.test/', reason: 'credentials' },
      { url: 'https://fake.test:8443/', reason: 'port' },
      { url: 'https://127.0.0.1:8443/', reason: 'private' },
      { url: 'https://169.254.169.254/', reason: 'private' },
      { url: 'https://metadata.google.internal/', reason: 'private' },
      { url: 'https://nas.local:443/', reason: 'private' },
      { url: 'https://localhost/', reason: 'private' },
      { url: 'https://example.com/', reason: 'unsupported' },
    ];
    for (const { url, reason } of cases) {
      const probe = probeTargetHomepage(url);
      expect(probe, url).toMatchObject({ ok: false, reason });
    }
    expect(probeTargetHomepage('https://example.com/')).toMatchObject({
      ok: false,
      detail: 'Unsupported target; adapter required',
    });
  });
});

describe('fake adapter', () => {
  it('searches deterministically and keeps adapter evidence', async () => {
    const hits = await fakeAdapter.search({
      title: 'Blue Box',
      signal: AbortSignal.timeout(1000),
    });
    const titles = hits.map((hit) => hit.title);
    expect(titles).toContain('Blue Box');
    expect(titles).not.toContain('Ao no Hako');
    for (const hit of hits) {
      expect(hit.url.startsWith('https://fake.test/work/')).toBe(true);
      expect(hit.adapterEvidence).toEqual({ adapter: 'fake', query: 'Blue Box' });
    }
  });

  it('canonicalizes item URLs by stripping query and fragment', () => {
    expect(fakeAdapter.canonicalizeItemUrl(new URL('https://fake.test/work/100?utm=x#top')))
      .toBe('https://fake.test/work/100');
  });

  it('returns every work for an empty query and nothing when aborted', async () => {
    const all = await fakeAdapter.search({ title: '', signal: AbortSignal.timeout(1000) });
    expect(all).toHaveLength(3);
    const controller = new AbortController();
    controller.abort();
    await expect(fakeAdapter.search({ title: 'Blue', signal: controller.signal }))
      .rejects.toThrow();
  });
});
