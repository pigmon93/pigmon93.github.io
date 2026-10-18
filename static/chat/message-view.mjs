// DOM 상태와 독립적인 메시지 표시 함수. 사용자 텍스트는 HTML 이스케이프 후 꾸민다.
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function formatRichChatHtml(rawText) {
  const escaped = escapeHtml(rawText);
  const codeBlocks = [];
  // 1. 멀티라인 코드블록 ```...```
  let processed = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="code-block"><code>${code.replace(/^\n+|\n+$/g, "")}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });
  // 2. 인라인 코드 `...`
  processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code class="inline-code">${code}</code>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });
  // 3. URL 자동 하이퍼링크 (https://..., http://..., www...., 또는 naver.com / google.co.kr 같은 도메인)
  const urlRegex = /(?:https?:\/\/|www\.)[^\s<]+|\b(?:[a-zA-Z0-9-]+\.)+(?:com|net|org|kr|co\.kr|io|dev|me|ai|app|gg|xyz|link|tv|info|biz|edu|gov)(?:\/[^\s<]*)?/gi;
  processed = processed.replace(urlRegex, (match) => {
    // 문장 끝 마침표, 쉼표, 닫는 괄호 등은 링크에서 분리
    let cleanUrl = match;
    let trailing = "";
    while (/[.,!?;:)\]]$/.test(cleanUrl)) {
      trailing = cleanUrl.slice(-1) + trailing;
      cleanUrl = cleanUrl.slice(0, -1);
    }
    const href = /^https?:\/\//i.test(cleanUrl) ? cleanUrl : `https://${cleanUrl}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="chat-link">${cleanUrl}</a>${trailing}`;
  });
  // 4. 줄바꿈(\n) -> <br/>
  processed = processed.replace(/\n/g, "<br/>");
  // 5. 코드블록 복원
  processed = processed.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);
  return processed;
}

export function formatBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

export function formatTimeFromTs(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export function avatarGradient(seed) {
  const palettes = [
    "linear-gradient(135deg, #38bdf8, #6366f1)",
    "linear-gradient(135deg, #34d399, #059669)",
    "linear-gradient(135deg, #f472b6, #db2777)",
    "linear-gradient(135deg, #fbbf24, #d97706)",
    "linear-gradient(135deg, #a78bfa, #7c3aed)",
    "linear-gradient(135deg, #fb7185, #e11d48)"
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palettes[h % palettes.length];
}

export function avatarInitials(name) {
  const clean = (name || "?").replace(/^유저_/, "").trim();
  return clean.slice(0, 2).toUpperCase();
}

export function isImageFile(filename) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filename || "");
}
