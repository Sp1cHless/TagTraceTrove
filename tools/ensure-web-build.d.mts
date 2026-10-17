export interface SourceTime { path: string; mtimeMs: number }
export function distTimestamp(root?: string): number | null;
export function collectSourceTimes(root?: string): SourceTime[];
export function decideWebBuild(sources: SourceTime[], distTimeMs: number | null): { build: boolean; reason: string };
