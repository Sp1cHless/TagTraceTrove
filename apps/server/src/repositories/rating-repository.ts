import type { T3Database } from '../database/connection.js';
import { galleryTypeForProducer } from './producer-tag-repository.js';

export type RatingSubjectKind = 'entry' | 'producer';

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
 * Creates the shared slot for one Gallery (or reuses the existing slot with
 * the same name — slots are fully templated per Gallery, so every card of the
 * Gallery shows the row immediately).
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
    return { id: existing.id, name: existing.name, sortOrder: existing.sort_order };
  }
  const maxOrder = database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1)
    FROM rating_slots
    WHERE subject_kind = ? AND entry_type = ?
  `).pluck().get(input.kind, input.entryType) as number;
  const result = database.prepare(`
    INSERT INTO rating_slots (subject_kind, entry_type, name, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(input.kind, input.entryType, name, maxOrder + 1);
  return {
    id: Number(result.lastInsertRowid),
    name,
    sortOrder: maxOrder + 1,
  };
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

export function listProducerRatings(database: T3Database, producerId: number): RatingRowRecord[] {
  const galleryType = galleryTypeForProducer(database, producerId);
  if (galleryType === null) return [];
  return ratingRows(database, 'producer', galleryType, 'producer_id', producerId);
}

function requireSlot(
  database: T3Database,
  slotId: number,
  kind: RatingSubjectKind,
  entryType: string,
): void {
  const row = database.prepare(`
    SELECT 1
    FROM rating_slots
    WHERE id = ? AND subject_kind = ? AND entry_type = ?
  `).get(slotId, kind, entryType);
  if (!row) {
    throw new Error(
      `cannot set the rating: slot ${slotId} does not belong to the ${kind} Gallery "${entryType}"`,
    );
  }
}

export function setEntryRating(
  database: T3Database,
  input: { entryId: number; slotId: number; stars: number | null },
): RatingRowRecord {
  if (!isValidStars(input.stars)) {
    throw new Error('cannot set the rating: stars must be null or a half-step value between 0.5 and 5');
  }
  const row = database.prepare('SELECT type FROM entries WHERE id = ?')
    .get(input.entryId) as { type: string } | undefined;
  if (!row) {
    throw new Error('entry not found');
  }
  requireSlot(database, input.slotId, 'entry', row.type);
  database.prepare(`
    INSERT INTO entry_rating_values (slot_id, entry_id, stars)
    VALUES (?, ?, ?)
    ON CONFLICT (slot_id, entry_id) DO UPDATE SET
      stars = excluded.stars,
      updated_at = CURRENT_TIMESTAMP
  `).run(input.slotId, input.entryId, input.stars);
  return {
    slotId: input.slotId,
    name: (database.prepare('SELECT name FROM rating_slots WHERE id = ?')
      .pluck().get(input.slotId) as string),
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
  requireSlot(database, input.slotId, 'producer', galleryType);
  database.prepare(`
    INSERT INTO producer_rating_values (slot_id, producer_id, stars)
    VALUES (?, ?, ?)
    ON CONFLICT (slot_id, producer_id) DO UPDATE SET
      stars = excluded.stars,
      updated_at = CURRENT_TIMESTAMP
  `).run(input.slotId, input.producerId, input.stars);
  return {
    slotId: input.slotId,
    name: (database.prepare('SELECT name FROM rating_slots WHERE id = ?')
      .pluck().get(input.slotId) as string),
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
 * Author-facing slot creation: the slot joins the partition of the Author's
 * dominant Gallery, so it automatically appears on every same-type Author.
 */
export function createProducerRatingSlot(
  database: T3Database,
  input: { producerId: number; name: string },
): RatingSlotRecord {
  const producer = database.prepare('SELECT 1 FROM producers WHERE id = ?')
    .get(input.producerId);
  if (!producer) {
    throw new Error('producer not found');
  }
  const galleryType = galleryTypeForProducer(database, input.producerId);
  if (galleryType === null) {
    throw new Error(
      'cannot create a rating slot for an author without works: no dominant Gallery exists',
    );
  }
  return createRatingSlot(database, { kind: 'producer', entryType: galleryType, name: input.name });
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
      'cannot reorder rating slots for an author without works: no dominant Gallery exists',
    );
  }
  reorderRatingSlots(database, 'producer', galleryType, orderedSlotIds);
}
