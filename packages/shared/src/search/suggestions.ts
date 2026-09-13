import { normalizeTag } from '../normalize/tag.js';
import type {
  RelationSuggestion,
  RelationSuggestionCandidate,
} from '../schemas/suggestions.js';

export type {
  RelationSuggestion,
  RelationSuggestionCandidate,
} from '../schemas/suggestions.js';

type RankedSuggestion = {
  suggestion: RelationSuggestion;
  matchRank: number;
  normalizedName: string;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function startsAtWordBoundary(candidate: string, query: string): boolean {
  let index = candidate.indexOf(query);
  while (index >= 0) {
    if (index === 0 || /[\s\p{P}\p{S}]/u.test(candidate[index - 1]!)) return true;
    index = candidate.indexOf(query, index + 1);
  }
  return false;
}

function canonicalMatchRank(candidate: string, query: string): number | null {
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (startsAtWordBoundary(candidate, query)) return 2;
  if (candidate.includes(query)) return 3;
  return null;
}

function aliasMatchRank(candidate: string, query: string): number | null {
  const canonicalRank = canonicalMatchRank(candidate, query);
  return canonicalRank === null ? null : canonicalRank + 4;
}

export function rankRelationSuggestions(
  candidates: readonly RelationSuggestionCandidate[],
  rawQuery: string,
  limit = 20,
): RelationSuggestion[] {
  const query = normalizeTag(rawQuery);
  if (query === '' || limit <= 0) return [];

  const ranked: RankedSuggestion[] = [];
  for (const candidate of candidates) {
    const normalizedName = normalizeTag(candidate.name);
    const canonicalRank = canonicalMatchRank(normalizedName, query);
    if (canonicalRank !== null) {
      ranked.push({
        suggestion: {
          id: candidate.id,
          name: candidate.name,
          sameContextUsageCount: candidate.sameContextUsageCount,
          totalUsageCount: candidate.totalUsageCount,
        },
        matchRank: canonicalRank,
        normalizedName,
      });
      continue;
    }

    const matchingAliases = (candidate.aliases ?? [])
      .map((alias) => ({ alias, normalizedAlias: normalizeTag(alias) }))
      .map((alias) => ({ ...alias, rank: aliasMatchRank(alias.normalizedAlias, query) }))
      .filter((alias): alias is typeof alias & { rank: number } => alias.rank !== null)
      .sort((left, right) => (
        left.rank - right.rank
        || compareText(left.normalizedAlias, right.normalizedAlias)
        || compareText(left.alias, right.alias)
      ));
    const matchedAlias = matchingAliases[0];
    if (!matchedAlias) continue;

    ranked.push({
      suggestion: {
        id: candidate.id,
        name: candidate.name,
        matchedAlias: matchedAlias.alias,
        sameContextUsageCount: candidate.sameContextUsageCount,
        totalUsageCount: candidate.totalUsageCount,
      },
      matchRank: matchedAlias.rank,
      normalizedName,
    });
  }

  ranked.sort((left, right) => (
      left.matchRank - right.matchRank
      || right.suggestion.sameContextUsageCount - left.suggestion.sameContextUsageCount
      || right.suggestion.totalUsageCount - left.suggestion.totalUsageCount
      || compareText(left.normalizedName, right.normalizedName)
      || left.suggestion.id - right.suggestion.id
    ));

  const suggestions: RelationSuggestion[] = [];
  const seenIds = new Set<number>();
  for (const item of ranked) {
    if (seenIds.has(item.suggestion.id)) continue;
    seenIds.add(item.suggestion.id);
    suggestions.push(item.suggestion);
    if (suggestions.length >= Math.min(20, Math.trunc(limit))) break;
  }
  return suggestions;
}
