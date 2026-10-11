/**
 * The desktop's own low-level endpoints.
 *
 * These are deliberately not part of `GalleryApi`: nothing here is a library read that can be
 * served from an offline copy, and every one of them is about the machine T³ is running on.
 * They are called directly so the shape of the library API — and the offline facade that
 * mirrors it — stays untouched.
 */

export interface SystemDiagnostics {
  logPath: string;
  logBytes: number;
  logTruncated: boolean;
  logTail: string;
  dataDir: string;
  databasePath: string | null;
  backupsDir: string;
  backupCount: number;
  settings: SystemSettings;
  settingsPath: string;
  settingsProblem: string | null;
  stagedRestore: StagedRestore | null;
  nodeVersion: string;
  platform: string;
}

export interface SystemSettings {
  autoAllowMobileConnection: boolean;
}

export interface StagedRestore {
  stagedAt: string;
  bytes: number;
  entryCount: number | null;
  producerCount: number | null;
  schemaVersion: number | null;
}

export interface BackupEntry {
  name: string;
  createdAt: string;
  bytes: number;
  entryCount: number | null;
  producerCount: number | null;
  schemaVersion: number | null;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export async function fetchSystemDiagnostics(): Promise<SystemDiagnostics> {
  return requestJson<SystemDiagnostics>('/api/system/diagnostics');
}

export async function fetchSystemSettings(): Promise<SystemSettings> {
  const body = await requestJson<{ settings: SystemSettings }>('/api/system/settings');
  return body.settings;
}

export async function saveSystemSettings(settings: SystemSettings): Promise<SystemSettings> {
  const body = await requestJson<{ settings: SystemSettings }>('/api/system/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return body.settings;
}

export async function fetchBackups(): Promise<BackupEntry[]> {
  const body = await requestJson<{ backups: BackupEntry[] }>('/api/system/backups');
  return body.backups;
}

export async function createBackup(): Promise<BackupEntry> {
  const body = await requestJson<{ backup: BackupEntry }>('/api/system/backups', { method: 'POST' });
  return body.backup;
}

export async function removeBackup(name: string): Promise<void> {
  await requestJson<{ removed: string }>(`/api/system/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** A backup downloads as the database file itself: the browser saves it wherever it is set to. */
export async function downloadBackup(name: string): Promise<void> {
  const response = await fetch(`/api/system/backups/${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the blob goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function stageRestore(file: File): Promise<{ staged: StagedRestore; restartRequired: boolean }> {
  const form = new FormData();
  form.set('file', file);
  return requestJson<{ staged: StagedRestore; restartRequired: boolean }>('/api/system/restore', {
    method: 'POST',
    body: form,
  });
}
