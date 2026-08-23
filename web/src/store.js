// Map data is too big for localStorage, so it lives in IndexedDB and survives a reload.

const DB = "birdseye";
const STORE = "mapdata";
const KEY = "current";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, act) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = act(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/** `{ osm, area }` for the current event (the Overpass text and the hull it covers), or null. Never throws: storage is a convenience. */
export async function loadMapData() {
  try {
    return (await transact("readonly", (store) => store.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function saveMapData(data) {
  try {
    await transact("readwrite", (store) => (data ? store.put(data, KEY) : store.delete(KEY)));
  } catch {
    // Private mode or a full disk: the next reload just refetches.
  }
}
