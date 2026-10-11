/**
 * The site-taxonomy dictionary parser, re-exported from `@t3/shared`.
 *
 * It lives in the shared package because both halves read the same documents now: the web imports one
 * the person picks, and the server imports every site's dictionary from the tool's own export tree.
 * Two copies of "what a dictionary section means" would drift the moment one of them changed.
 */
export { parseTaxonomyDictionary } from '@t3/shared';
