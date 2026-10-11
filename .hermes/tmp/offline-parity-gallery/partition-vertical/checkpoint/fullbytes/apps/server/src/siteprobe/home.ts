import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SiteprobeStatus } from '@t3/shared';

/**
 * Where the local SiteProbe tool is, and which interpreter runs it.
 *
 * Two paths have to be right before anything else can work, and neither is knowable from inside
 * this package:
 *
 * * **the tool**, a Python checkout that lives in the repository (`<repo>/siteprobe/`) and reads
 *   its adapters from user data. It is found by walking up from this module until a directory holds
 *   `siteprobe/integration.py`, which is the same whether the server runs from `src/` (tsx, what
 *   `T3.bat` does) or from `dist/`, and needs no build-time constant;
 * * **the interpreter**: the tool's own virtualenv, because the general layer's dependencies
 *   (curl_cffi, playwright, Pillow) are installed there and a system Python would fail at the first
 *   fetch. When it is missing the status says so and names the fix, rather than failing later with
 *   an ImportError nobody can act on.
 *
 * The home is `<T3_DATA_DIR>/siteprobe` — the directory the tool itself resolves from the same
 * setting (`registry.adapter_root`, guidance §34), passed explicitly here so a T³-launched run and
 * a double-clicked batch file use one home.
 */
export interface SiteprobeTooling {
  /** The checkout holding `integration.py`. */
  tool: string;
  /** The interpreter that runs it. */
  python: string;
  /**
   * Everything between the interpreter and the tool's own arguments: the entry script, and for a
   * test, a stub that answers with the contract instead of a virtualenv. Defaults to the tool's own
   * door; measured, leaving it empty makes Python read the command as a script name.
   */
  pythonArgs: string[];
  /** The same, for the Level 0 one-link reader (`fetch_work_meta.py`). */
  linkArgs: string[];
  /** The same, for the adapter builder (`build_adapter.py`). */
  buildArgs: string[];
  /** The same, for the *listing* adapter builder (`build_listing.py`). */
  listingArgs: string[];
  /** The tool's writable home (adapters, exports, sessions). */
  home: string;
  ok: boolean;
  detail: string | null;
}

export interface SiteprobeToolingOverrides {
  tool?: string;
  python?: string;
  pythonArgs?: string[];
  linkArgs?: string[];
  buildArgs?: string[];
  listingArgs?: string[];
  home?: string;
}

/**
 * The script the interpreter runs. The tool's own door for this contract, and the file whose
 * presence *is* the tool (`TOOL_MARKER`): a real run is `python integration.py <command>`, which
 * measured is not optional — spawning `python <command>` makes Python read the command as a script
 * name, and it fails with "can't open file '…/resolve'".
 */
const TOOL_ENTRY = 'integration.py';
/**
 * The Level 0 one-link reader: paste a URL, get a title and a cover with no site rule at all.
 * A different script on the same tool, so it gets its own argv prefix rather than a second entry
 * point being invented for it.
 */
const LINK_ENTRY = 'fetch_work_meta.py';

const TOOL_MARKER = join('siteprobe', TOOL_ENTRY);
/** Enough for `apps/server/dist/src/siteprobe` and for a checkout launched from anywhere. */
const SEARCH_DEPTH = 6;

export function findToolDirectory(start: string): string | null {
  let directory = resolve(start);
  for (let depth = 0; depth < SEARCH_DEPTH; depth += 1) {
    for (const prefix of ['', '..']) {
      const candidate = resolve(directory, prefix);
      const marker = join(candidate, TOOL_MARKER);
      if (existsSync(marker) && statSync(marker).isFile()) {
        return join(candidate, 'siteprobe');
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function interpreterCandidates(tool: string): string[] {
  return [
    join(tool, '.venv', 'Scripts', 'python.exe'),
    join(tool, '.venv', 'bin', 'python'),
  ];
}

export function resolveSiteprobeTooling(options: {
  dataDir: string;
  overrides?: SiteprobeToolingOverrides;
  env?: NodeJS.ProcessEnv;
  /** Where to start looking for the checkout; the module's own location by default. */
  from?: string;
}): SiteprobeTooling {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};
  const home = overrides.home ?? env.SITEPROBE_HOME ?? join(options.dataDir, 'siteprobe');
  const pythonArgs = overrides.pythonArgs ?? [TOOL_ENTRY];
  const buildArgs = overrides.buildArgs ?? ['build_adapter.py'];
  const listingArgs = overrides.listingArgs ?? ['build_listing.py'];
  const linkArgs = overrides.linkArgs ?? [LINK_ENTRY];
  const tool = overrides.tool ?? env.T3_SITEPROBE_TOOL
    ?? findToolDirectory(options.from ?? dirname(fileURLToPath(import.meta.url)));

  if (!tool) {
    return {
      tool: '', python: '', pythonArgs, linkArgs, buildArgs, listingArgs, home, ok: false,
      detail: 'the SiteProbe tool was not found in this checkout '
        + '(no siteprobe/integration.py above the server package)',
    };
  }
  const python = overrides.python ?? env.SITEPROBE_PYTHON
    ?? interpreterCandidates(tool).find((candidate) => existsSync(candidate)) ?? '';
  if (!python) {
    return {
      tool, python: '', pythonArgs, linkArgs, buildArgs, listingArgs, home, ok: false,
      detail: `no interpreter in ${join(tool, '.venv')}; run \`uv sync --extra browser --extra media\` `
        + 'in the siteprobe directory once',
    };
  }
  return { tool, python, pythonArgs, linkArgs, buildArgs, listingArgs, home, ok: true, detail: null };
}

export function siteprobeStatus(tooling: SiteprobeTooling): SiteprobeStatus {
  return {
    ok: tooling.ok,
    home: tooling.home,
    tool: tooling.tool,
    python: tooling.python,
    detail: tooling.detail,
  };
}
