// 네이티브 dialog는 Tab 포커스를 모달 안에 제한하고 Escape로 닫는다.
const dialog = document.getElementById("settings-dialog");
const opener = document.getElementById("open-settings-btn");
opener.addEventListener("click", () => dialog.showModal());
document.getElementById("close-settings-btn").addEventListener("click", () => dialog.close());
// 배경 클릭만 닫기 처리한다. 모달 내부의 빈 공간 클릭은 유지한다.
dialog.addEventListener("click", (event) => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
// 모바일 사이드바의 설정 버튼으로 돌아갈 수 있도록 포커스를 명시적으로 복구한다.
dialog.addEventListener("close", () => opener.focus());

// 사이드바는 화면 크기에 따라 항상 보이거나 모바일 드로어가 된다.
// 닫힌 드로어는 inert로 키보드와 스크린 리더의 접근 대상에서도 제외한다.
const sidebar = document.getElementById("sidebar");
const backdrop = document.getElementById("sidebar-backdrop");
const menuButton = document.getElementById("open-sidebar-btn");
const mobileViewport = window.matchMedia("(max-width: 820px)");

export function toggleSidebar(open) {
  const isDrawerOpen = mobileViewport.matches && open;
  sidebar.classList.toggle("open", isDrawerOpen);
  backdrop.classList.toggle("open", isDrawerOpen);
  menuButton.setAttribute("aria-expanded", String(isDrawerOpen));
  if (mobileViewport.matches && !open && sidebar.contains(document.activeElement)) menuButton.focus();
  sidebar.inert = mobileViewport.matches && !open;
}

menuButton.addEventListener("click", () => toggleSidebar(true));
document.getElementById("close-sidebar-btn").addEventListener("click", () => toggleSidebar(false));
backdrop.addEventListener("click", () => toggleSidebar(false));
mobileViewport.addEventListener("change", () => toggleSidebar(false));
document.addEventListener("keydown", (event) => {
  // 모달의 Escape는 dialog에 맡겨 한 번에 한 층씩 닫는다.
  if (event.key === "Escape" && !dialog.open) toggleSidebar(false);
});
toggleSidebar(false);
