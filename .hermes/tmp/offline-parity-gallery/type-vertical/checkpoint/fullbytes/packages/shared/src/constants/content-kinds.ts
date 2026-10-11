/**
 * The Content kinds every Gallery already has.
 *
 * A work's Content rows are free text — the kind is whatever the person typed — but two kinds are part
 * of every Gallery by convention rather than by anyone declaring them: the work's `Source URL` (what an
 * import writes from the source it came from) and its `description` (the synopsis a work page hands
 * over). Calling them built-ins is what makes them "a default existence, the same as each other":
 * nothing has to create them, a work shows a row only when it really has text, and a Gallery template
 * never has to list them to have them.
 *
 * The spellings are the app's own (what the import writes and the live libraries carry), so a Gallery
 * shows one `Source URL` rather than two spellings of the same kind.
 *
 * They are also the reason the template's Content scope can be derived instead of declared — a template
 * carries these plus whatever kinds its works actually use.
 */
export const DEFAULT_CONTENT_KINDS: readonly string[] = ['Source URL', 'description'];
