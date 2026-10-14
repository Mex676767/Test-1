// Saved results of earlier searches, so the next search is faster. Kept in this browser only (IndexedDB; a plain in-memory copy when
// IndexedDB is not available, e.g. a private window or the tests). Every entry has an expiry; the QA page empties it on sign-out.
// Nothing here ever reaches a server.
const DB_NAME = "qa-saved-results";
const STORE = "results";

export function createCache({ useDb = true, now = Date.now } = {}) {
  const memory = new Map();
  let dbPromise = null;

  function openDb() {
    if (!useDb || typeof indexedDB === "undefined") return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => request.result.createObjectStore(STORE);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }
    return dbPromise;
  }

  // One IndexedDB request as a promise; any failure answers undefined / false so the search just reads everything again.
  async function withStore(mode, action) {
    const db = await openDb();
    if (!db) return { unavailable: true };
    return new Promise((resolve) => {
      try {
        const request = action(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve({ value: request.result });
        request.onerror = () => resolve({ failed: true });
      } catch (_) { resolve({ failed: true }); }
    });
  }

  return {
    // The saved value, or undefined when there is none or it has expired.
    async get(key) {
      const answer = await withStore("readonly", (store) => store.get(key));
      const record = answer.unavailable ? memory.get(key) : answer.value;
      if (!record || record.expires <= now()) return undefined;
      return structuredClone(record.value);
    },
    async set(key, value, ttlMs) {
      const record = { value: structuredClone(value), expires: now() + ttlMs };
      const answer = await withStore("readwrite", (store) => store.put(record, key));
      if (answer.unavailable || answer.failed) memory.set(key, record);
    },
    async clear() {
      memory.clear();
      await withStore("readwrite", (store) => store.clear());
    },
  };
}
