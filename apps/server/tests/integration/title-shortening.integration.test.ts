import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import {
  applyTitleShortening,
  planTitleShortening,
  splitTitle,
} from '../../src/repositories/title-shortening-repository.js';

describe('title shortening', () => {
  it('suggests keeping the side that carries the translated title', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const chinese = createEntry(database, { title: 'Inbi na Doukutsu 1 | 在淫靡洞窟的深處中 1', type: 'comic' });
      // A Japanese original instead of romaji is the same shape.
      const japanese = createEntry(database, { title: '京也は夢で私を犯す | 我在梦中被京也侵犯了', type: 'comic' });
      const plan = planTitleShortening(database);

      expect(plan.candidates).toContainEqual({
        entryId: chinese.id,
        title: 'Inbi na Doukutsu 1 | 在淫靡洞窟的深處中 1',
        keepFront: 'Inbi na Doukutsu 1',
        keepBack: '在淫靡洞窟的深處中 1',
        suggested: 'back',
      });
      expect(plan.candidates.find((candidate) => candidate.entryId === japanese.id)?.suggested)
        .toBe('back');
    } finally {
      database.close();
    }
  });

  it('suggests keeping the original when the other side is only Hangul', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entry = createEntry(database, {
        title: 'Hu Tao ni Warui Koto o Suru no Hanashi (Zenpen+Kouhen) | 호두에게 나쁜 짓을 하는 이야기 (decensored)',
        type: 'comic',
      });
      const plan = planTitleShortening(database);
      // A Korean title is not a usable replacement for the original.
      expect(plan.candidates).toEqual([{
        entryId: entry.id,
        title: 'Hu Tao ni Warui Koto o Suru no Hanashi (Zenpen+Kouhen) | 호두에게 나쁜 짓을 하는 이야기 (decensored)',
        keepFront: 'Hu Tao ni Warui Koto o Suru no Hanashi (Zenpen+Kouhen)',
        keepBack: '호두에게 나쁜 짓을 하는 이야기 (decensored)',
        suggested: 'front',
      }]);
    } finally {
      database.close();
    }
  });

  it('leaves the suggestion empty when the direction cannot be inferred', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const ambiguous = createEntry(database, { title: 'Marine Senchou no JK Hon | Marine Senchou, the High-Schooler', type: 'comic' });
      // The translation sits on the LEFT here, so either choice could be wrong.
      const reversed = createEntry(database, {
        title: 'Sensei, Please Freely Use Me as Part of My Mission | Sensei Kore wa Watashi no Ninmu desu',
        type: 'comic',
      });
      const plan = planTitleShortening(database);
      expect(plan.candidates.map((candidate) => candidate.suggested)).toEqual([null, null]);
      expect(plan.candidates.map((candidate) => candidate.entryId)).toEqual([ambiguous.id, reversed.id]);
    } finally {
      database.close();
    }
  });

  it('skips titles the two-sided split cannot describe', () => {
    expect(splitTitle('FGO Icha Love Ero Goudou ~Junai Tokuiten Lovedea~')).toBeNull();
    // Double separator: one side would be empty.
    expect(splitTitle('Artist || akchu')).toBeNull();
    // Trailing separator with nothing after it.
    expect(splitTitle('Drip Coffee→From♡You |')).toBeNull();
    expect(splitTitle('| 百濁之塔 -壹-')).toBeNull();
    expect(splitTitle('Hyakudaku no Tou | 百濁之塔 -壹-')).toEqual({
      front: 'Hyakudaku no Tou',
      back: '百濁之塔 -壹-',
    });

    const database = createMigratedMemoryDatabase();
    try {
      createEntry(database, { title: 'Artist || akchu', type: 'comic' });
      createEntry(database, { title: 'No separator here', type: 'comic' });
      expect(planTitleShortening(database).candidates).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('applies only the reviewed choices and keeps the rest untouched', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const keepBack = createEntry(database, { title: 'Hyakudaku no Tou | 百濁之塔 -壹-', type: 'comic' });
      const keepFront = createEntry(database, { title: 'Yuuka (Gym Uniform) | 유우카', type: 'comic' });
      const untouched = createEntry(database, { title: 'Nagareboshi | Shooting Star', type: 'comic' });

      const plan = planTitleShortening(database);
      const applied = applyTitleShortening(database, [
        { entryId: keepBack.id, title: keepBack.title, shortenedTitle: plan.candidates[0]!.keepBack },
        { entryId: keepFront.id, title: 'Yuuka (Gym Uniform) | 유우카', shortenedTitle: 'Yuuka (Gym Uniform)' },
      ]);

      expect(applied).toEqual({ shortenedCount: 2, skippedCount: 0 });
      expect(getEntryDetail(database, keepBack.id)?.title).toBe('百濁之塔 -壹-');
      expect(getEntryDetail(database, keepFront.id)?.title).toBe('Yuuka (Gym Uniform)');
      // Nothing was chosen for this one, so it keeps its full title.
      expect(getEntryDetail(database, untouched.id)?.title).toBe('Nagareboshi | Shooting Star');
    } finally {
      database.close();
    }
  });

  it('skips a change whose title moved on since the plan was reviewed', () => {
    const database = createMigratedMemoryDatabase();
    try {
      const entry = createEntry(database, { title: 'Before | 之后', type: 'comic' });
      const plan = planTitleShortening(database);
      const change = {
        entryId: entry.id,
        title: plan.candidates[0]!.title,
        shortenedTitle: plan.candidates[0]!.keepBack,
      };

      // A later rename (another tab, an import) invalidates the reviewed choice.
      database.prepare('UPDATE entries SET title = ? WHERE id = ?').run('Renamed | 重命名', entry.id);
      const applied = applyTitleShortening(database, [change]);

      expect(applied).toEqual({ shortenedCount: 0, skippedCount: 1 });
      expect(getEntryDetail(database, entry.id)?.title).toBe('Renamed | 重命名');
    } finally {
      database.close();
    }
  });
});
