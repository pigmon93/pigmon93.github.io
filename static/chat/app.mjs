// 앱 진입점: 방 상태와 네트워크 이벤트의 순서를 조율한다.
import { toggleSidebar } from "./settings.mjs";
import { createRoomCrypto } from "./room-crypto.mjs";
import { createIdentityStore, safeGetStorage, safeSetStorage, safeRemoveStorage } from "./identity-store.mjs";
import { escapeHtml, formatRichChatHtml, formatBytes, formatTimeFromTs, avatarGradient, avatarInitials, isImageFile } from "./message-view.mjs";
import { DEFAULT_RELAY_URL, normalizeRelayUrl, selectRelayUrl } from "./relay-config.mjs";
import { historyFrames, HistoryAssembler } from "./history-policy.mjs";
import { CompressedHistoryStore } from "./history-store.mjs";
const CACHE_BUSTER = Date.now();
const { default: init, WebChatNode } = await import(`./pkg/remote_chat.js?t=${CACHE_BUSTER}`);

if (!window.name || !window.name.startsWith("rc_tab_")) {
  window.name = "rc_tab_" + Math.random().toString(36).slice(2, 8);
}
const tabId = window.name;
const STORAGE_KEY = `remote_chat_secret_key_${tabId}`;
const STORAGE_NICK_KEY = `remote_chat_nickname_${tabId}`;
const STORAGE_ROOMS_KEY = "remote_chat_known_rooms_v2";
const IDB_NAME = "remote_chat_db";
const IDB_STORE = "keys";

const RELAY_STORAGE_KEY = "remote_chat_relay_url";
let activeRelayUrl = null;
const relayInput = document.getElementById("relay-url-input");
const relayStatus = document.getElementById("relay-settings-status");
const requestedRelay = new URLSearchParams(window.location.search).get("relay");
relayInput.value = requestedRelay ?? safeGetStorage(RELAY_STORAGE_KEY) ?? DEFAULT_RELAY_URL;
document.getElementById("relay-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const relay = normalizeRelayUrl(relayInput.value);
    localStorage.setItem(RELAY_STORAGE_KEY, relay);
    const url = new URL(window.location.href);
    url.searchParams.delete("relay");
    window.location.replace(url.href);
  } catch (err) {
    relayStatus.textContent = `설정 실패: ${err.message}`;
  }
});

const { openKeyDB, loadPersistedKey, savePersistedKey } = createIdentityStore({
  storageKey: STORAGE_KEY, dbName: IDB_NAME, storeName: IDB_STORE,
});

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const notifyBtn = document.getElementById("notify-btn");
const copyLinkBtn = document.getElementById("copy-link-btn");
const clearChatBtn = document.getElementById("clear-chat-btn");
const secretRoomBtn = document.getElementById("secret-room-btn");
const secretRoomBar = document.getElementById("secret-room-bar");
const roomPassInput = document.getElementById("room-pass-input");
const applyRoomPassBtn = document.getElementById("apply-room-pass-btn");
const clearRoomPassBtn = document.getElementById("clear-room-pass-btn");
const e2eeBadge = document.getElementById("e2ee-badge");
const onlineMemberCountEl = document.getElementById("online-member-count");
const onlineMembersListEl = document.getElementById("online-members-list");
const typingBarEl = document.getElementById("typing-bar");
const scopeSubtitleEl = document.getElementById("scope-subtitle");
const currentRoomLabel = document.getElementById("current-room-label");
const keyStateEl = document.getElementById("key-state");
const myIdEl = document.getElementById("my-id");
const myAvatarEl = document.getElementById("my-avatar");
const resetKeyBtn = document.getElementById("reset-key-btn");
const nameInput = document.getElementById("name-input");
const setNameBtn = document.getElementById("set-name-btn");
const newRoomInput = document.getElementById("new-room-input");
const createRoomBtn = document.getElementById("create-room-btn");
const roomListEl = document.getElementById("room-list");
const roomCountBadge = document.getElementById("room-count-badge");
const chatLog = document.getElementById("chat-log");
const chatPanel = document.getElementById("chat-panel");
const dropOverlay = document.getElementById("drop-overlay");
const msgInput = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");
const fileInput = document.getElementById("file-input");

const BASE_TITLE = "remote-chat | P2P 메신저 & 파일 공유";
const STORAGE_NOTIFY_PREF = "remote_chat_notify_enabled";
const STORAGE_ROOM_PASS_PREFIX = "remote_chat_room_pass_";
let notifyMuted = safeGetStorage(STORAGE_NOTIFY_PREF) === "0";
let unreadCount = 0;

// 방별 안 읽은 메시지 카운트 및 비밀방 암호(패스프레이즈) 관리
const roomUnreadCounts = new Map();
const roomPasswords = new Map();
// Map<peerId, { name, expiresAt }>
const typingPeers = new Map();
let lastTypingSentAt = 0;

function getRoomPassword(roomName) {
  if (!roomPasswords.has(roomName)) {
    const saved = safeGetStorage(STORAGE_ROOM_PASS_PREFIX + roomName) || "";
    roomPasswords.set(roomName, saved);
  }
  return roomPasswords.get(roomName) || "";
}

function setRoomPassword(roomName, pass) {
  const clean = (pass || "").trim();
  roomPasswords.set(roomName, clean);
  if (clean) {
    safeSetStorage(STORAGE_ROOM_PASS_PREFIX + roomName, clean);
  } else {
    safeRemoveStorage(STORAGE_ROOM_PASS_PREFIX + roomName);
  }
  updateSecretRoomUI();
}

function updateSecretRoomUI() {
  const pass = getRoomPassword(activeRoomName);
  roomPassInput.value = pass;
  if (pass) {
    e2eeBadge.classList.add("active");
    secretRoomBtn.classList.add("active");
  } else {
    e2eeBadge.classList.remove("active");
    secretRoomBtn.classList.remove("active");
  }
}

// 암호화 실패 시 전송을 차단하며, 키 캐시는 앱 초기화 때 함께 비운다.
const { encryptForRoom, decryptForRoom, roomKeyCache } = createRoomCrypto(getRoomPassword);

// 알림 권한과 사용자 선호를 함께 반영한다.
function updateNotifyBtnUI() {
  if (typeof Notification === "undefined") {
    notifyBtn.style.display = "none";
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted" && !notifyMuted) {
    notifyBtn.classList.add("enabled");
    notifyBtn.innerHTML = `🔔 <span id="notify-text">알림 켜짐</span>`;
  } else if (perm === "denied") {
    notifyBtn.classList.remove("enabled");
    notifyBtn.innerHTML = `🔕 <span id="notify-text">알림 차단됨</span>`;
  } else {
    notifyBtn.classList.remove("enabled");
    notifyBtn.innerHTML = `🔕 <span id="notify-text">알림 켜기</span>`;
  }
}

async function handleToggleNotification() {
  if (typeof Notification === "undefined") {
    appendSystemLog("⚠️ 이 브라우저는 시스템 알림을 지원하지 않습니다.");
    return;
  }
  if (Notification.permission === "default") {
    try {
      const res = await Notification.requestPermission();
      if (res === "granted") {
        notifyMuted = false;
        safeSetStorage(STORAGE_NOTIFY_PREF, "1");
        appendSystemLog("🔔 브라우저 메시지 알림이 활성화되었습니다.");
        try {
          new Notification("remote-chat 알림 활성화", {
            body: "새 메시지가 도착하면 브라우저 알림으로 알려드립니다.",
            icon: "./favicon.svg",
          });
        } catch (_) {}
      } else {
        appendSystemLog("🔕 브라우저 알림 권한이 거부되었습니다. 주소창 왼쪽 권한 설정에서 허용할 수 있습니다.");
      }
    } catch (_) {}
  } else if (Notification.permission === "granted") {
    notifyMuted = !notifyMuted;
    safeSetStorage(STORAGE_NOTIFY_PREF, notifyMuted ? "0" : "1");
    appendSystemLog(notifyMuted ? "🔕 메시지 알림을 일시 중지했습니다." : "🔔 메시지 알림을 다시 켰습니다.");
  } else {
    appendSystemLog("⚠️ 브라우저 설정에서 알림 권한이 차단되어 있습니다. 주소창 좌측 사이트 설정에서 알림을 '허용'으로 변경해 주세요.");
  }
  updateNotifyBtnUI();
}

notifyBtn.addEventListener("click", handleToggleNotification);
updateNotifyBtnUI();

// 헤더 액션 버튼 이벤트: 초대 링크 복사, 대화 지우기, 비밀방 암호 설정
copyLinkBtn.addEventListener("click", async () => {
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set("room", activeRoomName);
  if (activeRelayUrl) shareUrl.searchParams.set("relay", activeRelayUrl);
  const urlStr = shareUrl.toString();
  try {
    await navigator.clipboard.writeText(urlStr);
    appendSystemLog(
      `🔗 <b>#${escapeHtml(activeRoomName)}</b> 채널 초대 링크가 복사되었습니다: <a href="${escapeHtml(urlStr)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:underline;">${escapeHtml(urlStr)}</a>`
    );
  } catch (_) {
    prompt("아래 초대 링크를 복사해 공유하세요:", urlStr);
  }
});

clearChatBtn.addEventListener("click", async () => {
  if (!confirm(`#${activeRoomName} 채널의 저장된 대화 내역을 모두 비우시겠습니까?`)) return;
  try {
    await historyStore.clearRoom(activeRoomName);
  } catch (err) {
    appendSystemLog(`❌ 대화 삭제 실패: ${escapeHtml(String(err))}`);
    return;
  }
  roomHistories.set(activeRoomName, new Map());
  chatLog.innerHTML = "";
  appendSystemLog(`🧹 <b>#${escapeHtml(activeRoomName)}</b> 채널의 대화 기록을 비웠습니다.`);
  renderRoomList();
});

secretRoomBtn.addEventListener("click", () => {
  secretRoomBar.classList.toggle("open");
  if (secretRoomBar.classList.contains("open")) {
    roomPassInput.focus();
  }
});

async function applyRoomPassphrase() {
  const val = roomPassInput.value.trim();
  setRoomPassword(activeRoomName, val);
  secretRoomBar.classList.remove("open");
  if (val) {
    appendSystemLog(`🔒 <b>#${escapeHtml(activeRoomName)}</b> 채널에 종단간 암호화(AES-GCM) 비밀번호가 적용되었습니다.`);
  } else {
    appendSystemLog(`🔓 <b>#${escapeHtml(activeRoomName)}</b> 채널의 암호화가 해제되었습니다.`);
  }
  await renderRoomHistoryToDom(activeRoomName);
}

applyRoomPassBtn.addEventListener("click", applyRoomPassphrase);
roomPassInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyRoomPassphrase();
});
clearRoomPassBtn.addEventListener("click", async () => {
  roomPassInput.value = "";
  await applyRoomPassphrase();
});

window.addEventListener("focus", () => {
  unreadCount = 0;
  document.title = BASE_TITLE;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount = 0;
    document.title = BASE_TITLE;
  }
});

function notifyIncomingMessage(title, body) {
  const isBackground = document.hidden || !document.hasFocus();
  if (isBackground) {
    unreadCount++;
    document.title = `(${unreadCount}) ${title} - remote-chat`;
  }

  if (typeof Notification !== "undefined" && Notification.permission === "granted" && !notifyMuted) {
    if (isBackground) {
      try {
        const n = new Notification(title, {
          body,
          icon: "./favicon.svg",
          badge: "./favicon.svg",
          tag: `remote-chat-${activeRoomName}`,
          renotify: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (_) {}
    }
  }
}

const urlParams = new URLSearchParams(window.location.search);
let activeRoomName = urlParams.get("room") || "general";
currentRoomLabel.textContent = `#${activeRoomName}`;
updateSecretRoomUI();

let node = null;
let myShortId = "";
let myDisplayName = safeGetStorage(STORAGE_NICK_KEY) || "";

const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 하루(24시간)치 내역만 유지
// Map<roomName, Map<msgId, { id, sender, senderShortId, text, ts }>>
const roomHistories = new Map();
const historyAssembler = new HistoryAssembler();
let historyExpiryTimer = null;
let historyStorageReady = false;
const historyStore = new CompressedHistoryStore();

function isWithinOneDay(ts) {
  return Number.isFinite(ts) && ts <= Date.now() && (Date.now() - ts) < HISTORY_TTL_MS;
}

function getRoomHistoryMap(roomName) {
  if (!roomHistories.has(roomName)) roomHistories.set(roomName, new Map());
  const map = roomHistories.get(roomName);
  for (const [id, record] of map) {
    if (!record || !isWithinOneDay(record.ts)) map.delete(id);
  }
  return map;
}

function getRoomHistoryArray(roomName) {
  const map = getRoomHistoryMap(roomName);
  return Array.from(map.values())
    .filter((item) => isWithinOneDay(item.ts))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function saveRoomHistory(roomName) {
  if (historyStorageReady) {
    historyStore.append(roomName, getRoomHistoryArray(roomName)).catch(error => {
      appendSystemLog(`⚠️ 대화 기록 저장 실패 (현재 화면에는 유지): ${escapeHtml(String(error))}`);
    });
  }
  scheduleHistoryExpiry();
}

function scheduleHistoryExpiry() {
  clearTimeout(historyExpiryTimer);
  let next = Infinity;
  for (const map of roomHistories.values()) {
    for (const item of map.values()) next = Math.min(next, item.ts + HISTORY_TTL_MS);
  }
  if (Number.isFinite(next)) historyExpiryTimer = setTimeout(expireHistory, Math.max(0, next - Date.now()));
}

function expireHistory() {
  if (historyStorageReady) historyStore.prune().catch(error => {
    appendSystemLog(`⚠️ 만료 기록 삭제 실패: ${escapeHtml(String(error))}`);
  });
  for (const roomName of roomHistories.keys()) getRoomHistoryMap(roomName);
  for (const row of chatLog.querySelectorAll(".chat-row[data-history-item='1']")) {
    if (!isWithinOneDay(Number(row.dataset.ts))) row.remove();
  }
  scheduleHistoryExpiry();
}

function recordChatMessage(roomName, record) {
  if (!record || !isWithinOneDay(record.ts)) return false;
  const map = getRoomHistoryMap(roomName);
  if (map.has(record.id)) return false;
  map.set(record.id, record);
  saveRoomHistory(roomName);
  return true;
}

const roomsRegistry = new Map();
roomsRegistry.set("general", { tickets: new Set(), members: [] });

const bus = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("remote_chat_auto_discovery_v2") : null;

function addRoomTickets(roomName, tickets, members = []) {
  if (!roomsRegistry.has(roomName)) {
    roomsRegistry.set(roomName, { tickets: new Set(), members: [] });
  }
  const entry = roomsRegistry.get(roomName);
  for (const t of tickets) {
    if (t) entry.tickets.add(t);
  }
  if (members && members.length > 0) {
    entry.members = members;
  }
  renderRoomList();
}

function renderRoomList() {
  roomCountBadge.textContent = `${roomsRegistry.size}`;
  const seenRooms = new Set();

  for (const [rname, info] of roomsRegistry.entries()) {
    seenRooms.add(rname);
    const isActive = rname === activeRoomName;
    const histCount = getRoomHistoryMap(rname).size;
    const unread = isActive ? 0 : (roomUnreadCounts.get(rname) || 0);
    const hasPass = Boolean(getRoomPassword(rname));
    const memberText = info.members && info.members.length > 0
      ? `참여자 (${info.members.length}): ${info.members.join(", ")}`
      : `노드 ${info.tickets.size}개 · 대화 ${histCount}건`;
    const statusText = isActive ? "참여 중 ●" : "입장 →";

    let li = roomListEl.querySelector(`li[data-room="${CSS.escape(rname)}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.room = rname;
      li.innerHTML = `
        <div class="room-item-header">
          <span><span class="room-hash">#</span><span class="room-name-label"></span></span>
          <span class="room-status-wrap">
            <span class="unread-badge" style="display:none;"></span>
            <span class="room-status-tag"></span>
          </span>
        </div>
        <div class="room-item-meta"></div>
      `;
      li.addEventListener("click", () => {
        enterRoomByName(rname);
        toggleSidebar(false);
      });
      roomListEl.appendChild(li);
    }

    const targetClass = "room-item" + (isActive ? " active" : "");
    if (li.className !== targetClass) li.className = targetClass;

    const labelText = hasPass ? `${rname} 🔒` : rname;
    const nameEl = li.querySelector(".room-name-label");
    if (nameEl && nameEl.textContent !== labelText) nameEl.textContent = labelText;

    const badgeEl = li.querySelector(".unread-badge");
    if (badgeEl) {
      if (unread > 0) {
        badgeEl.style.display = "inline-block";
        const bText = unread > 99 ? "99+" : `${unread}`;
        if (badgeEl.textContent !== bText) badgeEl.textContent = bText;
      } else {
        badgeEl.style.display = "none";
      }
    }

    const statusEl = li.querySelector(".room-status-tag");
    if (statusEl && statusEl.textContent !== statusText) statusEl.textContent = statusText;

    const metaEl = li.querySelector(".room-item-meta");
    if (metaEl && metaEl.textContent !== memberText) metaEl.textContent = memberText;
  }

  for (const child of Array.from(roomListEl.children)) {
    if (!seenRooms.has(child.dataset.room)) {
      child.remove();
    }
  }
}

async function renderChatItemHtml(rawText) {
  const dec = await decryptForRoom(activeRoomName, rawText);
  if (dec.locked) {
    return `<div class="locked-msg">${escapeHtml(dec.text)}</div>`;
  }
  const lockPrefix = dec.encrypted ? `<span title="종단간 암호화 복호화됨" style="font-size: 0.8125rem;opacity:0.85;margin-right:4px;">🔒</span>` : "";
  return `${lockPrefix}${formatRichChatHtml(dec.text)}`;
}

async function renderRoomHistoryToDom(roomName) {
  const existingRows = chatLog.querySelectorAll(".chat-row[data-history-item='1']");
  existingRows.forEach((el) => el.remove());

  const historyList = getRoomHistoryArray(roomName);
  for (const item of historyList) {
    const isMe = Boolean(myShortId && item.senderShortId === myShortId);
    const htmlContent = await renderChatItemHtml(item.text);
    appendChatBubble({
      id: item.id,
      sender: item.sender,
      htmlContent,
      isMe,
      ts: item.ts,
      isHistoryItem: true,
    });
  }
}

async function broadcastMyRoomHistory(roomName) {
  if (!node) return;
  const list = getRoomHistoryArray(roomName);
  if (list.length === 0) return;
  try {
    for (const frame of historyFrames(list)) {
      await node.broadcast_history(roomName, frame);
    }
  } catch (err) {
    appendSystemLog(`⚠️ 대화 기록 동기화 실패: ${escapeHtml(String(err))}`);
  }
}

function renderTypingBar() {
  const now = Date.now();
  for (const [pid, info] of typingPeers.entries()) {
    if (info.expiresAt <= now) typingPeers.delete(pid);
  }
  if (typingPeers.size === 0) {
    typingBarEl.classList.remove("active");
    typingBarEl.textContent = "";
    return;
  }
  const names = Array.from(typingPeers.values()).map((v) => v.name);
  typingBarEl.classList.add("active");
  typingBarEl.textContent = `✍️ ${names.join(", ")} 님이 메시지를 입력하고 있습니다...`;
}
setInterval(renderTypingBar, 800);

async function enterRoomByName(rname) {
  if (!node) return;
  const cleanName = rname.trim();
  if (!cleanName) return;

  const isSwitching = activeRoomName !== cleanName || chatLog.children.length === 0;

  if (!roomsRegistry.has(cleanName)) {
    roomsRegistry.set(cleanName, { tickets: new Set(), members: [] });
  }
  const entry = roomsRegistry.get(cleanName);
  const ticketsCsv = Array.from(entry.tickets).join(",");

  try {
    const myNewTicket = await node.enter_room(cleanName, ticketsCsv, onGossipEvent);
    activeRoomName = cleanName;
    roomUnreadCounts.set(cleanName, 0);
    typingPeers.clear();
    renderTypingBar();
    currentRoomLabel.textContent = `#${cleanName}`;
    updateSecretRoomUI();
    entry.tickets.add(myNewTicket);

    if (isSwitching) {
      chatLog.innerHTML = "";
      appendSystemLog(`⚠️ <b>알림:</b> 최근 하루(24시간) 동안의 채팅 내역이 저장 및 참여자 간 공유되오니 민감한 개인정보나 대화 내용에 주의해 주세요.`);
      const savedList = getRoomHistoryArray(cleanName);
      if (savedList.length > 0) {
        appendSystemLog(`🕘 최근 24시간 대화 기록 ${savedList.length}건을 복원했습니다.`);
        await renderRoomHistoryToDom(cleanName);
      }
    }

    renderRoomList();

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set("room", cleanName);
    window.history.replaceState({}, "", newUrl);

    appendSystemLog(`✨ <b>#${escapeHtml(cleanName)}</b> 채널에 자동 입장했습니다.`);
    await syncServerlessDiscovery();
    await updatePeerStatus();
  } catch (e) {
    appendSystemLog(`⚠️ 방 입장 실패: ${escapeHtml(String(e))}`);
  }
}

let isSyncingDiscovery = false;
const joinedTicketsSet = new Set();

async function syncServerlessDiscovery() {
  if (!node || isSyncingDiscovery) return;
  isSyncingDiscovery = true;
  try {
    const myTicket = await node.ticket();
    const myId = node.node_id();
    joinedTicketsSet.add(myTicket);

    addRoomTickets(activeRoomName, [myTicket]);

    const payload = {
      type: "discovery_sync",
      room_name: activeRoomName,
      node_id: myId,
      ticket: myTicket,
      name: myDisplayName,
      history: getRoomHistoryArray(activeRoomName),
      all_rooms: Array.from(roomsRegistry.entries()).map(([r, v]) => ({
        room_name: r,
        tickets: Array.from(v.tickets),
      })),
    };
    if (bus) {
      bus.postMessage(payload);
    }
    safeSetStorage(STORAGE_ROOMS_KEY, JSON.stringify(payload.all_rooms));

    await node.discover_via_url_beacons(onGossipEvent);
  } catch (_) {
  } finally {
    isSyncingDiscovery = false;
  }
  await updatePeerStatus();
}

if (bus) {
  bus.onmessage = async (ev) => {
    const data = ev.data || {};
    if (data.type === "peer_leaving" && data.node_id) {
      peersMap.delete(data.node_id);
      renderPeerAvatars();
      return;
    }

    const { room_name, ticket, history, all_rooms } = data;
    if (Array.isArray(all_rooms)) {
      for (const r of all_rooms) {
        if (r.room_name && Array.isArray(r.tickets)) {
          addRoomTickets(r.room_name, r.tickets);
        }
      }
    }
    if (room_name && Array.isArray(history)) {
      let added = 0;
      for (const item of history) {
        if (item && item.id && recordChatMessage(room_name, item)) {
          added++;
        }
      }
      if (added > 0) {
        if (room_name === activeRoomName) {
          await renderRoomHistoryToDom(activeRoomName);
        } else {
          roomUnreadCounts.set(room_name, (roomUnreadCounts.get(room_name) || 0) + added);
        }
        renderRoomList();
      }
    }
    if (room_name && ticket && !joinedTicketsSet.has(ticket)) {
      joinedTicketsSet.add(ticket);
      addRoomTickets(room_name, [ticket]);
      if (node && room_name === activeRoomName) {
        await node.auto_join_peers(ticket);
        await updatePeerStatus();
      }
    }
  };
}

window.addEventListener("storage", async (ev) => {
  if (ev.key === STORAGE_ROOMS_KEY && ev.newValue) {
    try {
      const allRooms = JSON.parse(ev.newValue);
      for (const r of allRooms) {
        if (r.room_name && Array.isArray(r.tickets)) {
          addRoomTickets(r.room_name, r.tickets);
          if (node && r.room_name === activeRoomName) {
            const unjoined = r.tickets.filter((t) => !joinedTicketsSet.has(t));
            if (unjoined.length > 0) {
              unjoined.forEach((t) => joinedTicketsSet.add(t));
              await node.auto_join_peers(unjoined.join(","));
            }
          }
        }
      }
    } catch (_) {}
  }
});

function appendSystemLog(html) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendChatBubble({ id, sender, htmlContent, isMe = false, ts, isHistoryItem = false }) {
  if (id && chatLog.querySelector(`.chat-row[data-msg-id="${CSS.escape(id)}"]`)) {
    return;
  }
  const row = document.createElement("div");
  row.className = `chat-row ${isMe ? "me" : "peer"}`;
  if (id) row.dataset.msgId = id;
  if (isHistoryItem) { row.dataset.historyItem = "1"; row.dataset.ts = String(ts); }

  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.style.background = avatarGradient(sender);
  avatar.textContent = avatarInitials(sender);

  const group = document.createElement("div");
  group.className = "chat-bubble-group";

  const timeStr = formatTimeFromTs(ts);
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  meta.innerHTML = isMe
    ? `<span>${timeStr}</span><span class="chat-sender-name">${escapeHtml(sender)} (나)</span>`
    : `<span class="chat-sender-name">${escapeHtml(sender)}</span><span>${timeStr}</span>`;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.innerHTML = htmlContent;

  group.appendChild(meta);
  group.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(group);

  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function updatePeerStatus() {
  if (!node) return;
  const count = await node.peer_count();
  statusTextEl.textContent = count > 0
    ? `온라인 · 연결된 참여자 ${count}명`
    : "온라인 · 참여자 자동 탐색 중";

  // 현재 방 온라인 참여자 칩 목록 업데이트 (나 + 연결된 피어)
  try {
    const peersJson = await node.online_peers_json();
    const peers = JSON.parse(peersJson);
    const allMembers = [
      { id: myShortId, name: `${myDisplayName || "나"} (나)` },
      ...(Array.isArray(peers) ? peers : []),
    ];
    onlineMemberCountEl.textContent = `${allMembers.length}`;
    const sig = allMembers.map((m) => `${m.id}:${m.name}`).join("|");
    if (onlineMembersListEl.dataset.sig !== sig) {
      onlineMembersListEl.dataset.sig = sig;
      onlineMembersListEl.innerHTML = allMembers
        .map(
          (m) => `
          <span class="member-chip" title="Node ID: ${escapeHtml(m.id)}">
            <span class="member-chip-dot" style="background:${avatarGradient(m.name)}">${escapeHtml(avatarInitials(m.name))}</span>
            <span>${escapeHtml(m.name)}</span>
          </span>
        `
        )
        .join("");
    }
  } catch (_) {}
}

async function onGossipEvent(kind, sender, text, extra) {
  if (kind === "peer_up") {
    appendSystemLog(`🟢 참여자 자동 연결됨: <b>${escapeHtml(sender)}</b>`);
    updatePeerStatus();
    setTimeout(() => broadcastMyRoomHistory(activeRoomName), 350);
  } else if (kind === "peer_down") {
    appendSystemLog(`⚪ 참여자 연결 해제: <b>${escapeHtml(sender)}</b>`);
    updatePeerStatus();
  } else if (kind === "relay_online") {
    appendSystemLog(`🌐 <b>${escapeHtml(text)}</b> 외부 및 모바일 기기와 자동 동기화됩니다.`);
    syncServerlessDiscovery();
  } else if (kind === "beacon_online") {
    // 내부 비콘 이벤트는 UI 시스템 로그에 노출하지 않음
  } else if (kind === "name") {
    appendSystemLog(`🏷️ <b>${escapeHtml(sender)}</b> 님이 닉네임을 <b>${escapeHtml(text)}</b>(으)로 변경했습니다.`);
    updatePeerStatus();
  } else if (kind === "typing") {
    // sender = 닉네임, text = room_name, extra = short_id
    if (text === activeRoomName && extra !== myShortId) {
      typingPeers.set(extra || sender, { name: sender, expiresAt: Date.now() + 3200 });
      renderTypingBar();
    }
  } else if (kind === "room_announce") {
    const isNew = !roomsRegistry.has(text);
    addRoomTickets(text, [extra]);
    if (isNew) {
      appendSystemLog(`📢 <b>${escapeHtml(sender)}</b> 님이 <b>#${escapeHtml(text)}</b> 채널을 개설했습니다! 좌측 목록에서 클릭해 입장하세요.`);
    }
  } else if (kind === "chat") {
    const msgId = extra || `${sender}:${Date.now()}`;
    const senderShortId = msgId.includes(":") ? msgId.split(":")[0] : "";
    typingPeers.delete(senderShortId || sender);
    renderTypingBar();
    const ts = Date.now();
    recordChatMessage(activeRoomName, {
      id: msgId,
      sender,
      senderShortId,
      text,
      ts,
    });
    const htmlContent = await renderChatItemHtml(text);
    appendChatBubble({
      id: msgId,
      sender,
      htmlContent,
      isMe: false,
      ts,
      isHistoryItem: true,
    });
    renderRoomList();
    const dec = await decryptForRoom(activeRoomName, text);
    notifyIncomingMessage(`#${activeRoomName} · ${sender}`, dec.text);
  } else if (kind === "history_sync") {
    const roomName = sender;
    try {
      const incomingList = historyAssembler.accept(text, extra, roomName);
      if (Array.isArray(incomingList)) {
        let newlyAdded = 0;
        for (const item of incomingList) {
          if (item && item.id && typeof item.text === "string") {
            if (recordChatMessage(roomName, item)) {
              newlyAdded++;
            }
          }
        }
        if (newlyAdded > 0) {
          if (roomName === activeRoomName) {
            await renderRoomHistoryToDom(activeRoomName);
            appendSystemLog(`🕘 이전 대화 기록 ${newlyAdded}건이 피어로부터 동기화되었습니다.`);
          } else {
            roomUnreadCounts.set(roomName, (roomUnreadCounts.get(roomName) || 0) + newlyAdded);
          }
          renderRoomList();
        }
      }
    } catch (_) {}
  } else if (kind === "file_offer") {
    appendSystemLog(`📎 <b>${escapeHtml(sender)}</b> 님이 파일 <code>${escapeHtml(text)}</code>을(를) 공유했습니다.`);
    notifyIncomingMessage(`#${activeRoomName} · ${sender}`, `📎 파일 공유: ${text}`);
  } else if (kind === "inline_file") {
    const binStr = atob(extra);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const previewHtml = isImageFile(text)
      ? `<img src="${url}" class="file-preview-img" alt="${escapeHtml(text)}" onclick="window.open('${url}', '_blank')" />`
      : "";
    appendChatBubble({
      sender,
      isMe: false,
      htmlContent: `
        <div>📎 파일이 도착했습니다</div>
        <div class="file-card">
          ${previewHtml}
          <div class="file-card-row">
            <div class="file-info">
              <div class="fname">${escapeHtml(text)}</div>
              <div class="fsize">${formatBytes(bytes.length)}</div>
            </div>
            <a class="file-dl-btn" href="${url}" download="${escapeHtml(text)}">⬇ 저장</a>
          </div>
        </div>
      `,
    });
    notifyIncomingMessage(`#${activeRoomName} · ${sender}`, `📎 파일이 도착했습니다: ${text}`);
  }
}

async function forceResetKey() {
  try {
    await historyStore.open();
    await historyStore.clear();
    const db = await openKeyDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("저장소 초기화 중단"));
      });
    } finally { db.close(); }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("remote_chat_")) localStorage.removeItem(key);
    }
    clearTimeout(historyExpiryTimer);
    historyAssembler.pending.clear();
    roomHistories.clear();
    roomPasswords.clear();
    roomKeyCache.clear();
  } catch (err) {
    appendSystemLog(`❌ 데이터 초기화 실패: ${escapeHtml(String(err))}`);
    return;
  }
  appendSystemLog("🗑️ 저장된 채팅 데이터를 삭제했습니다. 새 Node ID로 재시작합니다...");
  setTimeout(() => window.location.reload(), 300);
}

async function main() {
  try {
    const restored = await historyStore.load();
    for (const [room, records] of restored) {
      const existing = getRoomHistoryMap(room);
      for (const [id, record] of records) if (!existing.has(id)) existing.set(id, record);
    }
    historyStorageReady = true;
  } catch (error) {
    appendSystemLog(`⚠️ 대화 저장소를 열지 못했습니다. 새 기록은 현재 화면에만 유지됩니다: ${escapeHtml(String(error))}`);
  }
  expireHistory();
  setInterval(expireHistory, 60000);
  window.addEventListener("focus", expireHistory);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) expireHistory();
  });
  renderRoomList();

  try {
    const relayUrl = selectRelayUrl(requestedRelay, safeGetStorage(RELAY_STORAGE_KEY));
    activeRelayUrl = relayUrl;
    relayStatus.textContent = `사용 릴레이: ${relayUrl}`;
    statusTextEl.textContent = "WASM 엔진 로딩 중...";
    await init(`./pkg/remote_chat_bg.wasm?t=${CACHE_BUSTER}`);

    statusTextEl.textContent = "노드 보안키 확인 중...";
    const existingKey = await loadPersistedKey();
    const isRestored = Boolean(existingKey);

    statusTextEl.textContent = "P2P 네트워크 시작 중...";
    const scopeUrl = window.location.origin;
    node = await WebChatNode.start(scopeUrl, existingKey ?? undefined, onGossipEvent, relayUrl);

    const hexKey = node.secret_key_hex();
    savePersistedKey(hexKey);

    const id = node.node_id();
    myShortId = id.slice(0, 8);
    const normScope = node.normalized_scope();
    myIdEl.textContent = id.slice(0, 12) + "...";
    myIdEl.title = id;
    keyStateEl.textContent = isRestored ? "유지됨 🔒" : "신규 ✨";
    scopeSubtitleEl.textContent = "참여자를 찾고 있습니다";
    scopeSubtitleEl.title = `네트워크 스코프: ${normScope}`;

    if (!myDisplayName) {
      myDisplayName = `유저_${id.slice(0, 4)}`;
    }
    nameInput.value = myDisplayName;
    myAvatarEl.textContent = avatarInitials(myDisplayName);
    myAvatarEl.style.background = avatarGradient(myDisplayName);
    await node.set_name(myDisplayName);

    statusEl.classList.add("online");

    resetKeyBtn.disabled = false;
    setNameBtn.disabled = false;
    newRoomInput.disabled = false;
    createRoomBtn.disabled = false;
    msgInput.disabled = false;
    sendBtn.disabled = false;
    fileInput.disabled = false;

    await enterRoomByName(activeRoomName);
    setInterval(syncServerlessDiscovery, 6000);
  } catch (err) {
    statusTextEl.textContent = "초기화 실패";
    appendSystemLog(`❌ 오류 발생: ${escapeHtml(String(err))}`);
  }
}

resetKeyBtn.addEventListener("click", async () => {
  if (confirm("이 사이트의 모든 채팅 기록·방 암호·닉네임·비밀키를 삭제하고 새 ID로 시작하시겠습니까? 다른 탭을 먼저 닫아 주세요.")) {
    await forceResetKey();
  }
});

setNameBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name || !node) return;
  try {
    const announced = await node.set_name(name);
    myDisplayName = name;
    myAvatarEl.textContent = avatarInitials(name);
    myAvatarEl.style.background = avatarGradient(name);
    safeSetStorage(STORAGE_NICK_KEY, name);
    await syncServerlessDiscovery();
    appendSystemLog(`🏷️ 내 닉네임이 <b>${escapeHtml(name)}</b>(으)로 변경되었습니다.`);
    if (announced === false) {
      appendSystemLog("⚠️ 닉네임은 저장했지만 참여자에게 알리지 못했습니다. 연결 상태를 확인해 주세요.");
    }
  } catch (e) {
    appendSystemLog(`⚠️ 닉네임 설정 실패: ${escapeHtml(String(e))}`);
  }
});

async function handleCreateRoom() {
  const rname = newRoomInput.value.trim().replace(/^#/, "");
  if (!rname || !node) return;
  newRoomInput.value = "";
  await enterRoomByName(rname);
  toggleSidebar(false);
}

createRoomBtn.addEventListener("click", handleCreateRoom);
newRoomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) handleCreateRoom();
});

function autoResizeTextarea() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
}

msgInput.addEventListener("input", () => {
  autoResizeTextarea();
  if (node && msgInput.value.trim().length > 0) {
    const now = Date.now();
    if (now - lastTypingSentAt > 2000) {
      lastTypingSentAt = now;
      node.send_typing(activeRoomName).catch(() => {});
    }
  }
});

// 클립보드 이미지 바로 붙여넣기 (Ctrl+V / Cmd+V)
msgInput.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (blob) {
        e.preventDefault();
        const ext = (item.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
        const filename = `clipboard_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${ext}`;
        const file = new File([blob], filename, { type: item.type });
        await shareFileObject(file);
        return;
      }
    }
  }
});

async function sendChat() {
  const text = msgInput.value.trim();
  if (!text || !node) return;
  if (text === "/reset-key") {
    await forceResetKey();
    return;
  }

  try {
    const wireText = await encryptForRoom(activeRoomName, text);
    const msgId = await node.send_message(wireText);
    msgInput.value = "";
    autoResizeTextarea();
    const ts = Date.now();
    recordChatMessage(activeRoomName, {
      id: msgId,
      sender: myDisplayName,
      senderShortId: myShortId,
      text: wireText,
      ts,
    });
    const htmlContent = await renderChatItemHtml(wireText);
    appendChatBubble({
      id: msgId,
      sender: myDisplayName,
      htmlContent,
      isMe: true,
      ts,
      isHistoryItem: true,
    });
    renderRoomList();
  } catch (e) {
    appendSystemLog(`⚠️ 전송 실패: ${escapeHtml(String(e))}`);
  }
}

sendBtn.addEventListener("click", sendChat);
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  }
});

async function shareFileObject(file) {
  if (!file || !node) return;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    await node.send_file(file.name, bytes);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const previewHtml = isImageFile(file.name)
      ? `<img src="${url}" class="file-preview-img" alt="${escapeHtml(file.name)}" onclick="window.open('${url}', '_blank')" />`
      : "";
    appendChatBubble({
      sender: myDisplayName,
      isMe: true,
      htmlContent: `
        <div>📎 파일을 공유했습니다</div>
        <div class="file-card">
          ${previewHtml}
          <div class="file-card-row">
            <div class="file-info">
              <div class="fname">${escapeHtml(file.name)}</div>
              <div class="fsize">${formatBytes(bytes.length)}</div>
            </div>
            <a class="file-dl-btn" href="${url}" download="${escapeHtml(file.name)}">⬇ 저장</a>
          </div>
        </div>
      `,
    });
  } catch (err) {
    appendSystemLog(`⚠️ 파일 전송 실패: ${escapeHtml(String(err))}`);
  }
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await shareFileObject(file);
  fileInput.value = "";
});

// 드래그 앤 드롭 파일 공유 지원
chatPanel.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropOverlay.classList.add("active");
});
chatPanel.addEventListener("dragleave", (e) => {
  if (e.relatedTarget && !chatPanel.contains(e.relatedTarget)) {
    dropOverlay.classList.remove("active");
  }
});
chatPanel.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropOverlay.classList.remove("active");
  const file = e.dataTransfer?.files?.[0];
  if (file) await shareFileObject(file);
});

// 브라우저 탭/창을 닫거나 이동할 때 즉시 연결 해제 신호(Leave) 브로드캐스트 및 엔드포인트 종료
let hasDisconnected = false;
function handleImmediateDisconnect() {
  if (hasDisconnected) return;
  hasDisconnected = true;
  try {
    if (bus && myShortId) {
      bus.postMessage({
        type: "peer_leaving",
        room_name: activeRoomName,
        short_id: myShortId,
        name: myDisplayName,
      });
    }
  } catch (_) {}
  try {
    if (node) {
      node.disconnect();
    }
  } catch (_) {}
}

window.addEventListener("pagehide", handleImmediateDisconnect);
window.addEventListener("beforeunload", handleImmediateDisconnect);

main();
