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
