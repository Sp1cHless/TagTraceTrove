import type { T3Database } from '../database/connection.js';

/**
 * One-shot maintenance tooling for titles that carry a second spelling after a
 * `|` separator, used by the Advanced editing "Title shortening" tab.
 *
 * Sites title a work as `<original> | <translation>`, which doubles the title
 * length on every card. The rule is deliberately dumb and deterministic (no
 * language detection), and the review decides per title which side to keep:
 *
 * 1. the title must contain exactly one `|` with a non-empty side on each end;
 * 2. a part carrying Han or Kana text is the translated title, so the suggestion
 *    is to keep the part after the separator;
 * 3. a part carrying only Hangul is not a substitute for the original (the user
 *    reads neither Korean nor romaji as a title, but the original at least
 *    matches the rest of the series), so the suggestion is to keep the part
 *    before the separator;
 * 4. when the part after the separator is plain ASCII there is no way to tell a
 *    `romaji | English` pair from an `English | romaji` pair, so the suggestion
 *    is empty and the review has to choose (or leave the title untouched).
 */

export type TitleSide = 'front' | 'back';

export interface TitleShorteningCandidate {
  entryId: number;
  title: string;
  keepFront: string;
  keepBack: string;
  suggested: TitleSide | null;
}

export interface TitleShorteningChange {
  entryId: number;
  title: string;
  shortenedTitle: string;
}

export interface TitleShorteningPlan {
  candidates: TitleShorteningCandidate[];
}

export interface TitleShorteningApplication {
  shortenedCount: number;
  skippedCount: number;
}

const asciiOnly = (value: string): boolean => /^[\x20-\x7E]*$/u.test(value);
const hasHanOrKana = (value: string): boolean => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
const hasHangul = (value: string): boolean => /\p{Script=Hangul}/u.test(value);

/**
 * Splits one title into its two sides, or null when the shape does not qualify
 * (no separator, more than one separator, or an empty side).
 */
export function splitTitle(title: string): { front: string; back: string } | null {
  if (!title.includes('|')) return null;
  const parts = title.split('|').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const front = parts[0] as string;
  const back = parts[1] as string;
  if (front === '' || back === '') return null;
  return { front, back };
}

export function planTitleShortening(database: T3Database): TitleShorteningPlan {
  const rows = database.prepare(`
    SELECT id, title
    FROM entries
    WHERE title LIKE '%|%'
    ORDER BY id
  `).all() as Array<{ id: number; title: string }>;

  const candidates: TitleShorteningCandidate[] = [];
  for (const row of rows) {
    const sides = splitTitle(row.title);
    if (sides === null) continue;
    candidates.push({
      entryId: row.id,
      title: row.title,
      keepFront: sides.front,
      keepBack: sides.back,
      suggested: suggestSide(sides.back),
    });
  }
  return { candidates };
}

function suggestSide(back: string): TitleSide | null {
  if (hasHanOrKana(back)) return 'back';
  if (hasHangul(back) && !asciiOnly(back)) return 'front';
  return null;
}

/**
 * Applies exactly the reviewed changes. A change whose Entry no longer carries
 * the reviewed title is skipped rather than overwritten, so a plan that went
 * stale between review and execution can never clobber a newer title.
 */
export function applyTitleShortening(
  database: T3Database,
  changes: TitleShorteningChange[],
): TitleShorteningApplication {
  return database.transaction(() => {
    const update = database.prepare(`
      UPDATE entries
      SET title = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND title = ?
    `);
    let shortenedCount = 0;
    let skippedCount = 0;
    for (const change of changes) {
      const result = update.run(change.shortenedTitle, change.entryId, change.title);
      if (result.changes === 0) {
        skippedCount += 1;
        continue;
      }
      shortenedCount += 1;
    }
    return { shortenedCount, skippedCount };
  })();
}
