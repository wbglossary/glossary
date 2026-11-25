import { useState } from 'react';
import { Icon, type IconName } from './ui/Icon';

/** Тема сайта: «как в системе», светлая или тёмная. Выбор хранится в этом браузере. */
export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'gl_theme';
export const readTheme = (): Theme => { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };
export const applyTheme = (t: Theme) => {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* приватный режим */ }
};
const OPTIONS: [Theme, string, IconName][] = [['light', 'Светлая', 'sun'], ['dark', 'Тёмная', 'moon'], ['auto', 'Как в системе', 'monitor']];

/** Выбор темы — три кнопки с подписями (в меню профиля) */
export function ThemeChoice() {
  const [t, setT] = useState<Theme>(readTheme);
  return (
    <div className="theme-choice" role="radiogroup" aria-label="Тема оформления">
      {OPTIONS.map(([k, label, icon]) => (
        <button key={k} role="radio" aria-checked={t === k} className={t === k ? 'on' : ''} onClick={() => { applyTheme(k); setT(k); }}>
          <Icon name={icon} size={15} />{label}
        </button>
      ))}
    </div>
  );
}
