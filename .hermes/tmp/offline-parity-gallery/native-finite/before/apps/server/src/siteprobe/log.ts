import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The error log a person can hand back.
 *
 * Until now a tool fault reached the browser as a sentence and nothing else was kept: the child
 * process's stderr was read into a string, shown once, and lost with the response. That is enough
 * to *see* a bug and not enough to *report* one — the one thing a report needs is the evidence, and
 * the evidence (the tool's own diagnostics, the argv, the exact moment) lives on the server.
 *
 * So a fault writes one file under `<dataDir>/logs/` and the UI names it. Deliberately plain text
 * and deliberately complete: whoever reads it has the machine, but not the session.
 */
export interface SiteprobeLogInput {
  /** Which door failed: `link-meta`, `run`, `preview-path`, … */
  kind: string;
  /** What the person was doing, as data they can recognise (the URL, the site, the selection). */
  context: Record<string, unknown>;
  /** The tool's own stderr, as far as it was read. */
  stderr?: string;
  /** The tool's exit code, when it ran at all. */
  code?: number | null;
  /** The fault this server raised, when the fault was here rather than in the tool. */
  error?: unknown;
  /** Paths and versions that make the report reproducible. */
  environment: { tool: string; python: string; home: string; appVersion?: string };
}

/** Old logs are pruned so a long-lived fault cannot fill the data root. */
const KEEP_LOGS = 30;

function stamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/u, 'Z');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim();
  }
  return String(error);
}

export async function writeSiteprobeErrorLog(dataDir: string, input: SiteprobeLogInput): Promise<string> {
  const directory = join(dataDir, 'logs');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `siteprobe-${input.kind}-${stamp()}.log`);
  const lines = [
    `# T³ SiteProbe error log`,
    `time        ${new Date().toISOString()}`,
    `kind        ${input.kind}`,
    `tool        ${input.environment.tool}`,
    `python      ${input.environment.python}`,
    `home        ${input.environment.home}`,
    ...(input.environment.appVersion ? [`app         ${input.environment.appVersion}`] : []),
    `exit code   ${input.code ?? '(none)'}`,
    '',
    '## context',
    JSON.stringify(input.context, null, 2),
    '',
    '## tool stderr',
    input.stderr?.trim() ? input.stderr.trim() : '(empty)',
    ...(input.error === undefined ? [] : ['', '## server error', describe(input.error)]),
    '',
  ];
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  await pruneLogs(directory);
  return path;
}

async function pruneLogs(directory: string): Promise<void> {
  try {
    const entries = (await readdir(directory)).filter((name) => name.startsWith('siteprobe-'));
    if (entries.length <= KEEP_LOGS) return;
    const dated = await Promise.all(entries.map(async (name) => ({
      name,
      at: (await stat(join(directory, name))).mtimeMs,
    })));
    dated.sort((left, right) => right.at - left.at);
    for (const stale of dated.slice(KEEP_LOGS)) {
      await unlink(join(directory, stale.name));
    }
  } catch {
    // Pruning is housekeeping: a failure here must never turn a reported bug into a second error.
  }
}
