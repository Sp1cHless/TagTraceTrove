import type { CollectionRecordDto } from '@t3/shared';

/**
 * Flattens the collection tree for the add-to-collection menus: child folders
 * become selectable entries with a "Parent / Child" display path, so a work
 * can be added straight into a subfolder without visiting it first.
 */
export interface CollectionMenuOption {
  id: number;
  title: string;
  nsfw: boolean;
}

export function flattenCollectionOptions(
  records: CollectionRecordDto[],
  prefix = '',
): CollectionMenuOption[] {
  const options: CollectionMenuOption[] = [];
  for (const record of records) {
    const label = prefix === '' ? record.title : `${prefix} / ${record.title}`;
    options.push({ id: record.id, title: label, nsfw: record.nsfw });
    options.push(...flattenCollectionOptions(record.children, label));
  }
  return options;
}

/**
 * Narrows the add-to-collection menu to the folders an Entry may actually be
 * filed into: the ones curated onto its own Gallery page, plus the unfiled ones,
 * which sit on no page and therefore stay usable from anywhere. A folder the
 * Entry is already in is always kept — including through a parent record — so an
 * existing membership can still be seen and left again.
 */
export function collectionOptionsForGallery(
  records: CollectionRecordDto[],
  galleryType: string,
  memberIds: readonly number[],
): CollectionRecordDto[] {
  const members = new Set(memberIds);
  const belongs = (record: CollectionRecordDto): boolean => (
    record.galleryType === galleryType
    || record.galleryType === null
    || members.has(record.id)
    || record.children.some(belongs)
  );
  return records.filter(belongs);
}
