/**
 * What a work's card shows when the work has no image of its own.
 *
 * A cover-less work used to show nothing but the first letter of its title — a placeholder that
 * only says "there is no picture here". What it shows instead is text the work already carries: its
 * first Content, or, when it has no Content, its tags. The URL is never shown: a work's address
 * says where it came from, not what it is, and it is already the Source row a person can click.
 *
 * The rule lives here rather than on either side alone because two layers must agree on it. The
 * server picks the text for the entry lists it serves (a list of cards carries no Content and no
 * tags of its own), and the app picks it for a queued work, whose Content exists only locally. One
 * function is what keeps a card from reading two different things in the two places.
 */

/** The built-in kind whose value is a work's address rather than something about the work. */
export const SOURCE_URL_CONTENT_KIND = 'Source URL';

/**
 * How much of that text a cover shows, counted separately for the two scripts.
 *
 * Measured against the card the grid actually lays out (`repeat(auto-fill, minmax(7.5rem, 1fr))`,
 * so 120–170 px wide) at the size this text is drawn: five lines hold about 40–60 full-width
 * characters or 80–120 half-width ones. The two counts are separate rather than one ratio because
 * they were measured — a Latin word breaks at spaces, so it fits more per line than twice the CJK
 * count — and 50/100 is the pair that fills a mid-sized card without overrunning the small ones,
 * where the card's own clamp finishes the cut.
 */
export const COVER_TEXT_BUDGET = { cjk: 50, latin: 100 } as const;

export interface CoverTextBudget {
  /** Full-width characters (CJK, Kana, Hangul, full-width forms). */
  cjk: number;
  /** Half-width characters (Latin, digits, most punctuation). */
  latin: number;
}

export interface CoverTextContentRow {
  contentType: string;
  content: string;
}

export interface CoverTextInput {
  /** In the order the work's page shows them. The first usable row wins. */
  contents: readonly CoverTextContentRow[];
  /** In the order the work's page shows them. Used only when no Content is usable. */
  tags: readonly string[];
}

/** The separator between tags, matching how the rest of the app joins a short list. */
const TAG_SEPARATOR = ' · ';

/** A value that is nothing but an address, and so is not text about the work. */
const URL_VALUE_PATTERN = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * Wide characters, by the ranges that matter here rather than the whole East Asian Width table:
 * CJK (with extensions and compatibility forms), Kana, Hangul, CJK punctuation, full-width forms,
 * and emoji.
 */
const WIDE_CHARACTER_PATTERN = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Whether a Content kind is the work's address. The kind is free text a person typed, so the two
 * spellings a real library carries (`Source URL` from an import, `source url` from the probe) are
 * the same kind here.
 */
export function isSourceUrlContentKind(contentType: string): boolean {
  return collapseWhitespace(contentType).toLowerCase() === SOURCE_URL_CONTENT_KIND.toLowerCase();
}

/** Whether a value is an address rather than something about the work. */
export function isUrlContentValue(content: string): boolean {
  return URL_VALUE_PATTERN.test(collapseWhitespace(content));
}

function isWideCharacter(character: string): boolean {
  return WIDE_CHARACTER_PATTERN.test(character);
}

/**
 * Cuts the text to what a cover holds, adding an ellipsis only when something was actually cut.
 * Each character spends its script's share of the cover, so mixed text stops at the same point a
 * single script would. The arithmetic is whole numbers — full-width characters against the Latin
 * count and half-width ones against the CJK count — so a full cover is exactly full rather than
 * full up to a rounding error.
 */
export function truncateToCoverText(text: string, budget: CoverTextBudget = COVER_TEXT_BUDGET): string {
  const cjkRoom = Math.max(1, Math.round(budget.cjk));
  const latinRoom = Math.max(1, Math.round(budget.latin));
  const capacity = cjkRoom * latinRoom;
  let spent = 0;
  let length = 0;
  for (const character of text) {
    const cost = isWideCharacter(character) ? latinRoom : cjkRoom;
    if (spent + cost > capacity) break;
    spent += cost;
    length += character.length;
  }
  if (length >= text.length) return text;
  return `${text.slice(0, length).trimEnd()}…`;
}

/**
 * The text a cover shows: the first Content row that says something about the work, or else its
 * tags, or else nothing (the caller falls back to the title's first letter).
 */
export function pickDefaultCoverText(
  input: CoverTextInput,
  budget: CoverTextBudget = COVER_TEXT_BUDGET,
): string | null {
  for (const row of input.contents) {
    if (isSourceUrlContentKind(row.contentType)) continue;
    const text = collapseWhitespace(row.content);
    if (text === '' || isUrlContentValue(text)) continue;
    return truncateToCoverText(text, budget);
  }

  const tags: string[] = [];
  for (const tag of input.tags) {
    const name = collapseWhitespace(tag);
    if (name === '' || isUrlContentValue(name)) continue;
    tags.push(name);
  }
  if (tags.length === 0) return null;
  return truncateToCoverText([...new Set(tags)].join(TAG_SEPARATOR), budget);
}
