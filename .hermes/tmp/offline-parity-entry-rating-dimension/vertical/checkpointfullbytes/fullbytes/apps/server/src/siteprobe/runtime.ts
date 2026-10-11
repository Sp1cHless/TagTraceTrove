import { createSiteprobeJobStore, type SiteprobeJobStore } from './jobs.js';
import { resolveSiteprobeTooling, type SiteprobeTooling, type SiteprobeToolingOverrides } from './home.js';

/**
 * The SiteProbe half of the server: where the tool is, and the runs in flight.
 *
 * One object rather than two so that the process can be shut down properly. A run is a child
 * process, and a child outlives its parent by default — closing this is what stops a crawl the
 * person cancelled by closing T³'s window, instead of leaving a Python process writing into their
 * export tree with nothing watching it.
 */
export interface SiteprobeRuntime {
  tooling: SiteprobeTooling;
  jobs: SiteprobeJobStore;
  close(): void;
}

export function createSiteprobeRuntime(options: {
  dataDir: string;
  overrides?: SiteprobeToolingOverrides;
  env?: NodeJS.ProcessEnv;
}): SiteprobeRuntime {
  const tooling = resolveSiteprobeTooling({
    dataDir: options.dataDir,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const jobs = createSiteprobeJobStore({ tooling, dataDir: options.dataDir });
  return {
    tooling,
    jobs,
    close(): void {
      jobs.close();
    },
  };
}
