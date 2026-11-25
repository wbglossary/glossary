import { useState } from 'react';
import { can, fmtDate, rpc, type RequestItem } from '../api';
import { go, type PageProps } from '../router';
import { AuthorChip } from '../ui/bits';
import { Button, Empty, Message, SearchBox, useAsync } from '../ui/kit';
import { HelpLink } from '../ui/HelpLink';
import { RequestDrawer } from '../ui/RequestDrawer';
import { Icon } from '../ui/Icon';

const CLS: Record<string, string> = { pending: 'st-draft', approved: 'st-approved', rejected: 'st-need', auto_removed: 'st-unused', closed: 'st-unused', withdrawn: 'st-unused' };

export function MyRequestsPage({ me, route }: PageProps) {
  const seeAll = can.allRequests(me);
  const [tab, setTab] = useState<'mine' | 'all'>(seeAll && route.params.get('tab') === 'all' ? 'all' : 'mine');
  const [status, setStatus] = useState<'pending' | 'done' | 'all'>('pending');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useAsync(
    () => (tab === 'mine' ? rpc<RequestItem[]>('my_requests') : rpc<RequestItem[]>('all_requests', { p_status: 'all', p_q: null })), [tab]);
  const [open, setOpen] = useState<RequestItem | null>(null);
  const all = data ?? [];
  const ql = q.trim().toLowerCase();
  const found = ql ? all.filter((r) => [r.code, r.ru, r.translation, r.tb].some((x) => x && String(x).toLowerCase().includes(ql))) : all;
  const isDone = (r: RequestItem) => r.status !== 'pending';
  const counts = { pending: found.filter((r) => !isDone(r)).length, done: found.filter(isDone).length, all: found.length };
  const items = status === 'all' ? found : found.filter((r) => (status === 'done') === isDone(r));
  return (
    <div>
      <h1>{seeAll ? 'Заявки' : 'Мои заявки'} <HelpLink topics={['Отозвать заявку', 'Все заявки', 'Заявки']} /></h1>
      {seeAll ? (
        <div className="page-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>Мои</button>
          <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Все заявки</button>
        </div>
      ) : null}
      <div className="chips" role="group" aria-label="Статус заявки">
        {([['pending', 'На рассмотрении'], ['done', 'Рассмотренные'], ['all', 'Все']] as const).map(([k, l]) => (
          <button key={k} className={`chip${status === k ? ' on' : ''}`} aria-pressed={status === k} onClick={() => setStatus(k)}>{l} · {data ? counts[k] : '…'}</button>
        ))}
      </div>
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Русский термин, перевод, Z- или TB-" />
      </div>
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
        {!loading && !items.length ? (tab === 'mine' && !all.length
          ? <Empty icon="inbox" action={can.submit(me) ? <Button kind="primary" onClick={() => go('propose')}>Предложить термин</Button> : null}>
              <b>Вы ещё не подавали заявок.</b><br />Не нашли термин в глоссарии? Предложите его — заявка появится здесь.</Empty>
          : <Empty icon="inbox">{ql ? 'По этому запросу заявок нет.' : status === 'pending' ? 'Сейчас ничего не ждёт рассмотрения.' : 'Заявок нет.'}</Empty>) : null}
        {loading ? <div className="empty">Загрузка…</div> : null}
      </div>
      <RequestDrawer item={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />
    </div>
  );
}
