import { useState } from 'react';
import { can, fmtDate, rpc, type DashCard, type GlossaryItem, type Page } from '../api';
import { go, type PageProps } from '../router';
import { Button, Empty, Message, SearchBox, useAsync } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { DEFAULT_COLS, FIELD_COLS, TermsTable, type FieldCol } from '../ui/TermsTable';
import { LangCellView } from '../ui/LangCellView';
import { Icon } from '../ui/Icon';

export function HomePage({ me }: PageProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const dash = useAsync(() => rpc<DashCard[]>('dashboard'), []);
  const recent = useAsync(() => rpc<(GlossaryItem & { created_at: string })[]>('recent_terms', { p_limit: 10 }), []);
  const found = useAsync(() => (q.trim() ? rpc<Page<GlossaryItem>>('glossary_page', { p_q: q, p_size: 50 }) : Promise.resolve(null)), [q]);
  const langs = (me.prefs.langs?.length ? me.prefs.langs : me.languages.filter((l) => l.active).map((l) => l.code));
  const cols = (me.prefs.cols ?? DEFAULT_COLS).filter((c): c is FieldCol => FIELD_COLS.some((f) => f.key === c));
  // В «Недавно добавленных» — русский и язык человека; у кого языка нет — языки из «Столбцы…» (или английский)
  const recentLangs = me.langs.length ? me.langs.map((l) => l.code) : me.prefs.langs?.length ? me.prefs.langs : ['EN'];
  const kind = (c: string) => me.languages.find((l) => l.code === c)?.kind ?? 'full';
  const cards = dash.data ?? [];
  const allDone = cards.length > 0 && cards.every((c) => c.count === 0);

  return (
    <div>
      <div className="home-search">
        <h1 style={{ margin: 0 }}>Найти термин</h1>
        <SearchBox big value={q} onChange={setQ} placeholder="Русский термин, перевод на любой язык или номер TB-" />
        {can.submit(me) ? <Button kind="primary" onClick={() => go('propose')}>Предложить термин</Button> : null}
      </div>

      {q.trim() ? (
        <>
          <h2>Результаты {found.data ? <span className="muted">· {found.data.total}</span> : null}</h2>
          {found.error ? <Message kind="error">{found.error}</Message> : null}
          <div className="table-wrap">
            {found.data ? <TermsTable me={me} items={found.data.items} langs={langs} cols={cols} openId={open} onOpen={setOpen} /> : null}
            {found.data && !found.data.items.length ? <Empty>Ничего не найдено. {can.submit(me) ? 'Можно предложить этот термин.' : ''}</Empty> : null}
          </div>
        </>
      ) : (
        <>
          {cards.length ? (
            <>
              <h2>Вас ждут</h2>
              {allDone ? <div className="done"><Icon name="check" /> Всё сделано</div> : null}
              <div className="dash">
                {cards.map((c) => (
                  <a key={c.key} href={`#/${c.link}`} className={c.count === 0 ? 'zero' : ''}>
                    <b>{c.count.toLocaleString('ru-RU')}</b><span>{c.label}</span>
                  </a>
                ))}
              </div>
            </>
          ) : null}
          <h2>Недавно добавленные</h2>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Номер</th><th>Русский термин</th><th>Определение</th>{recentLangs.map((l) => <th key={l}>{l}</th>)}<th>Добавлен</th></tr></thead>
              <tbody>{recent.data?.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)} style={{ cursor: 'pointer' }}>
                  <td className="tb">{r.tb}</td><td><b>{r.ru}</b></td>
                  <td className="muted"><div className="clip" title={r.definition}>{r.definition && r.definition !== '—' ? r.definition : ''}</div></td>
                  {recentLangs.map((l) => <LangCellView key={l} cell={r.cells[l]} kind={kind(l)} />)}
                  <td className="nowrap">{fmtDate(r.created_at, false)}</td>
                </tr>
              ))}</tbody>
            </table>
            {recent.data && !recent.data.length ? <Empty>Пока нет терминов.</Empty> : null}
          </div>
        </>
      )}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={() => { recent.reload(); found.reload(); dash.reload(); }} />
    </div>
  );
}
