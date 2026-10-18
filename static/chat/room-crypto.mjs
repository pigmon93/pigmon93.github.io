// 방 암호 조회만 주입받아 UI 및 저장소와 분리한다.
// 메시지는 ENCv1 접두사와 AES-GCM IV·암호문으로 구성하며 PBKDF2로 방 키를 유도한다.
export function createRoomCrypto(getRoomPassword, crypto = globalThis.crypto) {
  // Web Crypto API 기반 AES-GCM 256-bit 암복호화 (비밀방 기능)
  const ENC_PREFIX = "ENCv1:";
  const roomKeyCache = new Map();

  async function deriveRoomAesKey(roomName, passphrase) {
    const cacheKey = `${roomName}:::${passphrase}`;
    if (roomKeyCache.has(cacheKey)) {
      return roomKeyCache.get(cacheKey);
    }
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const cryptoKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(`remote-chat-e2ee-salt::${roomName}`),
        iterations: 10000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    roomKeyCache.set(cacheKey, cryptoKey);
    return cryptoKey;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function encryptForRoom(roomName, plainText) {
    const pass = getRoomPassword(roomName);
    if (!pass) return plainText;
    if (!crypto?.subtle) {
      throw new Error("암호화 기능을 사용할 수 없습니다. HTTPS 또는 localhost로 접속하세요.");
    }
    try {
      const key = await deriveRoomAesKey(roomName, pass);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plainText);
      const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
      const cipherBytes = new Uint8Array(cipherBuf);
      return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(cipherBytes)}`;
    } catch (_) {
      throw new Error("암호화에 실패하여 전송을 차단했습니다.");
    }
  }

  async function decryptForRoom(roomName, rawText) {
    if (typeof rawText !== "string" || !rawText.startsWith(ENC_PREFIX)) {
      return { encrypted: false, locked: false, text: rawText };
    }
    const pass = getRoomPassword(roomName);
    if (!pass || !crypto?.subtle) {
      return {
        encrypted: true,
        locked: true,
        text: "🔒 암호화된 메시지입니다. 설정의 [🔒 비밀방 암호]에서 비밀번호를 입력하면 복호화됩니다.",
      };
    }
    try {
      const payload = rawText.slice(ENC_PREFIX.length);
      const [ivB64, cipherB64] = payload.split(":");
      const iv = base64ToBytes(ivB64);
      const cipherBytes = base64ToBytes(cipherB64);
      const key = await deriveRoomAesKey(roomName, pass);
      const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
      const decoded = new TextDecoder().decode(plainBuf);
      return { encrypted: true, locked: false, text: decoded };
    } catch (_) {
      return {
        encrypted: true,
        locked: true,
        text: "🔒 암호가 일치하지 않아 복호화할 수 없는 메시지입니다.",
      };
    }
  }

  return { encryptForRoom, decryptForRoom, roomKeyCache };
}
