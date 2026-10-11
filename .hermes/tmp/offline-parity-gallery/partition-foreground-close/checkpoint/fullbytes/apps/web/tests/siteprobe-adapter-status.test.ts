// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SiteprobeSite } from '@t3/shared';

import {
  hostOf, siteForHost, siteProbeAdapterStatus,
} from '../src/siteprobe/adapter-status.js';

/**
 * "Does this site already have an adapter?" — the interface the rule-building page asks on every
 * address, and the one listing adaptation will ask with `kind: 'work'` (a listing adapter is only
 * useful once a work reader sits beside it).
 *
 * The sites here are the tool's own registry shape, so these tests pin what the page reads: which
 * host a site claims, which kinds its adapters read, and which layer declared them.
 */
function site(overrides: Partial<SiteprobeSite> = {}): SiteprobeSite {
  return {
    key: 'demo.test',
    display_name: 'Demo',
    export_group: 'demo_test',
    hosts: ['demo.test'],
    targets: [
      { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'local' },
    ],
    adapters: [{ source: 'local', reads: ['work'], readme: false }],
    ...overrides,
  };
}

describe('the host question', () => {
  it('reads the host out of an address the way the registry declares hosts', () => {
    expect(hostOf('https://www.demo.test/work/1')).toBe('demo.test');
    expect(hostOf('http://127.0.0.1:8811/work/1.html')).toBe('127.0.0.1');
    expect(hostOf('not an address')).toBeNull();
  });

  it('claims an address only for the site whose declared host it belongs to', () => {
    const sites = [site(), site({ key: 'other.test', hosts: ['other.test'] })];
    expect(siteForHost(sites, 'https://www.demo.test/work/1')?.key).toBe('demo.test');
    expect(siteForHost(sites, 'https://elsewhere.test/work/1')).toBeNull();
  });
});

describe('the adapter question', () => {
  it('answers with the site, its kinds and the layer that declared them', () => {
    const status = siteProbeAdapterStatus([site()], 'https://demo.test/work/42');

    expect(status.exists).toBe(true);
    expect(status.site?.key).toBe('demo.test');
    expect(status.kinds).toEqual(['work']);
    // `local` is a learned rule set — the file a build for the same host replaces.
    expect(status.sources).toEqual(['local']);
  });

  it('separates "an adapter exists" from "a work adapter exists"', () => {
    // A site whose learned set only reads searches: a listing adapter with no work reader, which is
    // exactly the state listing adaptation has to refuse to start from.
    const searchOnly = [site({
      targets: [{ kind: 'search', label: 'Search', single: false, accepts_name: true, source: 'local' }],
      adapters: [{ source: 'local', reads: ['search'], readme: false }],
    })];

    expect(siteProbeAdapterStatus(searchOnly, 'https://demo.test/search?q=x').exists).toBe(true);
    expect(siteProbeAdapterStatus(searchOnly, 'https://demo.test/search?q=x', 'work').exists).toBe(false);
    expect(siteProbeAdapterStatus(searchOnly, 'https://demo.test/search?q=x', 'work').sources)
      .toEqual([]);
  });

  it('answers "no" for an address no site claims, without pretending it is an error', () => {
    const status = siteProbeAdapterStatus([site()], 'https://unknown.test/work/1');

    expect(status.exists).toBe(false);
    expect(status.site).toBeNull();
    expect(status.kinds).toEqual([]);
  });

  it('keeps a written adapter apart from a learned one', () => {
    // One key, two files: the written adapter reads work pages and a learned set reads its
    // searches. A build replaces the learned file only, so the layer travels with the answer.
    const both = [site({
      targets: [
        { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'installed' },
        { kind: 'search', label: 'Search', single: false, accepts_name: true, source: 'local' },
      ],
      adapters: [
        { source: 'installed', reads: ['work'], readme: true },
        { source: 'local', reads: ['search'], readme: false },
      ],
    })];

    const work = siteProbeAdapterStatus(both, 'https://demo.test/work/1', 'work');
    expect(work.sources).toEqual(['installed']);
    const search = siteProbeAdapterStatus(both, 'https://demo.test/search?q=x', 'search');
    expect(search.sources).toEqual(['local']);
  });
});
