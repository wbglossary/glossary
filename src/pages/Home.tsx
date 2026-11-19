import { useState } from 'react';
import { can, fmtDate, rpc, type DashCard, type GlossaryItem, type Page } from '../api';
import { go, type PageProps } from '../router';
import { Button, Empty, Message, SearchBox, useAsync } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { TermsTable } from '../ui/TermsTable';
import { Icon } from '../ui/Icon';

export function HomePage({ me }: PageProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const dash = useAsync(() => rpc<DashCard[]>('dashboard'), []);
  const recent = useAsync(() => rpc<(GlossaryItem & { created_at: string })[]>('recent_terms', { p_limit: 10 }), []);
  const found = useAsync(() => (q.trim() ? rpc<Page<GlossaryItem>>('glossary_page', { p_q: q, p_size: 50 }) : Promise.resolve(null)), [q]);
  const langs = (me.prefs.langs?.length ? me.prefs.langs : me.languages.filter((l) => l.active).map((l) => l.code));
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
            {found.data ? <TermsTable me={me} items={found.data.items} langs={langs} openId={open} onOpen={setOpen} /> : null}
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
              <thead><tr><th>Номер</th><th>Русский термин</th><th>Значение или контекст</th><th>Добавлен</th><th>Переводы</th></tr></thead>
              <tbody>{recent.data?.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)} style={{ cursor: 'pointer' }}>
                  <td className="tb">{r.tb}</td><td><b>{r.ru}</b></td><td className="muted">{r.context}</td>
                  <td className="nowrap">{fmtDate(r.created_at, false)}</td>
                  <td className="small">{Object.entries(r.cells).filter(([, c]) => c.t.length).map(([l, c]) => `${l}: ${c.t[0]}`).join(' · ')}</td>
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
