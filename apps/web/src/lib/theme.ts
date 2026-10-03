import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'theme'; // same key /theme-init.js reads before first paint

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const read = (): Theme => {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
};
const resolve = (t: Theme): 'light' | 'dark' => (t === 'system' ? (media?.matches ? 'dark' : 'light') : t);

/** Apply without animating every colour on the page (no 150ms crossfade of the whole UI). */
function apply(resolved: 'light' | 'dark') {
  const el = document.documentElement;
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(style);
  el.setAttribute('data-theme', resolved);
  el.style.colorScheme = resolved;
  void getComputedStyle(el).opacity; // flush styles before re-enabling transitions
  requestAnimationFrame(() => style.remove());
}

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}

/**
 * Theme store for this SPA. The pre-paint script (/theme-init.js) already set the attribute, so
 * nothing is injected into React (an inline <script> would also violate the CSP).
 */
export const useTheme = create<ThemeState>((set) => {
  const initial = read();
  media?.addEventListener('change', () => {
    const { theme } = useTheme.getState();
    if (theme === 'system') {
      const r = resolve('system');
      apply(r);
      set({ resolvedTheme: r });
    }
  });
  return {
    theme: initial,
    resolvedTheme: resolve(initial),
    setTheme: (theme) => {
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        /* private mode: theme still applies for this session */
      }
      const r = resolve(theme);
      apply(r);
      set({ theme, resolvedTheme: r });
    },
  };
});
