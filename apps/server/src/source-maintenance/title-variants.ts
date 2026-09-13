import { normalizeTag } from '@t3/shared';

/**
 * Conservative local title variant generation for Source maintenance.
 * Identity-deciding tokens (authors, volume numbers, `OVA`, `oneshot`, …) are
 * never stripped: variants only normalize spelling and split explicit
 * separator fragments. The complete normalized title is always kept first.
 */

const MAX_VARIANTS = 6;

/** Explicit separators that commonly join a Romaji/translated title pair. */
const TITLE_SEPARATORS = /\s*[|｜/／]\s*/gu;

export function buildTitleVariants(rawTitle: string): string[] {
  const full = normalizeTag(rawTitle);
  if (full === '') return [];

  const variants: string[] = [full];
  const fragments = rawTitle
    .normalize('NFKC')
    .split(TITLE_SEPARATORS)
    .map((fragment) => normalizeTag(fragment))
    .filter((fragment) => fragment.length >= 2 && fragment !== full);
  for (const fragment of fragments) {
    if (!variants.includes(fragment)) variants.push(fragment);
  }
  return variants.slice(0, MAX_VARIANTS);
}
