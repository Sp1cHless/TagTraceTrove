import { z } from 'zod';
import type { SiteprobeLinkMeta } from '@t3/shared';

import type { SiteprobeTooling } from './home.js';
import { runSiteprobeJson } from './transport.js';
import { writeSiteprobeErrorLog } from './log.js';

/**
 * One pasted link, read with no site rule at all — the Level 0 reader behind `通用单条链接`.
 *
 * It answers the two fields that survive with no rule anywhere (measured: title 7/7, cover 7/7
 * across seven unrelated work pages), which is exactly what the quick-create form wants and
 * nothing more. A known site's adapter could also fill tags and an author; that is what the
 * advanced path is for, and the failure message says so.
 *
 * Nothing is written on either side. The tool reads the page, keeps the cover's bytes in its answer
 * (`cover_base64`), and deletes the scratch directory it downloaded them into; this hands the browser
 * a data URL, and the page turns that into an ordinary chosen file. The reason is the same on both
 * sides: the export document was the handover medium, and once a link can be read straight into the
 * Entry there is no handover left to leave a folder behind for.
 */
const documentSchema = z.object({
  input_url: z.string(),
  source_url: z.string().nullable().optional(),
  outcome: z.string(),
  kind: z.string(),
  detail: z.string().optional(),
  title: z.string().nullable().optional(),
  cover_base64: z.string().nullable().optional(),
  cover_mime: z.string().nullable().optional(),
  cover_bytes: z.number().int().nonnegative().nullable().optional(),
});

/** The reader's `kind` → what the person should do about it. */
const VERDICTS: Record<string, SiteprobeLinkMeta['verdict']> = {
  found: 'found',
  // The page needs a rule, a session or another attempt: all four are "the simple reader could not
  // read this, and the advanced path is the way in" — never a bug in T³.
  insufficient: 'needs-advanced',
  teaching: 'needs-advanced',
  retryable: 'needs-advanced',
  blocked: 'needs-advanced',
  // The caller pasted something that is not an http(s) URL.
  invalid: 'invalid',
};

export interface LinkMetaDependencies {
  tooling: SiteprobeTooling;
  dataDir: string;
}

export async function readLinkMeta(url: string, dependencies: LinkMetaDependencies): Promise<SiteprobeLinkMeta> {
  const { tooling, dataDir } = dependencies;
  if (!tooling.ok) {
    throw new Error(tooling.detail ?? 'the SiteProbe tool is unavailable');
  }
  const empty = {
    verdict: 'bug' as const,
    outcome: null,
    detail: null,
    title: null,
    coverDataUrl: null,
    coverMimeType: null,
    coverBytes: null,
    logPath: null,
  };

  let result;
  try {
    result = await runSiteprobeJson(tooling, [url]);
  } catch (error) {
    // The process could not even start: that is this server's fault, not the page's, and it is
    // exactly the case a person should report.
    const logPath = await writeSiteprobeErrorLog(dataDir, {
      kind: 'link-meta',
      context: { url },
      error,
      environment: { tool: tooling.tool, python: tooling.python, home: tooling.home },
    });
    return { ...empty, detail: (error as Error).message, logPath };
  }

  const document = result.documents.map((value) => documentSchema.safeParse(value))
    .find((parsed) => parsed.success)?.data;
  if (!document) {
    const logPath = await writeSiteprobeErrorLog(dataDir, {
      kind: 'link-meta',
      context: { url, exitCode: result.code, stdoutLines: result.documents.length, raw: result.raw },
      ...(result.stderr ? { stderr: result.stderr } : {}),
      code: result.code,
      environment: { tool: tooling.tool, python: tooling.python, home: tooling.home },
    });
    return {
      ...empty,
      detail: result.timedOut
        ? 'The reader did not finish in time.'
        : 'The reader produced no verdict this server understands.',
      logPath,
    };
  }

  const verdict = VERDICTS[document.kind] ?? 'needs-advanced';
  const mime = document.cover_mime ?? 'image/jpeg';
  if (verdict !== 'found' || !document.cover_base64) {
    return {
      verdict,
      outcome: document.outcome,
      detail: document.detail ?? null,
      title: document.title ?? null,
      coverDataUrl: null,
      coverMimeType: null,
      coverBytes: null,
      logPath: null,
    };
  }
  return {
    verdict: 'found',
    outcome: document.outcome,
    detail: document.detail ?? null,
    title: document.title ?? null,
    coverDataUrl: `data:${mime};base64,${document.cover_base64}`,
    coverMimeType: mime,
    coverBytes: document.cover_bytes ?? null,
    logPath: null,
  };
}
