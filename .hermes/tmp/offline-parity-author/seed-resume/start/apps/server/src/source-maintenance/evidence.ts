import { normalizeTag } from '@t3/shared';
import type { SourceEvidenceBand } from '@t3/shared';

/**
 * Evidence layering for Source maintenance candidates (plan §13.3). The
 * engine is deliberately conservative: every band carries machine-readable
 * reasons, only full-string equality against a trusted title/alias or a
 * shared catalog identity can produce a selectable candidate, and similarity
 * alone never promotes anything.
 */

export interface TrustedTitle {
  value: string;
  kind: 'title' | 'alias' | 'romaji';
}

export interface RawCandidate {
  url: string;
  title: string;
  language?: string;
  creators?: string[];
  workKind?: string;
  /** External catalog IDs (Bangumi/MangaDex/Wikidata/…) resolved for this target. */
  catalogIds?: string[];
  thumbnailUrl?: string;
  adapterEvidence?: Record<string, unknown>;
}

export interface EvidenceContext {
  trustedTitles: TrustedTitle[];
  /** Catalog IDs already associated with the Entry's known works. */
  entryCatalogIds?: string[];
  /**
   * External IDs derived from the Entry's own origin URLs — e.g. the numeric
   * gallery id embedded in a hitomi.la slug equals the e-hentai gallery id.
   * A candidate carrying the same provider id is the same work (strong
   * review: the human confirms with one click, the engine never auto-writes).
   */
  originExternalIds?: string[];
  entryCreators?: string[];
  entryWorkKind?: string;
  entryLanguage?: string;
  /** Full-library URL ownership: true means another Entry already uses the URL. */
  isUrlOwnedByOtherEntry: (url: string) => boolean;
}

export interface BandedCandidate {
  url: string;
  title: string;
  language?: string;
  creators?: string[];
  workKind?: string;
  catalogIds?: string[];
  thumbnailUrl?: string;
  adapterEvidence?: Record<string, unknown>;
  band: SourceEvidenceBand;
  reasons: string[];
}

const BAND_ORDER: SourceEvidenceBand[] = ['exact-safe', 'strong-review', 'ambiguous', 'conflict'];

interface Signals {
  matchedKind: TrustedTitle['kind'] | null;
  titleIsUnique: boolean;
  catalogMatch: boolean;
  originIdMatch: boolean;
  creatorSupport: boolean;
  creatorConflict: boolean;
  workKindConflict: boolean;
  workKindMissing: boolean;
  languageSupport: boolean;
  urlOwnedByOtherEntry: boolean;
}

function bandFromSignals(signals: Signals): { band: SourceEvidenceBand; reasons: string[] } {
  const reasons: string[] = [];
  if (signals.urlOwnedByOtherEntry) reasons.push('target URL already belongs to another Entry');
  if (signals.creatorConflict) reasons.push('creator lists are both present but disjoint');
  if (signals.workKindConflict) reasons.push('work kind differs (e.g. oneshot vs series / adaptation)');
  if (signals.urlOwnedByOtherEntry || signals.creatorConflict || signals.workKindConflict) {
    return { band: 'conflict', reasons };
  }

  // Exact canonical/alias title match: the only route to exact-safe.
  if (signals.matchedKind === 'title' || signals.matchedKind === 'alias') {
    reasons.push(`normalized title equals trusted ${signals.matchedKind}`);
    if (!signals.titleIsUnique) {
      reasons.push('multiple target candidates share this exact title');
      return { band: 'ambiguous', reasons };
    }
    if (signals.workKindMissing && signals.matchedKind === 'alias') {
      // A translated alias alone cannot separate oneshot / series / adaptation.
      reasons.push('translation alias match cannot separate oneshot, series or adaptation without work-kind evidence');
      return { band: 'ambiguous', reasons };
    }
    if (signals.workKindMissing) {
      reasons.push('work-kind information is missing for this candidate');
      return { band: 'strong-review', reasons };
    }
    reasons.push('candidate URL is free and the match is unique');
    return { band: 'exact-safe', reasons };
  }

  if (signals.matchedKind === 'romaji') {
    reasons.push('exact Romaji title match');
    if (signals.creatorSupport) {
      reasons.push('creator lists intersect');
      return { band: 'strong-review', reasons };
    }
    reasons.push('no creator evidence to support the Romaji match');
    return { band: 'ambiguous', reasons };
  }

  if (signals.originIdMatch) {
    reasons.push('external id equals the id embedded in the origin source URL');
    return { band: 'strong-review', reasons };
  }

  if (signals.catalogMatch) {
    reasons.push('resolved to the same external catalog identity');
    if (signals.creatorSupport) reasons.push('creator lists intersect');
    if (!signals.creatorSupport) reasons.push('catalog identity match without supporting creator evidence');
    return { band: 'strong-review', reasons };
  }

  reasons.push('no trusted identity evidence (similarity alone is never eligible)');
  return { band: 'ambiguous', reasons };
}

export function bandCandidates(raw: RawCandidate[], context: EvidenceContext): BandedCandidate[] {
  const trusted = context.trustedTitles.map((entry) => ({
    kind: entry.kind,
    normalized: normalizeTag(entry.value),
  }));
  const entryCatalogIds = new Set(context.entryCatalogIds ?? []);
  const originExternalIds = new Set(context.originExternalIds ?? []);
  const entryCreators = new Set((context.entryCreators ?? []).map((creator) => normalizeTag(creator)));

  const normalizedTitles = raw.map((candidate) => normalizeTag(candidate.title));

  const banded = raw.map((candidate, index) => {
    const normalizedTitle = normalizedTitles[index]!;
    const matched = trusted.find((entry) => entry.normalized === normalizedTitle) ?? null;
    const signals: Signals = {
      matchedKind: matched?.kind ?? null,
      titleIsUnique: normalizedTitles.filter((title) => title === normalizedTitle).length === 1,
      catalogMatch: (candidate.catalogIds ?? []).some((id) => entryCatalogIds.has(id)),
      originIdMatch: (candidate.catalogIds ?? []).some((id) => originExternalIds.has(id)),
      creatorSupport: (candidate.creators ?? []).some((creator) => entryCreators.has(normalizeTag(creator))),
      creatorConflict: (candidate.creators ?? []).length > 0
        && entryCreators.size > 0
        && !(candidate.creators ?? []).some((creator) => entryCreators.has(normalizeTag(creator))),
      workKindConflict: context.entryWorkKind !== undefined
        && candidate.workKind !== undefined
        && normalizeTag(context.entryWorkKind) !== normalizeTag(candidate.workKind),
      workKindMissing: candidate.workKind === undefined,
      languageSupport: context.entryLanguage !== undefined
        && candidate.language !== undefined
        && normalizeTag(context.entryLanguage) === normalizeTag(candidate.language),
      urlOwnedByOtherEntry: context.isUrlOwnedByOtherEntry(candidate.url),
    };

    const { band, reasons } = bandFromSignals(signals);
    return {
      url: candidate.url,
      title: candidate.title,
      ...(candidate.language === undefined ? {} : { language: candidate.language }),
      ...(candidate.creators === undefined ? {} : { creators: candidate.creators }),
      ...(candidate.workKind === undefined ? {} : { workKind: candidate.workKind }),
      ...(candidate.catalogIds === undefined ? {} : { catalogIds: candidate.catalogIds }),
      ...(candidate.thumbnailUrl === undefined ? {} : { thumbnailUrl: candidate.thumbnailUrl }),
      ...(candidate.adapterEvidence === undefined ? {} : { adapterEvidence: candidate.adapterEvidence }),
      band,
      reasons,
    };
  });

  return banded.sort((left, right) => (
    BAND_ORDER.indexOf(left.band) - BAND_ORDER.indexOf(right.band)
    || left.url.localeCompare(right.url)
  ));
}

/** Default-selection rule: only exact-safe candidates may be pre-checked. */
export function isDefaultSelectable(candidate: BandedCandidate): boolean {
  return candidate.band === 'exact-safe';
}
