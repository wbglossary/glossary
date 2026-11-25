import type { GlossaryItem, Me } from '../api';
import { CopyButton } from './bits';
import { LangCellView } from './LangCellView';
import { Highlight } from './Highlight';

/** Поля русской части, которые можно показать столбцами. Порядок — как в карточке термина. */
export const FIELD_COLS = [
  { key: 'definition', label: 'Определение' },
  { key: 'examples', label: 'Примеры' },
  { key: 'projects', label: 'Проекты' },
  { key: 'comment', label: 'Комментарий' },
  { key: 'lang_comment', label: 'Комментарии лингвистов (под переводом)' }
] as const;
export type FieldCol = (typeof FIELD_COLS)[number]['key'];
export const DEFAULT_COLS: FieldCol[] = ['definition', 'examples', 'projects', 'lang_comment'];

const text = (r: GlossaryItem, k: Exclude<FieldCol, 'lang_comment'>) => {
  const v = k === 'projects' ? r.projects.join(', ') : (r[k] ?? '');
  return v.trim() === '—' ? '' : v;
};

/** Таблица терминов: одна строка — один термин; столбцы полей и языков выбирает сам пользователь. */
export type SortKey = 'ru' | '-ru' | 'tb' | '-tb' | 'new' | 'updated';
/** Серые заглушки строк, пока таблица грузится */
export function SkeletonRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <table className="grid skeleton" aria-busy="true" aria-label="Загрузка">
      <tbody>{Array.from({ length: rows }, (_, i) => (
        <tr key={i}>{Array.from({ length: cols }, (_, j) => <td key={j}><span className="sk" style={{ width: `${40 + ((i * 7 + j * 13) % 50)}%` }} /></td>)}</tr>
      ))}</tbody>
    </table>
  );
}

export function TermsTable({ me, items, langs, cols = DEFAULT_COLS, openId, onOpen, selected, onSelect, q, sort, onSort }: {
  me: Me; items: GlossaryItem[]; langs: string[]; cols?: FieldCol[]; openId?: number | null; onOpen: (id: number) => void;
  selected?: number[]; onSelect?: (ids: number[]) => void;   // галочки — только когда передан onSelect
  q?: string; sort?: SortKey; onSort?: (s: SortKey) => void;
}) {
  const sel = selected ?? [];
  const pageIds = items.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => sel.includes(id));
  const kind = (c: string) => me.languages.find((l) => l.code === c)?.kind ?? 'full';
  const fields = FIELD_COLS.filter((f) => cols.includes(f.key) && f.key !== 'lang_comment') as { key: Exclude<FieldCol, 'lang_comment'>; label: string }[];
  const langComment = cols.includes('lang_comment');
  return (
    <table className={`grid sticky cards-sm${onSelect ? ' with-check' : ''}`}>
      <thead>
        <tr>
          {onSelect ? <th className="check-col s0"><input type="checkbox" aria-label="Отметить все на странице" checked={allOnPage}
            onChange={(e) => onSelect(e.target.checked ? [...new Set([...sel, ...pageIds])] : sel.filter((x) => !pageIds.includes(x)))} /></th> : null}
          <SortTh k="tb" label="Номер" className="s1" sort={sort} onSort={onSort} /><SortTh k="ru" label="Русский термин" className="s2" sort={sort} onSort={onSort} />
          {fields.map((f) => <th key={f.key}>{f.label}</th>)}
          {langs.map((c) => <th key={c} title={me.languages.find((l) => l.code === c)?.name}>{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id} className={openId === r.id || sel.includes(r.id) ? 'sel' : ''} onClick={() => onOpen(r.id)} style={{ cursor: 'pointer' }}>
            {onSelect ? <td className="check-col s0" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Отметить ${r.tb}`} checked={sel.includes(r.id)}
              onChange={(e) => onSelect(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td> : null}
            <td className="tb s1"><Highlight text={r.tb} q={q ?? ''} /></td>
            <td className="s2">
              <b><Highlight text={r.ru} q={q ?? ''} /></b><CopyButton text={r.ru} />
              {r.obsolete_request ? <span className="badge st-draft" title={r.obsolete_request.reason} style={{ marginLeft: 6 }}>Предложено: устарел</span> : null}
              {r.forbidden_hit?.length ? (
                <div className="small" style={{ color: 'var(--red)' }}>
                  {r.forbidden_hit.map((h, i) => <div key={i}>«{h.text}» ({h.lang}) — неправильный вариант{h.good ? `, правильно: «${h.good}»` : ''}</div>)}
                </div>
              ) : null}
            </td>
            {fields.map((f) => {
              const v = text(r, f.key);
              return (
                <td key={f.key} data-label={f.label} className={`field-col fc-${f.key}${f.key === 'projects' ? '' : ' muted'}`}>
                  {v ? <div className="clip" title={v}>{v}</div> : null}
                </td>
              );
            })}
            {langs.map((c) => <LangCellView key={c} cell={r.cells[c]} kind={kind(c)} replaced={r.replaced.filter((x) => x.lang === c)} showComment={langComment} label={c} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Заголовок колонки с сортировкой: нажатие — по возрастанию, ещё раз — по убыванию */
function SortTh({ k, label, className, sort, onSort }: { k: 'ru' | 'tb'; label: string; className?: string; sort?: SortKey; onSort?: (s: SortKey) => void }) {
  if (!onSort) return <th className={className}>{label}</th>;
  const on = sort === k || sort === `-${k}`;
  const desc = sort === `-${k}`;
  return (
    <th className={`${className ?? ''} sortable`} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button className="sort-btn" onClick={() => onSort(on && !desc ? (`-${k}` as SortKey) : k)} title="Сортировать">
        {label} <span className={`sort-ic${on ? ' on' : ''}`}>{on ? (desc ? '↓' : '↑') : '↕'}</span>
      </button>
    </th>
  );
}
