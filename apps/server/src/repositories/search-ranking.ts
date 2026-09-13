/** Lightweight in-memory relevance ranking for the small local library.
 *
 * Exact/substring matches rank first. Queries of four or more characters also
 * tolerate a small edit distance against individual words, which catches the
 * common one-character typo without adding a search engine dependency.
 *
 * `alternateTextsOf` adds extra spellings a match may come from (an author's
 * recorded aliases, for example) without changing which text the ties are
 * ordered by: the item is still listed under its own display text.
 */
export function rankSearchResults<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  alternateTextsOf?: (item: T) => readonly string[],
): T[] {
  const needle = normalizeSearchText(query);
  if (needle === '') return [];

  const scoreOf = (item: T): number | null => {
    const scores = [
      matchScore(textOf(item), needle),
      ...(alternateTextsOf?.(item) ?? []).map((text) => matchScore(text, needle)),
    ].filter((score): score is number => score !== null);
    return scores.length === 0 ? null : Math.min(...scores);
  };

  return items
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .filter((row): row is { item: T; index: number; score: number } => row.score !== null)
    .sort((left, right) => (
      left.score - right.score
      || textOf(left.item).localeCompare(textOf(right.item), undefined, { sensitivity: 'base' })
      || left.index - right.index
    ))
    .map((row) => row.item);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function matchScore(candidate: string, needle: string): number | null {
  const normalized = normalizeSearchText(candidate);
  if (normalized === needle) return 0;
  if (normalized.startsWith(needle)) return 1;

  const words = normalized.split(/[\s\p{P}\p{S}]+/gu).filter(Boolean);
  if (words.some((word) => word === needle)) return 1;
  if (words.some((word) => word.startsWith(needle))) return 2;
  if (normalized.includes(needle)) return 3;
  if (needle.length < 4) return null;

  const threshold = needle.length >= 9 ? 2 : 1;
  const distance = Math.min(
    boundedLevenshtein(normalized, needle, threshold),
    ...words.map((word) => boundedLevenshtein(word, needle, threshold)),
  );
  return distance <= threshold ? 10 + distance : null;
}

/** Returns maxDistance + 1 as soon as the distance cannot recover. */
function boundedLevenshtein(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0]!;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}
