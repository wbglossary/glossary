import { useEffect, useState } from 'react';
import { Icon } from './Icon';

/** Короткие всплывающие сообщения внизу экрана: «Сохранено», «Скопировано». Ошибки остаются на странице. */
type Toast = { id: number; text: string; kind: 'ok' | 'info' };
let seq = 0;
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  window.dispatchEvent(new CustomEvent('gl-toast', { detail: { id: ++seq, text, kind } }));
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setList((l) => [...l.filter((x) => x.text !== t.text), t].slice(-3));
      window.setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 2600);
    };
    window.addEventListener('gl-toast', on);
    return () => window.removeEventListener('gl-toast', on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.kind}`}><Icon name={t.kind === 'ok' ? 'check' : 'help'} size={16} /> {t.text}</div>)}
    </div>
  );
}
