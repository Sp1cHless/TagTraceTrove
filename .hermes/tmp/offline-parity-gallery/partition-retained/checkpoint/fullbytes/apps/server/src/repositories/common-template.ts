import { createFacet, createSection, listLayout } from '../repositories/layout-repository.js';
import { createRatingSlot } from './rating-repository.js';
import type { T3Database } from '../database/connection.js';
import contents from '../templates/common-template.json' with { type: 'json' };

/**
 * The **common template**: the one template every Gallery can start from.
 *
 * A Gallery's template is its Sections and Facets, and a brand-new Gallery has none — so an import
 * arrives with nothing to hang Tags on. That is a dead end the import review cannot escape from on
 * its own (the commit needs a canonical tag Facet), and this is the way out that costs nobody a
 * thought: one click puts a usable structure in place.
 *
 * Two properties make it "common" rather than "default", and both are the user's words:
 *
 * * **applying it is a copy, not a link.** The Sections and Facets become *that Gallery's own*, in
 *   the database, exactly as if they had been typed in the entry editor — and the editor can rename,
 *   empty or delete them afterwards. Nothing reads this file after the click, so a person who edits
 *   the result cannot be "corrected" back by an update;
 * * **it is repository content, not user data.** The file is committed next to the code and imported
 *   as a module, so it ships with a build and is not hidden by the `.data/` ignore — the opposite of
 *   the per-Gallery template files, which are written under the database's `templates/` directory
 *   because those *are* the user's data.
 *
 * The content is a real template somebody built in the app and handed over: replace the file and
 * every Gallery that has not been built yet is affected.
 */
export interface CommonTemplateSection {
  name: string;
  facets: string[];
}

export interface CommonTemplate {
  name: string;
  sections: CommonTemplateSection[];
  /**
   * Rating dimensions the template carries, created as the Gallery's own **entry** rating slots.
   * A template was more than Sections and Facets in the Gallery it was built from (its author added
   * a General Rating), and a Gallery without any slot has no way to rate its works at all.
   */
  ratingSlots: string[];
}

export const COMMON_TEMPLATE: CommonTemplate = contents as CommonTemplate;

export interface CommonTemplateApplyResult {
  entryType: string;
  sectionCount: number;
  facetCount: number;
  /** The rating dimensions created for this Gallery (existing ones are not duplicated). */
  ratingSlotCount: number;
}

/**
 * Give a Gallery the common template, as its own.
 *
 * A Gallery that already has a layout is refused rather than merged: sections are the person's
 * decisions about *their* Gallery, and silently adding three more to a structure somebody built is
 * how a template stops being theirs. The review only offers this when the Gallery has nothing.
 */
export function applyCommonTemplate(
  database: T3Database,
  entryType: string,
  template: CommonTemplate = COMMON_TEMPLATE,
): CommonTemplateApplyResult {
  const type = entryType.trim();
  if (type === '') throw new Error('an entry type is required to apply the common template');
  if (listLayout(database, type).length > 0) {
    throw new Error(`"${type}" already has a template`);
  }

  return database.transaction(() => {
    let facetCount = 0;
    template.sections.forEach((section, index) => {
      const created = createSection(database, { entryType: type, name: section.name, sortOrder: index });
      section.facets.forEach((facet) => {
        createFacet(database, { sectionId: created.id, name: facet });
        facetCount += 1;
      });
    });
    return {
      entryType: type,
      sectionCount: template.sections.length,
      facetCount,
      ratingSlotCount: applyCommonRatingSlots(database, type, template),
    };
  })();
}

/**
 * Give a Gallery the template's rating dimensions, whichever slots it is missing.
 *
 * A separate step because a Gallery can be *between* the two halves of this feature: one built while
 * the template carried no slots (the user's 小说) has a full template and no way to rate anything.
 * `createRatingSlot` returns the existing slot for a repeated name, so this is idempotent — calling
 * it on a Gallery that already has the slots changes nothing.
 */
export function applyCommonRatingSlots(
  database: T3Database,
  entryType: string,
  template: CommonTemplate = COMMON_TEMPLATE,
): number {
  const type = entryType.trim();
  if (type === '') throw new Error('an entry type is required to apply the common template');
  let created = 0;
  template.ratingSlots.forEach((name) => {
    const slot = createRatingSlot(database, { kind: 'entry', entryType: type, name });
    // createRatingSlot answers the existing slot on a repeated name; the count only says how many
    // are there now, which is what the review reports.
    created += 1;
    void slot;
  });
  return created;
}
