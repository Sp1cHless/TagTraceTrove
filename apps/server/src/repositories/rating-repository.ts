import { randomUUID } from 'node:crypto';
import type { T3Database } from '../database/connection.js';
import { galleryTypeForProducer } from './producer-tag-repository.js';

export type RatingSubjectKind = 'entry' | 'producer' | 'author_self';

/**
 * The three rating classes, as `rating_slots.subject_kind` spells them.
 *
 *   'entry'        the WORK's own dimensions.
 *   'producer'     the author's WORKS SUMMARY: the Gallery's work dimensions, rated once for the
 *                  author as a whole. This is the class an unrated work inherits (`<4` authors), the
 *                  class every pre-039 row belongs to, and it is what an imported batch rates when
 *                  the reviewer rates the author instead of every work.
 *   'author_self'  the author THEMSELVES: dimensions about the person or the studio, unrelated to
 *                  any work's dimensions. An actor is no longer rated on the film's 剧情.
 *
 * Both author classes are partitioned by the author's Gallery, and the dimension SET is shared
 * across every author of that partition — which is what makes "apply this template to every author
 * of the Gallery" a property of the model rather than a bulk copy. Only the VALUES are per author.
 */
export const AUTHOR_RATING_KINDS = ['producer', 'author_self'] as const;

export type AuthorRatingKind = (typeof AUTHOR_RATING_KINDS)[number];

export interface RatingSlotRecord {
  id: number;
  name: string;
  sortOrder: number;
}

export interface RatingRowRecord {
  slotId: number;
  name: string;
  /** null = the slot exists but is unrated; never treated as zero. */
  stars: number | null;
}

interface SlotRow {
  id: number;
  name: string;
  sort_order: number;
}

function isValidStars(stars: number | null | undefined): boolean {
  if (stars === null || stars === undefined) return true;
  return stars >= 0.5 && stars <= 5 && stars * 2 === Math.floor(stars * 2);
}

export function listRatingSlots(
  database: T3Database,
  kind: RatingSubjectKind,
  entryType: string,
): RatingSlotRecord[] {
  return (database.prepare(`
    SELECT id, name, sort_order
    FROM rating_slots
    WHERE subject_kind = ? AND entry_type = ?
    ORDER BY sort_order, id
  `).all(kind, entryType) as SlotRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
  }));
}

/**
 * Finds one slot by its dimension name. Author rating dimensions mirror the
 * Gallery's Entry dimensions by name, so this is the lookup that maps an Entry
 * slot onto the Author slot carrying the same dimension.
 */
export function findRatingSlotId(
  database: T3Database,
  kind: RatingSubjectKind,
  entryType: string,
  name: string,
): number | undefined {
  return database.prepare(`
    SELECT id
    FROM rating_slots
    WHERE subject_kind = ? AND entry_type = ? AND name = ?
    ORDER BY id
    LIMIT 1
  `).pluck().get(kind, entryType, name.trim()) as number | undefined;
}

/**
 * Creates the shared slot for one Gallery (or reuses the existing slot with
 * the same name — slots are fully templated per Gallery, so every card of the
 * Gallery shows the row immediately).
 *
 * A work dimension also brings the works summary's dimension of the same name into being: the
 * summary's dimension set IS the Gallery's work dimensions (that is what the class means), so it
 * follows the template by construction rather than by anyone pressing "apply". Measured before this
 * existed: a Gallery dimension added after an import never reached the authors, and there was no way
 * to tell — the two partitions simply drifted apart.
 */
export function createRatingSlot(
  database: T3Database,
  input: {
    kind: RatingSubjectKind;
    entryType: string;
    name: string;
  },
): RatingSlotRecord {
  const name = input.name.trim();
  if (name === '') {
    throw new Error('rating slot name cannot be empty');
  }
  const existing = database.prepare(`
    SELECT id, name, sort_order
    FROM rating_slots
    WHERE subject_kind = ? AND entry_type = ? AND name = ?
  `).get(input.kind, input.entryType, name) as SlotRow | undefined;
  if (existing) {
    if (input.kind === 'entry') mirrorWorksSummarySlot(database, input.entryType, name);
    return { id: existing.id, name: existing.name, sortOrder: existing.sort_order };
  }
  const maxOrder = database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1)
    FROM rating_slots
    WHERE subject_kind = ? AND entry_type = ?
  `).pluck().get(input.kind, input.entryType) as number;
  const result = database.prepare(`
    INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order, sync_uid)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.kind, input.entryType, name, maxOrder + 1, randomUUID());
  if (input.kind === 'entry') mirrorWorksSummarySlot(database, input.entryType, name);
  return {
    id: Number(result.lastInsertRowid),
    name,
    sortOrder: maxOrder + 1,
  };
}

/**
 * The works-summary dimension of the same name, created when a work dimension appears.
 *
 * It is a no-op once the dimension exists, so it costs one lookup on the entry side and never
 * touches a value. Only the summary mirrors: the author's own class is free-form and has nothing to
 * do with any work's dimensions.
 */
function mirrorWorksSummarySlot(database: T3Database, entryType: string, name: string): void {
  const existing = database.prepare(`
    SELECT id FROM rating_slots WHERE subject_kind = 'producer' AND entry_type = ? AND name = ?
  `).pluck().get(entryType, name);
  if (existing !== undefined) return;
  const maxOrder = database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1)
    FROM rating_slots
    WHERE subject_kind = 'producer' AND entry_type = ?
  `).pluck().get(entryType) as number;
  database.prepare(`
    INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order, sync_uid)
    VALUES ('producer', ?, ?, ?, ?)
  `).run(entryType, name, maxOrder + 1, randomUUID());
}

function ratingRows(
  database: T3Database,
  kind: RatingSubjectKind,
  entryType: string,
  valueColumn: 'entry_id' | 'producer_id',
  subjectId: number,
): RatingRowRecord[] {
  const slots = listRatingSlots(database, kind, entryType);
  if (slots.length === 0) return [];
  const table = kind === 'entry' ? 'entry_rating_values' : 'producer_rating_values';
  const values = new Map(
    (database.prepare(`
      SELECT slot_id, stars
      FROM ${table}
      WHERE ${valueColumn} = ?
    `).all(subjectId) as Array<{ slot_id: number; stars: number | null }>)
      .map((row) => [row.slot_id, row.stars]),
  );
  return slots.map((slot) => ({
    slotId: slot.id,
    name: slot.name,
    stars: values.has(slot.id) ? values.get(slot.id)! : null,
  }));
}

export function listEntryRatings(database: T3Database, entryId: number): RatingRowRecord[] {
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  return ratingRows(database, 'entry', row.type, 'entry_id', entryId);
}

/** The author's WORKS SUMMARY rows — the class a work with no rating of its own inherits. */
export function listProducerRatings(database: T3Database, producerId: number): RatingRowRecord[] {
  return listAuthorRatings(database, producerId, 'producer');
}

/** The author's OWN rows: dimensions about the person or the studio, never inherited by a work. */
export function listAuthorSelfRatings(database: T3Database, producerId: number): RatingRowRecord[] {
  return listAuthorRatings(database, producerId, 'author_self');
}

export function listAuthorRatings(
  database: T3Database,
  producerId: number,
  kind: AuthorRatingKind,
): RatingRowRecord[] {
  const galleryType = galleryTypeForProducer(database, producerId);
  if (galleryType === null) return [];
  return ratingRows(database, kind, galleryType, 'producer_id', producerId);
}

function requireSlot(
  database: T3Database,
  slotId: number,
  kinds: readonly RatingSubjectKind[],
  entryType: string,
): void {
  const row = database.prepare(`
    SELECT 1
    FROM rating_slots
    WHERE id = ? AND subject_kind IN (${kinds.map(() => '?').join(', ')}) AND entry_type = ?
  `).get(slotId, ...kinds, entryType);
  if (!row) {
    throw new Error(
      `cannot set the rating: slot ${slotId} does not belong to the ${kinds.join('|')}`
      + ` Gallery "${entryType}"`,
    );
  }
}

export function setEntryRating(
  database: T3Database,
  input: { entryId: number; slotId: number; stars: number | null },
  options: { touchEntry?: boolean } = {},
): RatingRowRecord {
  if (!isValidStars(input.stars)) {
    throw new Error('cannot set the rating: stars must be null or a half-step value between 0.5 and 5');
  }
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(input.entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  requireSlot(database, input.slotId, ['entry'], row.type);
  const name = database.prepare('SELECT name FROM rating_slots WHERE id = ?')
    .pluck().get(input.slotId) as string;
  const existing = database.prepare(`
    SELECT stars FROM entry_rating_values WHERE slot_id = ? AND entry_id = ?
  `).get(input.slotId, input.entryId) as { stars: number | null } | undefined;
  const currentStars = existing?.stars ?? null;
  if (currentStars === input.stars) {
    return { slotId: input.slotId, name, stars: input.stars };
  }

  database.transaction(() => {
    database.prepare(`
      INSERT INTO entry_rating_values (slot_id, entry_id, stars)
      VALUES (?, ?, ?)
      ON CONFLICT (slot_id, entry_id) DO UPDATE SET
        stars = excluded.stars,
        updated_at = CURRENT_TIMESTAMP
    `).run(input.slotId, input.entryId, input.stars);
    if (options.touchEntry !== false) {
      database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(input.entryId);
    }
  })();
  return {
    slotId: input.slotId,
    name,
    stars: input.stars,
  };
}

export function setProducerRating(
  database: T3Database,
  input: { producerId: number; slotId: number; stars: number | null },
): RatingRowRecord {
  if (!isValidStars(input.stars)) {
    throw new Error('cannot set the rating: stars must be null or a half-step value between 0.5 and 5');
  }
  const galleryType = galleryTypeForProducer(database, input.producerId);
  if (galleryType === null) {
    throw new Error('cannot rate an author without works: no dominant Gallery exists');
  }
  // Either author class: which one the value belongs to is decided by the slot, so the same write
  // serves the works summary and the author's own dimensions.
  requireSlot(database, input.slotId, AUTHOR_RATING_KINDS, galleryType);
  const name = database.prepare('SELECT name FROM rating_slots WHERE id = ?')
    .pluck().get(input.slotId) as string;
  const existing = database.prepare(`
    SELECT stars FROM producer_rating_values WHERE slot_id = ? AND producer_id = ?
  `).get(input.slotId, input.producerId) as { stars: number | null } | undefined;
  if ((existing?.stars ?? null) === input.stars) {
    return { slotId: input.slotId, name, stars: input.stars };
  }
  database.prepare(`
    INSERT INTO producer_rating_values (slot_id, producer_id, stars)
    VALUES (?, ?, ?)
    ON CONFLICT (slot_id, producer_id) DO UPDATE SET
      stars = excluded.stars,
      updated_at = CURRENT_TIMESTAMP
  `).run(input.slotId, input.producerId, input.stars);
  return {
    slotId: input.slotId,
    name,
    stars: input.stars,
  };
}

export function reorderRatingSlots(
  database: T3Database,
  kind: RatingSubjectKind,
  entryType: string,
  orderedSlotIds: number[],
): void {
  const existing = listRatingSlots(database, kind, entryType);
  const existingIds = new Set(existing.map((slot) => slot.id));
  const orderedIds = new Set(orderedSlotIds);
  if (orderedIds.size !== orderedSlotIds.length || orderedSlotIds.length !== existing.length
    || orderedSlotIds.some((id) => !existingIds.has(id))) {
    throw new Error('cannot reorder: the payload must contain every rating slot exactly once');
  }
  database.transaction(() => {
    const update = database.prepare('UPDATE rating_slots SET sort_order = ? WHERE id = ?');
    orderedSlotIds.forEach((slotId, index) => update.run(index, slotId));
  })();
}

/** Entry-facing slot creation: the slot joins the shared set of the Entry's Gallery. */
export function createEntryRatingSlot(
  database: T3Database,
  input: { entryId: number; name: string },
): RatingSlotRecord {
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(input.entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  return createRatingSlot(database, { kind: 'entry', entryType: row.type, name: input.name });
}

/**
 * Author-facing slot creation: the slot joins the partition of the Author's Gallery, so it
 * automatically appears on every author of that Gallery — for the works summary and for the
 * author's own dimensions alike, in their own partitions.
 */
export function createProducerRatingSlot(
  database: T3Database,
  input: { producerId: number; name: string; kind?: AuthorRatingKind },
): RatingSlotRecord {
  const producer = database.prepare('SELECT 1 FROM producers WHERE id = ?')
    .get(input.producerId);
  if (!producer) {
    throw new Error('producer not found');
  }
  const galleryType = galleryTypeForProducer(database, input.producerId);
  if (galleryType === null) {
    throw new Error(
      'cannot create a rating slot for an author without works: no Gallery is anchored',
    );
  }
  return createRatingSlot(database, {
    kind: input.kind ?? 'producer',
    entryType: galleryType,
    name: input.name,
  });
}

/**
 * Slot order is part of the shared Gallery template: reordering from any Entry
 * reorders the rating section on every same-type card.
 */
export function reorderEntryRatingSlots(
  database: T3Database,
  entryId: number,
  orderedSlotIds: number[],
): void {
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  reorderRatingSlots(database, 'entry', row.type, orderedSlotIds);
}

export function reorderProducerRatingSlots(
  database: T3Database,
  producerId: number,
  orderedSlotIds: number[],
): void {
  const producer = database.prepare('SELECT 1 FROM producers WHERE id = ?')
    .get(producerId);
  if (!producer) {
    throw new Error('producer not found');
  }
  const galleryType = galleryTypeForProducer(database, producerId);
  if (galleryType === null) {
    throw new Error(
      'cannot reorder rating slots for an author without works: no Gallery is anchored',
    );
  }
  // The payload comes from one of the two author lists, so the class is the payload's own — reading
  // it here keeps the caller from having to say it twice, and stops a mixed payload from reordering
  // one class into the other's order.
  const kinds = new Set(
    (database.prepare(`
      SELECT subject_kind AS kind FROM rating_slots
      WHERE id IN (${orderedSlotIds.map(() => '?').join(', ') || 'NULL'})
    `).pluck().all(...orderedSlotIds) as string[]),
  );
  if (kinds.size !== 1) {
    throw new Error('cannot reorder: the payload must be one class of rating slot');
  }
  reorderRatingSlots(database, [...kinds][0] as RatingSubjectKind, galleryType, orderedSlotIds);
}

/**
 * Removes one rating dimension, and every value recorded on it.
 *
 * A slot belongs to its Gallery's partition, not to the card it was clicked on: a work dimension is
 * shared by every Entry of the type, an author dimension by every Author anchored to it, and the
 * value tables cascade — so the caller has to mean the whole partition, which is why every surface
 * asks before calling this. The partition's sync revision moves by itself (the layout triggers).
 *
 * One row goes, and only that row. The works summary's dimension of the same name is a different row
 * for a different subject, so deleting a work dimension does not take the authors' ratings with it,
 * and the other way round.
 */
export function deleteEntryRatingSlot(
  database: T3Database,
  input: { entryId: number; slotId: number },
): void {
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(input.entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  requireSlot(database, input.slotId, ['entry'], row.type);
  database.prepare('DELETE FROM rating_slots WHERE id = ?').run(input.slotId);
}

/** The author side of the same: either of their two classes, in their own Gallery's partition. */
export function deleteAuthorRatingSlot(
  database: T3Database,
  input: { producerId: number; slotId: number },
): void {
  const producer = database.prepare('SELECT 1 FROM producers WHERE id = ?').get(input.producerId);
  if (!producer) {
    throw new Error('producer not found');
  }
  const galleryType = galleryTypeForProducer(database, input.producerId);
  if (galleryType === null) {
    throw new Error(
      'cannot delete a rating slot for an author without works: no Gallery is anchored',
    );
  }
  requireSlot(database, input.slotId, AUTHOR_RATING_KINDS, galleryType);
  database.prepare('DELETE FROM rating_slots WHERE id = ?').run(input.slotId);
}

/**
 * Anchors an Author to a Gallery, which is the partition both of their rating classes live in.
 *
 * The value is what the badge shows and what every rating read and write is keyed by, so anchoring
 * is how a person says "this author belongs here" — including for the author whose works are split
 * across Galleries.
 */
export function setProducerGalleryAnchor(
  database: T3Database,
  input: { producerId: number; galleryType: string },
): { producerId: number; galleryAnchor: string } {
  const producer = database.prepare('SELECT 1 FROM producers WHERE id = ?').get(input.producerId);
  if (!producer) {
    throw new Error('producer not found');
  }
  const galleryType = input.galleryType.trim();
  if (galleryType === '') {
    throw new Error('cannot anchor an author to an empty Gallery');
  }
  database.prepare('UPDATE producers SET gallery_anchor = ? WHERE id = ?')
    .run(galleryType, input.producerId);
  return { producerId: input.producerId, galleryAnchor: galleryType };
}
