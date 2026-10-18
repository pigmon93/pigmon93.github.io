import { HISTORY_TTL_MS, isWithinOneDay } from './history-policy.mjs';

export const HISTORY_DB_NAME = 'remote_chat_history_db';
const STORE = 'batches';
const HOUR_MS = 60 * 60 * 1000;

export async function encodeHistory(records) {
  const json = new TextEncoder().encode(JSON.stringify(records));
  if (typeof CompressionStream === 'undefined') {
    throw new Error('이 브라우저는 gzip 압축을 지원하지 않습니다. 브라우저를 업데이트하세요.');
  }
  const payload = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { encoding: 'gzip', payload };
}

export async function decodeHistory(row) {
  if (row.encoding !== 'gzip') throw new Error('지원하지 않는 대화 저장 형식입니다.');
  const json = await new Response(new Blob([row.payload]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const records = JSON.parse(json);
  if (!Array.isArray(records)) throw new Error('대화 저장 데이터가 손상되었습니다.');
  return records;
}

function validRecords(records, now) {
  return records.filter(record => record && typeof record.id === 'string' &&
    typeof record.text === 'string' && isWithinOneDay(record.ts, now));
}

// Append immutable batches rather than overwriting room snapshots: concurrent tabs
// cannot replace each other's messages. The UI deduplicates records by message ID.
export class CompressedHistoryStore {
  constructor({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange,
    now = () => Date.now(),
    encode = encodeHistory, decode = decodeHistory, dbName = HISTORY_DB_NAME } = {}) {
    Object.assign(this, { indexedDB, keyRange, now, encode, decode, dbName });
    this.db = null;
    this.tail = Promise.resolve();
    this.pending = new Map();
    this.known = new Map();
    this.flushing = null;
    this.stopped = false;
  }

  async open() {
    if (this.db) return;
    if (!this.indexedDB) throw new Error('IndexedDB를 사용할 수 없습니다.');
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('room', 'room');
        store.createIndex('expiresAt', 'expiresAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('대화 저장소가 다른 탭에 의해 차단되었습니다.'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
  }

  transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      let request;
      try { request = action(tx.objectStore(STORE)); }
      catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || new Error('대화 저장 실패'));
      tx.onabort = () => reject(tx.error || new Error('대화 저장 중단'));
    });
  }

  enqueue(action) {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  async load() {
    await this.open();
    await this.prune();
    const rooms = new Map();
    const add = (room, records) => {
      if (!rooms.has(room)) rooms.set(room, new Map());
      for (const record of records) rooms.get(room).set(record.id, record);
    };
    for (const row of await this.transaction('readonly', store => store.getAll())) {
      const records = validRecords(await this.decode(row), this.now());
      add(row.room, records);
      if (!this.known.has(row.room)) this.known.set(row.room, new Set());
      for (const record of records) this.known.get(row.room).add(record.id);
    }
    return rooms;
  }

  append(room, records) {
    if (this.stopped) return Promise.resolve();
    if (!this.pending.has(room)) this.pending.set(room, new Map());
    const known = this.known.get(room);
    for (const record of validRecords(records, this.now())) {
      if (!known?.has(record.id)) this.pending.get(room).set(record.id, record);
    }
    return this.flush();
  }

  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.enqueue(async () => {
      while (this.pending.size && !this.stopped) {
        const [room, pending] = this.pending.entries().next().value;
        const records = validRecords([...pending.values()], this.now());
        const groups = new Map();
        for (const record of records) {
          const hour = Math.floor(record.ts / HOUR_MS);
          if (!groups.has(hour)) groups.set(hour, []);
          groups.get(hour).push(record);
        }
        const rows = [];
        for (const batch of groups.values()) {
          rows.push({ room, expiresAt: batch.reduce((min, item) => Math.min(min, item.ts), Infinity) + HISTORY_TTL_MS,
            ...await this.encode(batch) });
        }
        if (this.stopped) return;
        if (rows.length) await this.transaction('readwrite', store => {
          for (const row of rows) store.add(row);
        });
        if (!this.known.has(room)) this.known.set(room, new Set());
        for (const record of records) {
          this.known.get(room).add(record.id);
          if (pending.get(record.id) === record) pending.delete(record.id);
        }
        for (const [id, record] of pending) if (!isWithinOneDay(record.ts, this.now())) pending.delete(id);
        if (!pending.size) this.pending.delete(room);
      }
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  prune() {
    return this.enqueue(async () => {
      const rows = await this.transaction('readonly', store => store.index('expiresAt').getAll(this.keyRange.upperBound(this.now())));
      for (const row of rows) {
        const old = await this.decode(row);
        const fresh = validRecords(old, this.now());
        const encoded = fresh.length ? await this.encode(fresh) : null;
        await this.transaction('readwrite', store => fresh.length
          ? store.put({ ...row, ...encoded, expiresAt: fresh.reduce((min, item) => Math.min(min, item.ts), Infinity) + HISTORY_TTL_MS })
          : store.delete(row.id));
        const retained = new Set(fresh.map(item => item.id));
        for (const record of old) if (!retained.has(record.id)) this.known.get(row.room)?.delete(record.id);
      }
    });
  }

  clearRoom(room) {
    this.pending.delete(room);
    return this.enqueue(async () => {
      await this.transaction('readwrite', store => {
        const request = store.index('room').openKeyCursor(this.keyRange.only(room));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
        };
      });
      this.known.delete(room);
    });
  }

  async clear() {
    this.stopped = true;
    this.pending.clear();
    await this.tail;
    await this.transaction('readwrite', store => store.clear());
    this.known.clear();
  }
}
