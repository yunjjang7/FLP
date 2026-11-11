import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * 새 버전 안내. 서비스 워커는 autoUpdate(새 버전이 받아지면 바로 활성화)라서
 * 예전 화면이 먼저 뜬 뒤 새 버전이 활성화되면 onNeedReload 가 불림:
 * - 앱을 연 직후(아직 아무것도 누르지 않았고 20초 안) → 바로 새로고침
 * - 쓰는 중 → ‘새 버전이 있습니다’ 배너(누르면 새로고침)
 * 앱으로 돌아올 때(화면이 다시 보일 때)와 한 시간마다 새 버전을 확인함(설치형 앱은 다시 열어도 페이지를 새로 받지 않을 때가 있어서).
 */
const AUTO_WINDOW_MS = 20_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

let ready = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let touched = false;
const markTouched = () => {
  touched = true;
};

export function startSwUpdate() {
  if (typeof window === 'undefined') return;
  window.addEventListener('pointerdown', markTouched, { once: true, capture: true });
  window.addEventListener('keydown', markTouched, { once: true, capture: true });
  registerSW({
    immediate: true,
    onNeedReload() {
      if (!touched && performance.now() < AUTO_WINDOW_MS) {
        window.location.reload();
        return;
      }
      ready = true;
      emit();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      let last = Date.now();
      const check = () => {
        if (!navigator.onLine || reg.installing) return;
        last = Date.now();
        reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => {
        // 잠깐 다른 앱을 봤다 오는 경우까지 매번 확인하지 않게 1분 간격
        if (document.visibilityState === 'visible' && Date.now() - last > 60_000) check();
      });
      setInterval(check, CHECK_EVERY_MS);
    },
  });
}

export function applySwUpdate() {
  window.location.reload();
}

export function useSwUpdateReady() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ready,
    () => false,
  );
}
