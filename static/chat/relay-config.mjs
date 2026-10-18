// 폐쇄망 배포 시 내부 릴레이 주소로 변경하세요. 첫 접속부터 적용됩니다.
export const DEFAULT_RELAY_URL = "https://aps1-1.relay.n0.iroh.link";

export function normalizeRelayUrl(value) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('인증정보·쿼리·프래그먼트가 없는 HTTPS 릴레이 주소를 입력하세요.');
  }
  return url.href;
}

export function selectRelayUrl(requested, saved) {
  // 잘못된 사용자 설정을 공용 릴레이로 대체하지 않습니다.
  return normalizeRelayUrl(requested ?? saved ?? DEFAULT_RELAY_URL);
}
