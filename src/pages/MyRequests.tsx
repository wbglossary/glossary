import { useState } from 'react';
import { fmtDate, rpc, type RequestItem } from '../api';
import type { PageProps } from '../router';
import { Empty, Message, useAsync } from '../ui/kit';
import { RequestDrawer } from '../ui/RequestDrawer';
import { Icon } from '../ui/Icon';

const CLS: Record<string, string> = { pending: 'st-draft', approved: 'st-approved', rejected: 'st-need', auto_removed: 'st-unused', closed: 'st-unused', withdrawn: 'st-unused' };

export function MyRequestsPage(_: PageProps) {
  const { data, error, loading, reload } = useAsync(() => rpc<RequestItem[]>('my_requests'), []);
  const [open, setOpen] = useState<RequestItem | null>(null);
  const items = data ?? [];
  return (
    <div>
      <h1>Мои заявки</h1>
      <p className="muted">Откройте заявку, чтобы исправить её или отозвать. Отозвать можно, пока по ней никто не начал работать: не вписал перевод и не принял решение.</p>
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Заявка</th><th>Что</th><th>Русский термин</th><th>Перевод</th><th>Статус</th><th>Подана</th><th>Номер</th></tr></thead>
          <tbody>{items.map((r) => (
            <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
              <td className="link">{r.code}{r.comments ? <span className="ccount"><Icon name="comment" size={13} />{r.comments}</span> : null}</td>
              <td>{r.type_label}</td>
              <td><b>{r.ru}</b></td>
              <td>{r.lang ? `${r.lang}: ${r.translation}` : r.type === 'new' ? (r.target_langs?.length ? `на ${r.target_langs.join(', ')}` : 'на все языки') : ''}</td>
              <td><span className={`badge ${CLS[r.status] ?? ''}`}>{r.status_label}</span></td>
              <td className="nowrap">{fmtDate(r.created_at)}</td>
              <td className="tb">{r.status === 'approved' ? r.tb : ''}</td>
            </tr>
          ))}</tbody>
        </table>
        {!loading && !items.length ? <Empty>Вы ещё не подавали заявок.</Empty> : null}
      </div>
      <RequestDrawer item={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />
    </div>
  );
}
