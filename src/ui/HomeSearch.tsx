import { useEffect, useRef, useState } from 'react';
import { rpc, type GlossaryItem, type Page } from '../api';
import { Icon } from './Icon';
import { Highlight } from './Highlight';

const KEY = 'gl_recent_q';
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
export const rememberQuery = (q: string) => {
  const v = q.trim(); if (v.length < 2) return;
  try { localStorage.setItem(KEY, JSON.stringify([v, ...readRecent().filter((x) => x !== v)].slice(0, 6))); } catch { /* приватный режим */ }
};

/** Большой поиск на Главной: подсказки при вводе и недавние запросы. */
export function HomeSearch({ value, onChange, onOpen, langs }: { value: string; onChange: (v: string) => void; onOpen: (id: number) => void; langs: string[] }) {
  const [v, setV] = useState(value);
  const [focus, setFocus] = useState(false);
  const [sugg, setSugg] = useState<GlossaryItem[]>([]);
  const [idx, setIdx] = useState(-1);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v.trim().length < 2) { setSugg([]); return; }
    const h = window.setTimeout(() => rpc<Page<GlossaryItem>>('glossary_page', { p_q: v, p_size: 6 }).then((r) => setSugg(r.items)).catch(() => setSugg([])), 180);
    return () => window.clearTimeout(h);
  }, [v]);
  const set = (nv: string, now = false) => {
    setV(nv); setIdx(-1);
    window.clearTimeout(t.current);
    if (now) onChange(nv); else t.current = window.setTimeout(() => onChange(nv), 300);
  };
  const pick = (it: GlossaryItem) => { rememberQuery(v); setRecent(readRecent()); setFocus(false); onOpen(it.id); };
  const showSugg = focus && v.trim().length >= 2 && sugg.length > 0;
  const showRecent = focus && !v.trim() && recent.length > 0;
  const first = (it: GlossaryItem) => langs.map((l) => it.cells[l]?.t?.[0] ? `${l}: ${it.cells[l].t[0]}` : null).find(Boolean);
  return (
    <div className="home-sb">
      <label className="searchbox big">
        <Icon name="search" size={20} />
        <input className="search big" type="search" value={v} autoFocus placeholder="Найти термин, перевод или номер (TB-00123)" aria-label="Поиск по глоссарию"
          role="combobox" aria-expanded={showSugg || showRecent} aria-controls="home-sugg" autoComplete="off"
          onFocus={() => setFocus(true)} onBlur={() => window.setTimeout(() => setFocus(false), 150)}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (!showSugg) { if (e.key === 'Enter') { rememberQuery(v); setRecent(readRecent()); set(v, true); } return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, sugg.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, -1)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0) pick(sugg[idx]); else { rememberQuery(v); setRecent(readRecent()); set(v, true); setFocus(false); } }
            else if (e.key === 'Escape') setFocus(false);
          }} />
      </label>
      {showSugg ? (
        <ul className="sugg" id="home-sugg" role="listbox">
          {sugg.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === idx} className={i === idx ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(it); }}>
              <span className="tb">{it.tb}</span>
              <b><Highlight text={it.ru} q={v} /></b>
              {first(it) ? <span className="muted small"><Highlight text={first(it)!} q={v} /></span> : null}
              <Icon name="right" size={14} />
            </li>
          ))}
          <li className="sugg-all" onMouseDown={(e) => { e.preventDefault(); rememberQuery(v); setRecent(readRecent()); set(v, true); setFocus(false); }}>Все результаты для «{v}» — Enter</li>
        </ul>
      ) : null}
      {showRecent ? (
        <ul className="sugg" role="listbox">
          <li className="sugg-head">Недавние запросы</li>
          {recent.map((r) => (
            <li key={r} onMouseDown={(e) => { e.preventDefault(); set(r, true); }}><Icon name="history" size={14} /> {r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
