import { useState } from 'react';

/** Тема сайта: «авто» (как в системе), светлая или тёмная. Выбор хранится в этом браузере. */
type Theme = 'auto' | 'light' | 'dark';
const KEY = 'gl_theme';
const read = (): Theme => { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };
const apply = (t: Theme) => {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* приватный режим */ }
};
const NEXT: Record<Theme, Theme> = { auto: 'dark', dark: 'light', light: 'auto' };
const LABEL: Record<Theme, string> = { auto: 'Тема: как в системе', dark: 'Тема: тёмная', light: 'Тема: светлая' };
const ICON: Record<Theme, string> = { auto: '◐', dark: '☾', light: '☀' };

export function ThemeButton() {
  const [t, setT] = useState<Theme>(read);
  return (
    <button className="btn link small theme-btn" title={`${LABEL[t]}. Нажмите, чтобы сменить`} aria-label={`${LABEL[t]}. Сменить тему`}
      onClick={() => { const n = NEXT[t]; apply(n); setT(n); }}>
      <span aria-hidden="true">{ICON[t]}</span>{t === 'auto' ? 'Авто' : t === 'dark' ? 'Тёмная' : 'Светлая'}
    </button>
  );
}
