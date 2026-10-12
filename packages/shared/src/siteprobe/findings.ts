import type { SiteprobeFinding } from '../schemas/siteprobe.js';

/**
 * The tool's findings, turned into the one thing a screen can show.
 *
 * The plan's Phase E is "T³ shows which stage produced nothing, not just '0 items'". The findings
 * already carry the stage, the severity and a message; what a panel needs on top is an *order* (the
 * worst first, then the order a run proceeds in) and, for the common codes, a sentence about what to
 * do next. That is all this is — no site is named, and an unknown code is still shown, just without
 * advice, so a finding the tool adds later cannot be silently dropped here.
 */

const STAGE_ORDER: readonly string[] = ['target', 'acquisition', 'listing', 'work', 'media', 'import'];
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

export interface SiteprobeFindingSummary {
  code: string;
  stage: string;
  severity: string;
  message: string;
  /** What a person can do about it, when the code has a known next step. */
  advice: string | null;
}

/** Findings sorted worst-first, each with its advice. */
export function describeFindings(
  findings: readonly SiteprobeFinding[] | undefined,
): SiteprobeFindingSummary[] {
  return [...(findings ?? [])]
    .sort((left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
      || STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage))
    .map((finding) => ({
      code: finding.code,
      stage: finding.stage,
      severity: finding.severity,
      message: finding.message,
      advice: finding.suggested_action ?? findingAdvice(finding.code),
    }));
}

/** The one finding worth leading with: the first error, else the first finding, else nothing. */
export function primaryFinding(
  findings: readonly SiteprobeFinding[] | undefined,
): SiteprobeFinding | null {
  const list = findings ?? [];
  return list.find((finding) => finding.severity === 'error') ?? list[0] ?? null;
}

/** The next step for a code a person can act on. Unknown codes return null, and are still shown. */
export function findingAdvice(code: string): string | null {
  switch (code) {
    case 'LISTING_ROWS_EMPTY':
      return 'Re-open the listing in the Builder and mark a card whose link carries the work id.';
    case 'WORK_FIELD_EMPTY':
      return 'Check which page the field rule reads, and re-annotate that field.';
    case 'SOURCE_ID_EMPTY':
      return 'Mark the card’s link as `作品 id` in the Builder.';
    case 'SOURCE_ID_DUPLICATED':
      return 'The id rule is reading something that repeats; re-mark the field that names the work.';
    case 'ACQUISITION_FAILED':
      return 'Retry; sign in first if the site needs it.';
    case 'ACQUISITION_EMPTY':
      return 'Check the address, or sign in if the site needs it.';
    case 'COVER_FETCH_FAILED':
      return 'Retry; if the site needs a referer or a session, sign in first.';
    case 'BUDGET_EXCEEDED':
      return 'Retry, or probe a single page/work by hand.';
    default:
      return null;
  }
}
