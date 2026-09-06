import type { Folder, Project } from "../types";

const DATABASE_NAME = "frame-studio";
const DATABASE_VERSION = 1;
const PROJECTS = "projects";
const FOLDERS = "folders";
const VIDEOS = "videos";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "This browser does not support local video storage. Try a current version of Chrome, Edge, or Firefox.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      const projects = database.createObjectStore(PROJECTS, { keyPath: "id" });
      projects.createIndex("folderId", "folderId");
      database.createObjectStore(FOLDERS, { keyPath: "id" });
      database.createObjectStore(VIDEOS, { keyPath: "id" });
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          "Local storage is open in another version of Frame. Close other Frame tabs and try again.",
        ),
      );
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function storageError(error: DOMException | Error | null): Error {
  if (error?.name === "QuotaExceededError") {
    return new Error(
      "Your browser storage is full. Download and delete an older recording, then try saving again.",
    );
  }
  return (
    error ??
    new Error(
      "The video could not be saved to browser storage. Please try again.",
    )
  );
}

/** A result is returned only after the complete transaction has committed. */
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction, setResult: (value: T) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = database.transaction(stores, mode);
    } catch (error) {
      database.close();
      reject(storageError(error instanceof Error ? error : null));
      return;
    }
    let result: T;
    let operationError: Error | null = null;
    tx.oncomplete = () => {
      database.close();
      resolve(result);
    };
    tx.onabort = () => {
      database.close();
      reject(storageError(operationError ?? tx.error));
    };
    // Requests bubble their error to the transaction, whose abort rolls back all writes.
    tx.onerror = () => {
      operationError ??= tx.error;
    };
    try {
      operation(tx, (value) => {
        result = value;
      });
    } catch (error) {
      operationError =
        error instanceof Error ? error : new Error(String(error));
      tx.abort();
    }
  });
}

export function listProjects(): Promise<Project[]> {
  return transaction([PROJECTS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(PROJECTS).getAll();
    request.onsuccess = () =>
      setResult(
        (request.result as Project[]).sort((a, b) => b.updatedAt - a.updatedAt),
      );
  });
}

export function listFolders(): Promise<Folder[]> {
  return transaction([FOLDERS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(FOLDERS).getAll();
    request.onsuccess = () =>
      setResult(
        (request.result as Folder[]).sort((a, b) => a.createdAt - b.createdAt),
      );
  });
}

export function saveProject(project: Project, blob?: Blob): Promise<void> {
  return transaction([PROJECTS, VIDEOS], "readwrite", (tx) => {
    tx.objectStore(PROJECTS).put(project);
    if (blob !== undefined)
      tx.objectStore(VIDEOS).put({ id: project.id, blob });
  });
}

export function getProjectBlob(id: string): Promise<Blob | undefined> {
  return transaction([VIDEOS], "readonly", (tx, setResult) => {
    const request = tx.objectStore(VIDEOS).get(id);
    request.onsuccess = () =>
      setResult(request.result?.blob as Blob | undefined);
  });
}

export function deleteProject(id: string): Promise<void> {
  return transaction([PROJECTS, VIDEOS], "readwrite", (tx) => {
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(VIDEOS).delete(id);
  });
}

export function saveFolder(folder: Folder): Promise<void> {
  return transaction([FOLDERS], "readwrite", (tx) => {
    tx.objectStore(FOLDERS).put(folder);
  });
}

/** Removing a folder preserves its recordings and moves them to the root workspace. */
export function deleteFolder(id: string): Promise<void> {
  return transaction([FOLDERS, PROJECTS], "readwrite", (tx) => {
    tx.objectStore(FOLDERS).delete(id);
    const request = tx
      .objectStore(PROJECTS)
      .index("folderId")
      .openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.update({ ...(cursor.value as Project), folderId: null });
      cursor.continue();
    };
  });
}

export async function getStorageUsage(): Promise<{
  usage: number;
  quota: number;
}> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate)
    return { usage: 0, quota: 0 };
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist)
    return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}
