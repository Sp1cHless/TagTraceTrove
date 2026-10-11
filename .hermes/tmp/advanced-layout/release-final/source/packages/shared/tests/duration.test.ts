import { describe, expect, it } from 'vitest';

import { formatDuration, parseDurationSeconds } from '../src/duration.js';

describe('a work’s duration', () => {
  it('reads every spelling a page publishes, and a number is already seconds', () => {
    // The three shapes measured on 2026-10-08: hanime1 and missav write `og:video:duration` as a
    // bare number of seconds; jable's cards read `2:02:43`; a player's own label reads `13:25`.
    expect(parseDurationSeconds(805)).toBe(805);
    expect(parseDurationSeconds(0)).toBe(0);
    expect(parseDurationSeconds('805')).toBe(805);
    expect(parseDurationSeconds('45')).toBe(45);
    expect(parseDurationSeconds('13:25')).toBe(805);
    expect(parseDurationSeconds('2:02')).toBe(122);
    // A short clip's own label, which is the case a person types most often.
    expect(parseDurationSeconds('7:50')).toBe(470);
    expect(parseDurationSeconds('07:50')).toBe(470);
    expect(parseDurationSeconds('1:02:36')).toBe(3756);
    expect(parseDurationSeconds(' 13:25 ')).toBe(805);
    expect(parseDurationSeconds('0:13:25')).toBe(805);
    expect(parseDurationSeconds('100:00')).toBe(6000);
  });

  it('folds a full-width spelling, because that is what a Chinese keyboard produces', () => {
    // The input method is often still on when a duration is typed, and reading `１：０２：３６` as "not
    // a duration" would look like a bug rather than a refusal.
    expect(parseDurationSeconds('１：０２：３６')).toBe(3756);
    expect(parseDurationSeconds('１３：２５')).toBe(805);
  });

  it('refuses a value whose lower part reaches sixty rather than guessing the unit', () => {
    // `1:75` is either 1h75m or 1m75s; a wrong duration that looks right is worse than none.
    expect(parseDurationSeconds('1:75')).toBeNull();
    expect(parseDurationSeconds('1:75:30')).toBeNull();
    expect(parseDurationSeconds('1:2:3:4')).toBeNull();
    expect(parseDurationSeconds('abc')).toBeNull();
    expect(parseDurationSeconds('1 hour 2 minutes')).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('   ')).toBeNull();
    expect(parseDurationSeconds('-30')).toBeNull();
    expect(parseDurationSeconds(-1)).toBeNull();
    expect(parseDurationSeconds(Number.NaN)).toBeNull();
    expect(parseDurationSeconds(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseDurationSeconds(null)).toBeNull();
    expect(parseDurationSeconds(undefined)).toBeNull();
  });

  it('writes seconds back as h:mm:ss, which is the shape the Entry shows', () => {
    expect(formatDuration(805)).toBe('0:13:25');
    expect(formatDuration(3756)).toBe('1:02:36');
    expect(formatDuration(7181)).toBe('1:59:41');
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(59)).toBe('0:00:59');
    // A work with no runtime has no value, and the row must print nothing rather than `NaN:NaN:NaN`.
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });

  it('round-trips what it writes', () => {
    for (const seconds of [0, 1, 59, 60, 805, 3756, 7181, 36_000]) {
      expect(parseDurationSeconds(formatDuration(seconds))).toBe(seconds);
    }
  });
});
