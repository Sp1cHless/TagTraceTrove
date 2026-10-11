import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createImportPreview, type ImportPreview } from './preview.js';
import { loadSiteProbeExport } from './site-probe.js';
import type { ImportBatch } from '@t3/shared';

export interface SiteProbeUploadPreview extends ImportPreview {
  batch: ImportBatch;
}

interface UploadedFileLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function uploadedFile(value: FormDataEntryValue): UploadedFileLike | null {
  if (typeof value === 'string' || typeof value !== 'object' || value === null) return null;
  if (!('size' in value) || typeof value.size !== 'number') return null;
  if (!('arrayBuffer' in value) || typeof value.arrayBuffer !== 'function') return null;
  return value;
}

function safeRelativePath(root: string, candidate: string): string {
  const portable = candidate.replace(/\\/gu, '/').replace(/^\/+/, '');
  if (!portable || portable.split('/').some((part) => part === '..')) {
    throw new Error('Invalid export file path');
  }
  const destination = resolve(root, portable);
  const relativePath = relative(root, destination);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Export file path escapes the upload root');
  }
  return destination;
}

export async function previewSiteProbeUpload(formData: FormData): Promise<SiteProbeUploadPreview> {
  const rootPath = formData.get('rootPath');
  const paths = formData.getAll('paths');
  const files = formData.getAll('files');
  if (typeof rootPath !== 'string' || paths.length === 0 || paths.length !== files.length) {
    throw new Error('Export upload requires one root metadata path and matching JSON files');
  }
  if (paths.some((path) => typeof path !== 'string')) {
    throw new Error('Export upload paths must be text');
  }
  const uploadFiles = files.map(uploadedFile);
  if (uploadFiles.some((file) => file === null)) {
    throw new Error('Export upload contains an invalid file');
  }
  const totalSize = uploadFiles.reduce((total, file) => total + (file?.size ?? 0), 0);
  if (totalSize > 100 * 1024 * 1024 || uploadFiles.some((file) => (file?.size ?? 0) > 20 * 1024 * 1024)) {
    throw new Error('Export metadata upload is too large');
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), 't3-import-preview-'));
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index] as string;
      if (!path.toLocaleLowerCase().endsWith('.json')) continue;
      const destination = safeRelativePath(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, new Uint8Array(await (uploadFiles[index] as UploadedFileLike).arrayBuffer()));
    }
    const batch = await loadSiteProbeExport(safeRelativePath(stagingRoot, rootPath), {
      preserveRelativeMediaPaths: true,
    });
    return { batch, ...createImportPreview(batch) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
