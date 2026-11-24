import { useState } from 'react';
import { can, fmtDate, rpc, type RequestItem } from '../api';
import type { PageProps } from '../router';
import { AuthorChip } from '../ui/bits';
import { Empty, Message, SearchBox, useAsync } from '../ui/kit';
import { RequestDrawer } from '../ui/RequestDrawer';
import { Icon } from '../ui/Icon';

const CLS: Record<string, string> = { pending: 'st-draft', approved: 'st-approved', rejected: 'st-need', auto_removed: 'st-unused', closed: 'st-unused', withdrawn: 'st-unused' };

export function MyRequestsPage({ me }: PageProps) {
  const seeAll = can.allRequests(me);
  const [tab, setTab] = useState<'mine' | 'all'>('mine');
  const [status, setStatus] = useState<'pending' | 'done' | 'all'>('pending');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useAsync(
    () => (tab === 'mine' ? rpc<RequestItem[]>('my_requests') : rpc<RequestItem[]>('all_requests', { p_status: status, p_q: q || null })),
    [tab, status, q]);
  const [open, setOpen] = useState<RequestItem | null>(null);
  const items = data ?? [];
  return (
    <div>
      <h1>{seeAll ? 'Заявки' : 'Мои заявки'}</h1>
      {seeAll ? (
        <div className="toolbar">
          <div className="seg">
            <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>Мои</button>
            <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Все заявки</button>
          </div>
          {tab === 'all' ? (
            <>
              <div className="seg">
                {([['pending', 'На рассмотрении'], ['done', 'Рассмотренные'], ['all', 'Все']] as const).map(([k, l]) => (
                  <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
                ))}
              </div>
              <SearchBox value={q} onChange={setQ} placeholder="Русский термин или Z-" />
            </>
          ) : null}
        </div>
      ) : null}
      <p className="muted">{tab === 'mine'
        ? 'Откройте заявку, чтобы исправить её или отозвать. Отозвать можно, пока по ней никто не начал работать: не вписал перевод и не принял решение.'
        : 'Заявки всех людей. Откройте заявку, чтобы посмотреть подробности и написать комментарий.'}</p>
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Заявка</th><th>Что</th><th>Русский термин</th><th>Перевод</th>{tab === 'all' ? <th>Автор</th> : null}<th>Статус</th><th>Подана</th><th>Номер</th></tr></thead>
          <tbody>{items.map((r) => (
            <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
              <td className="link">{r.code}{r.comments ? <span className="ccount"><Icon name="comment" size={13} />{r.comments}</span> : null}</td>
              <td>{r.type_label}</td>
              <td><b>{r.ru}</b></td>
              <td>{r.lang ? `${r.lang}: ${r.translation}` : r.type === 'new' ? (r.target_langs?.length ? `на ${r.target_langs.join(', ')}` : 'на все языки') : ''}</td>
              {tab === 'all' ? <td><AuthorChip a={r.author} /></td> : null}
              <td><span className={`badge ${CLS[r.status] ?? ''}`}>{r.status_label}</span></td>
              <td className="nowrap">{fmtDate(r.created_at)}</td>
              <td className="tb">{r.status === 'approved' ? r.tb : ''}</td>
            </tr>
          ))}</tbody>
        </table>
        {!loading && !items.length ? <Empty>{tab === 'mine' ? 'Вы ещё не подавали заявок.' : 'Заявок нет.'}</Empty> : null}
        {loading ? <div className="empty">Загрузка…</div> : null}
      </div>
      <RequestDrawer item={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />
    </div>
  );
}
