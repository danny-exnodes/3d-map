/**
 * Small persistent key/value cache on IndexedDB with per-entry TTL and an LRU size cap (#9).
 * Works on the main thread and in workers. Every operation degrades to a no-op when
 * IndexedDB is unavailable (private mode, blocked storage) — callers just see cache misses.
 */
const DB_NAME = 'tinymap';
const STORE = 'entries';
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;

interface Entry {
  id: string;
  ns: string;
  value: unknown;
  size: number;
  expires: number;
  lastUsed: number;
  /** Part of an offline package (#18): never expires, never evicted. */
  pinned?: boolean;
  /** Offline packages holding this entry; it stays pinned until the last one lets go. */
  pins?: string[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('lastUsed', 'lastUsed');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(STORE, mode);
          const req = fn(t.objectStore(STORE));
          t.oncomplete = () => resolve(req ? req.result : undefined);
          t.onerror = () => resolve(undefined);
          t.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

/** Rough byte size of a cached value. */
export function sizeOf(v: unknown): number {
  if (typeof v === 'string') return v.length * 2;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  try {
    return JSON.stringify(v).length * 2;
  } catch {
    return 1024;
  }
}

/**
 * Cached value, or undefined when missing or expired. `allowStale` also returns expired entries
 * (used as a fallback when the network is unavailable). Expired entries stay until evicted.
 */
export async function cacheGet<T>(ns: string, key: string, allowStale = false): Promise<T | undefined> {
  const id = `${ns}:${key}`;
  const e = await tx<Entry>('readonly', (s) => s.get(id));
  if (!e) return undefined;
  if (!e.pinned && e.expires < Date.now() && !allowStale) return undefined;
  void tx('readwrite', (s) => s.put({ ...e, lastUsed: Date.now() }));
  return e.value as T;
}

export async function cacheSet(ns: string, key: string, value: unknown, ttlMs: number, size = sizeOf(value), pinned?: boolean): Promise<void> {
  if (size > CACHE_MAX_BYTES / 4) return; // never let one entry evict everything
  const now = Date.now();
  const id = `${ns}:${key}`;
  // Re-fetching a pinned entry keeps it pinned.
  const prev = await tx<Entry>('readonly', (s) => s.get(id));
  const keepPin = pinned ?? prev?.pinned;
  await tx('readwrite', (s) => s.put({ id, ns, value, size, expires: now + ttlMs, lastUsed: now, pinned: keepPin || undefined, pins: prev?.pins } satisfies Entry));
  if (!keepPin) await evict();
}

/**
 * Adds or removes `owner` (an offline package id) on entries. An entry stays pinned while any
 * owner holds it, so packages that share tiles can be deleted independently. Returns the bytes
 * of the entries found.
 */
export async function cachePin(ids: { ns: string; key: string }[], owner: string, pinned: boolean): Promise<number> {
  let bytes = 0;
  for (const { ns, key } of ids) {
    const id = `${ns}:${key}`;
    const e = await tx<Entry>('readonly', (s) => s.get(id));
    if (!e) continue;
    const pins = new Set(e.pins ?? []);
    if (pinned) pins.add(owner);
    else pins.delete(owner);
    await tx('readwrite', (s) => s.put({ ...e, pins: pins.size ? [...pins] : undefined, pinned: pins.size > 0 || undefined, lastUsed: Date.now() }));
    bytes += e.size;
  }
  return bytes;
}

export async function cacheHas(ns: string, key: string): Promise<boolean> {
  return !!(await tx<Entry>('readonly', (s) => s.get(`${ns}:${key}`)));
}

/** Drops expired entries, then least-recently-used ones until under the size cap. */
async function evict() {
  const all = (await tx<Entry[]>('readonly', (s) => s.getAll())) ?? [];
  const now = Date.now();
  let total = 0;
  const drop: string[] = [];
  // Pinned (offline) entries are kept and not counted against the cap.
  for (const e of all.filter((x) => !x.pinned).sort((a, b) => b.lastUsed - a.lastUsed)) {
    if (total + e.size > CACHE_MAX_BYTES || (e.expires < now - 30 * 24 * 3600 * 1000)) drop.push(e.id);
    else total += e.size;
  }
  if (drop.length) await tx('readwrite', (s) => void drop.forEach((id) => s.delete(id)));
}

export async function cacheClear(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}

export async function cacheUsage(): Promise<{ entries: number; bytes: number; pinnedBytes: number }> {
  const all = (await tx<Entry[]>('readonly', (s) => s.getAll())) ?? [];
  return {
    entries: all.length,
    bytes: all.reduce((a, e) => a + e.size, 0),
    pinnedBytes: all.reduce((a, e) => a + (e.pinned ? e.size : 0), 0),
  };
}

/** Clears everything except pinned offline packages. */
export async function cacheClearUnpinned(): Promise<void> {
  const all = (await tx<Entry[]>('readonly', (s) => s.getAll())) ?? [];
  const ids = all.filter((e) => !e.pinned).map((e) => e.id);
  await tx('readwrite', (s) => void ids.forEach((id) => s.delete(id)));
}

/** Test hook: forget the open connection (fake-indexeddb is reset between tests). */
export function _resetCacheForTests() {
  dbPromise = null;
}
