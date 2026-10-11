import type { SourceSearchAdapter } from '../source-search-adapter.js';

/**
 * Deterministic QA adapter. It never touches the network (`networked: false`)
 * and only answers the fake origin `https://fake.test`, so the whole Advanced
 * wizard — job manager, review, commit — can be exercised on isolated
 * databases without any real target site.
 */

interface FakeWork {
  url: string;
  title: string;
  language?: string;
  creators?: string[];
  workKind?: string;
}

const FAKE_ORIGIN = 'https://fake.test';

const fakeCatalog: FakeWork[] = [
  {
    url: `${FAKE_ORIGIN}/work/100`,
    title: 'Blue Box',
    language: 'en',
    creators: ['MIURA Kouji'],
    workKind: 'series',
  },
  {
    url: `${FAKE_ORIGIN}/work/101`,
    title: 'Ao no Hako',
    language: 'ja',
    creators: ['MIURA Kouji'],
    workKind: 'oneshot',
  },
  {
    url: `${FAKE_ORIGIN}/work/102`,
    title: 'Blue Boxx',
    language: 'en',
    workKind: 'series',
  },
];

export const fakeAdapter: SourceSearchAdapter = {
  key: 'fake',
  displayName: 'QA fake target',
  networked: false,
  acceptsHomepage(url: URL): boolean {
    return url.origin === FAKE_ORIGIN;
  },
  canonicalizeHomepage(): URL {
    return new URL(FAKE_ORIGIN);
  },
  canonicalizeItemUrl(url: URL): string {
    const canonical = new URL(url.toString());
    canonical.hash = '';
    canonical.search = '';
    return canonical.toString().replace(/\/+$/u, '');
  },
  async search({ title, signal }) {
    signal.throwIfAborted();
    const normalizedTitle = title.trim().toLowerCase();
    const matches = fakeCatalog.filter((work) => (
      normalizedTitle === '' || work.title.toLowerCase().includes(normalizedTitle)
    ));
    return matches.map((work) => ({
      url: work.url,
      title: work.title,
      ...(work.language === undefined ? {} : { language: work.language }),
      ...(work.creators === undefined ? {} : { creators: work.creators }),
      ...(work.workKind === undefined ? {} : { workKind: work.workKind }),
      adapterEvidence: { adapter: 'fake', query: title },
    }));
  },
  rateLimit: { concurrency: 1, minDelayMs: 0 },
};
