// 차단된 localStorage에서도 앱을 시작할 수 있도록 읽기/쓰기 실패를 격리한다.
export function safeGetStorage(k) {
  try { return localStorage.getItem(k); } catch (_) { return null; }
}
export function safeSetStorage(k, v) {
  try { localStorage.setItem(k, v); } catch (_) {}
}
export function safeRemoveStorage(k) {
  try { localStorage.removeItem(k); } catch (_) {}
}

// 탭별 노드 키를 localStorage와 IndexedDB에 보관한다.
// 저장소 접근에 타임아웃을 두고 새로고침 후 같은 노드 ID를 복원한다.
export function createIdentityStore({ storageKey, dbName, storeName }) {
  function openKeyDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        return reject(new Error("IndexedDB 미지원"));
      }
      const timer = setTimeout(() => reject(new Error("IndexedDB 타임아웃")), 800);
      try {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
        req.onerror = () => { clearTimeout(timer); reject(req.error); };
        req.onblocked = () => { clearTimeout(timer); reject(new Error("IndexedDB blocked")); };
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function loadPersistedKey() {
    const lsVal = safeGetStorage(storageKey);
    if (lsVal) return lsVal;
    try {
      const db = await openKeyDB();
      const idbVal = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 500);
        const tx = db.transaction(storeName, "readonly");
        const getReq = tx.objectStore(storeName).get(storageKey);
        getReq.onsuccess = () => { clearTimeout(timer); resolve(getReq.result || null); };
        getReq.onerror = () => { clearTimeout(timer); resolve(null); };
      });
      if (idbVal) {
        safeSetStorage(storageKey, idbVal);
        return idbVal;
      }
    } catch (_) {}
    return null;
  }

  async function savePersistedKey(hexKey) {
    safeSetStorage(storageKey, hexKey);
    try {
      const db = await openKeyDB();
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 500);
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(hexKey, storageKey);
        tx.oncomplete = () => { clearTimeout(timer); resolve(); };
        tx.onerror = () => { clearTimeout(timer); resolve(); };
      });
    } catch (_) {}
  }

  async function clearPersistedKey() {
    safeRemoveStorage(storageKey);
    try {
      const db = await openKeyDB();
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 500);
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(storageKey);
        tx.oncomplete = () => { clearTimeout(timer); resolve(); };
        tx.onerror = () => { clearTimeout(timer); resolve(); };
      });
    } catch (_) {}
  }

  return { openKeyDB, loadPersistedKey, savePersistedKey, clearPersistedKey };
}
