/**
 * "Does this site already have an adapter?" — one answer, asked in the tool's own vocabulary.
 *
 * Two callers need it and they ask different versions of the same question: the rule-building page
 * asks it for the address a person just typed (an adapter that exists is the one a new build
 * replaces), and listing adaptation will ask it with `kind: 'work'` — a listing adapter is only
 * useful once a work reader sits beside it. Both read the tool's own registry (`integration sites`),
 * so nothing about any site is written here.
 *
 * The host comparison mirrors the rule the registry itself uses (`SiteTemplate.is_host`): hosts are
 * lower case and `www.` is not part of a site's identity.
 */
import type { SiteprobeSite } from '@t3/shared';

export interface SiteProbeAdapterStatus {
  /** The site this address belongs to, when its host is one a site declares. */
  site: SiteprobeSite | null;
  /**
   * True when that site declares the asked kind — or any kind at all, when none was asked.
   * A kind is what an adapter *reads*, so this is also the answer to "is there a work adapter".
   */
  exists: boolean;
  /** The kinds its adapters read, in the tool's names. */
  kinds: string[];
  /**
   * Which layers declare those kinds. `local` is a learned rule set — the file a build for the same
   * site replaces — while `installed`/`builtin` are written adapters a learned set does not replace.
   */
  sources: string[];
}

/** The host an address belongs to, as the registry declares hosts: no `www.`, lower case. */
export function hostOf(input: string): string | null {
  try {
    return new URL(input).hostname.replace(/^www\./u, '').toLocaleLowerCase();
  } catch {
    return null;
  }
}

/** The site whose declared hosts claim this address, if any. */
export function siteForHost(sites: readonly SiteprobeSite[], input: string): SiteprobeSite | null {
  const host = hostOf(input);
  if (!host) return null;
  return sites.find((candidate) => candidate.hosts
    .some((declared) => declared.replace(/^www\./u, '').toLocaleLowerCase() === host)) ?? null;
}

/** The full answer: which site claims the address, what it reads, and whether the asked kind is one. */
export function siteProbeAdapterStatus(
  sites: readonly SiteprobeSite[], input: string, kind?: string,
): SiteProbeAdapterStatus {
  const site = siteForHost(sites, input);
  if (!site) return { site: null, exists: false, kinds: [], sources: [] };
  const wanted = kind === undefined
    ? site.targets
    : site.targets.filter((target) => target.kind === kind);
  return {
    site,
    exists: wanted.length > 0,
    kinds: site.targets.map((target) => target.kind),
    sources: [...new Set(wanted.map((target) => target.source))],
  };
}
