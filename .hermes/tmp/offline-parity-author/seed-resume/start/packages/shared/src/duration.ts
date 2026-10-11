/**
 * A work's duration, stored as whole seconds and written as `h:mm:ss`.
 *
 * The three pages measured on 2026-10-08 publish it in three different shapes and all of them mean
 * the same thing: hanime1 and missav declare it in an OpenGraph tag as a plain number of seconds
 * (`og:video:duration` `805`), jable renders `2:02:43` on its cards, and a player's own label reads
 * `13:25`. A page that publishes no duration at all is the ordinary case — most video pages only
 * compute it inside the player — so the field is optional everywhere and absent is not an error.
 *
 * One parser serves the import JSON, the Entry's inline editor and any adapter, so the three
 * spellings cannot drift apart: the column keeps the unit (seconds) and `formatDuration` is the one
 * place the display shape lives.
 */

/** `ss` / `s` — a bare count of seconds, which is what an OpenGraph duration is. */
const PLAIN_SECONDS = /^\d+$/u;

/** `h:mm:ss`, `mm:ss` and `m:ss` — digits in every part, at most three parts. */
const CLOCK_DIGITS = /^\d+$/u;

/**
 * A duration in any of the accepted spellings into whole seconds, or `null` when it is not one.
 *
 * Accepted: `h:mm:ss`, `mm:ss`, `m:ss`, `ss`, `s` — and a number, which is already seconds. A
 * full-width spelling is folded first, because `１：０２：３６` is what a Chinese keyboard produces
 * when the input method is still on, and reading it as "not a duration" would look like a bug.
 *
 * Every part but the leading one has an upper bound, because those are the minutes and the seconds;
 * the leading part is the largest unit a site chose to write and may exceed it — a hundred minutes
 * written `100:00` is unambiguous. A trailing part that reaches sixty is refused rather than carried
 * (`1:75` is either 1h75m or 1m75s), because a wrong duration that looks right is worse than none.
 */
export function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').trim();
  if (text === '') return null;
  if (PLAIN_SECONDS.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => CLOCK_DIGITS.test(part))) return null;
  const numbers = parts.map((part) => Number(part));
  const seconds = numbers[numbers.length - 1] as number;
  if (seconds >= 60) return null;
  if (parts.length === 2) return (numbers[0] as number) * 60 + seconds;
  const minutes = numbers[1] as number;
  if (minutes >= 60) return null;
  return (numbers[0] as number) * 3600 + minutes * 60 + seconds;
}

/**
 * Whole seconds as `h:mm:ss` — the shape the Entry shows, with the hour present even at zero
 * minutes so every work's value is the same width in the statistics row.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
