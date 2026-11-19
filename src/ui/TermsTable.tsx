import type { GlossaryItem, Me } from '../api';
import { CopyButton } from './bits';
import { LangCellView } from './LangCellView';

/** Таблица терминов: одна строка — один термин со всеми языками. */
export function TermsTable({ me, items, langs, openId, onOpen }: {
  me: Me; items: GlossaryItem[]; langs: string[]; openId?: number | null; onOpen: (id: number) => void;
}) {
  const kind = (c: string) => me.languages.find((l) => l.code === c)?.kind ?? 'full';
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Номер</th><th>Русский термин</th><th>Значение или контекст</th><th>Проекты</th>
          {langs.map((c) => <th key={c}>{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id} className={openId === r.id ? 'sel' : ''} onClick={() => onOpen(r.id)} style={{ cursor: 'pointer' }}>
            <td className="tb">{r.tb}</td>
            <td>
              <b>{r.ru}</b><CopyButton text={r.ru} />
              {r.obsolete_request ? <span className="badge st-draft" title={r.obsolete_request.reason} style={{ marginLeft: 6 }}>Предложено: устарел</span> : null}
              {r.forbidden_hit?.length ? (
                <div className="small" style={{ color: 'var(--red)' }}>
                  {r.forbidden_hit.map((h, i) => <div key={i}>«{h.text}» ({h.lang}) — неправильный вариант{h.good ? `, правильно: «${h.good}»` : ''}</div>)}
                </div>
              ) : null}
            </td>
            <td className="muted">{r.context}</td>
            <td>{r.projects.join(', ')}</td>
            {langs.map((c) => <LangCellView key={c} cell={r.cells[c]} kind={kind(c)} replaced={r.replaced.filter((x) => x.lang === c)} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
