import { useState } from 'react';
import type { Author } from '../api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { toast } from './Toasts';

/** Кнопка «Скопировать»: один клик — текст в буфере. */
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <>
      <button className="copy" title="Скопировать" aria-label="Скопировать"
        onClick={async (e) => {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(text); } catch {
            const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
          }
          setDone(true); setTimeout(() => setDone(false), 1200); toast('Скопировано');
        }}><Icon name={done ? 'check' : 'copy'} size={14} /></button>
    </>
  );
}

export function AuthorChip({ a, size = 20 }: { a: Author; size?: number }) {
  return <span className="author"><Avatar name={a.avatar} size={size} /> {a.name}</span>;
}
