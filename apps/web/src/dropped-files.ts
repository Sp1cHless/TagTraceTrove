interface DroppedFileEntry {
  name: string;
  isFile: true;
  isDirectory: false;
  file(success: (file: File) => void, error?: (cause: DOMException) => void): void;
}

interface DroppedDirectoryReader {
  readEntries(
    success: (entries: DroppedEntry[]) => void,
    error?: (cause: DOMException) => void,
  ): void;
}

interface DroppedDirectoryEntry {
  name: string;
  isFile: false;
  isDirectory: true;
  createReader(): DroppedDirectoryReader;
}

type DroppedEntry = DroppedFileEntry | DroppedDirectoryEntry;
interface ChromiumDataTransferItem {
  webkitGetAsEntry?: () => DroppedEntry | null;
}

function fileFromEntry(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectory(reader: DroppedDirectoryReader): Promise<DroppedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: DroppedEntry[] = [];
    const readNext = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readNext();
      }, reject);
    };
    readNext();
  });
}

function withRelativePath(file: File, relativePath: string): File {
  const droppedFile = new File([file], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
  Object.defineProperty(droppedFile, 'webkitRelativePath', {
    configurable: true,
    value: relativePath,
  });
  return droppedFile;
}

async function expandEntry(entry: DroppedEntry, parentPath = ''): Promise<File[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) return [withRelativePath(await fileFromEntry(entry), relativePath)];

  const children = await readDirectory(entry.createReader());
  const files = await Promise.all(children.map((child) => expandEntry(child, relativePath)));
  return files.flat();
}

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item as unknown as ChromiumDataTransferItem).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is DroppedEntry => entry !== null);
  if (entries.length === 0) return Array.from(dataTransfer.files);

  return (await Promise.all(entries.map((entry) => expandEntry(entry)))).flat();
}
