export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
export function isWithinOneDay(ts, now = Date.now()) {
  return Number.isFinite(ts) && ts <= now && now - ts < HISTORY_TTL_MS;
}

// Small frames keep JSON escaping and signature overhead below gossip's 4096-byte limit.
export function* historyFrames(records) {
  for (const record of records) {
    if (!isWithinOneDay(record.ts)) continue;
    const text = JSON.stringify(record);
    const total = Math.ceil(text.length / 256);
    for (let index = 0; index < total; index++) {
      yield JSON.stringify({ v: 1, id: record.id, index, total, text: text.slice(index * 256, (index + 1) * 256) });
    }
  }
}

export class HistoryAssembler {
  pending = new Map();
  accept(raw, peer, room) {
    const now = Date.now();
    for (const [key, value] of this.pending) {
      if (now - value.created >= 60000) this.pending.delete(key);
    }
    const frame = JSON.parse(raw);
    // 현재 프레임 객체만 수신한다. 배열 기록과 다른 형식은 무시한다.
    if (!frame || Array.isArray(frame) || frame.v !== 1 || typeof frame.id !== 'string' || frame.id.length > 200 ||
        !Number.isInteger(frame.index) || !Number.isInteger(frame.total) ||
        frame.total < 1 || frame.total > 256 || frame.index < 0 || frame.index >= frame.total ||
        typeof frame.text !== 'string' || frame.text.length > 256) return [];
    const key = JSON.stringify([peer, room, frame.id]);
    if (!this.pending.has(key)) {
      if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value);
      this.pending.set(key, { created: now, total: frame.total, parts: new Map() });
    }
    const entry = this.pending.get(key);
    if (entry.total !== frame.total) return [];
    entry.parts.set(frame.index, frame.text);
    if (entry.parts.size !== entry.total) return [];
    this.pending.delete(key);
    const record = JSON.parse(Array.from({ length: entry.total }, (_, i) => entry.parts.get(i)).join(''));
    return record.id === frame.id && isWithinOneDay(record.ts, now) ? [record] : [];
  }
}
