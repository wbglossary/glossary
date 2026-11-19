import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STATUS_LABEL, type LangStatus } from '../api';
import { Icon } from './Icon';

/** Статус всегда цветом и словом. */
export function StatusBadge({ status }: { status: LangStatus }) {
  return <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Button(p: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'link';
  disabled?: boolean; why?: string; type?: 'button' | 'submit'; small?: boolean; label?: string;
}) {
  return (
    <span className="btn-wrap">
      <button type={p.type ?? 'button'} className={`btn ${p.kind ?? 'secondary'}${p.small ? ' small' : ''}`}
        disabled={p.disabled} onClick={p.onClick} title={p.disabled ? p.why : p.label} aria-label={p.label}>
        {p.children}
      </button>
      {p.disabled && p.why ? <span className="why">{p.why}</span> : null}
    </span>
  );
}

export function Message({ kind, children, onClose }: { kind: 'ok' | 'error' | 'warn' | 'info'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`msg msg-${kind}`}>
      <div className="msg-body">{children}</div>
      {onClose ? <button className="msg-x" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={18} /></button> : null}
    </div>
  );
}

/** Окно подтверждения. requireText — пользователь должен ввести этот текст (например номер TB-). */
export function Confirm(p: {
  title: string; children?: ReactNode; confirmLabel: string; danger?: boolean; requireText?: string;
  onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ok = !p.requireText || typed.trim().toUpperCase() === p.requireText.toUpperCase();
  return (
    <div className="modal-back" onMouseDown={p.onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{p.title}</h3>
        <div className="modal-body">{p.children}</div>
        {p.requireText ? (
          <label className="field">
            <span>Чтобы подтвердить, впишите <b>{p.requireText}</b></span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        ) : null}
        <div className="modal-actions">
          <Button onClick={p.onCancel}>Отмена</Button>
          <Button kind={p.danger ? 'danger' : 'primary'} disabled={!ok || p.busy} onClick={p.onConfirm}
            why={!ok ? 'Впишите номер, чтобы подтвердить' : undefined}>{p.confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: ReactNode }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  if (!open) return null;
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div className="drawer-title">{title}</div>
        <button className="msg-x" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={18} /></button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="pager">
      <span>Всего: {total.toLocaleString('ru-RU')}</span>
      {pages > 1 ? (
        <>
          <Button small disabled={page <= 1} onClick={() => onPage(page - 1)} label="Предыдущая страница"><Icon name="left" /></Button>
          <span>Страница {page} из {pages}</span>
          <Button small disabled={page >= pages} onClick={() => onPage(page + 1)} label="Следующая страница"><Icon name="right" /></Button>
        </>
      ) : null}
    </div>
  );
}

/** Поле поиска с задержкой, чтобы не искать на каждую букву. */
export function SearchBox({ value, onChange, placeholder, big }: { value: string; onChange: (v: string) => void; placeholder?: string; big?: boolean }) {
  const [v, setV] = useState(value);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  return (
    <label className={big ? 'searchbox big' : 'searchbox'}><Icon name="search" size={big ? 20 : 16} /><input className={big ? 'search big' : 'search'} type="search" value={v} autoFocus={big}
      placeholder={placeholder ?? 'Поиск: русский термин, перевод или TB-'}
      onChange={(e) => {
        setV(e.target.value);
        window.clearTimeout(t.current);
        const nv = e.target.value;
        t.current = window.setTimeout(() => onChange(nv), 300);
      }} /></label>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1), setData };
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
