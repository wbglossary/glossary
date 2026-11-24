import { useState } from 'react';
import { fmtDate, rpc } from '../api';
import type { PageProps } from '../router';
import { Empty, Message, Pager, useAsync } from '../ui/kit';
import { LogCell } from '../logText';
import { TermDrawer } from '../ui/TermDrawer';

interface LogRow { id: number; at: string; user: string; action: string; tb: string | null; request_code: string | null; lang: string | null; before: string | null; after: string | null; details: string | null }
interface LogData { items: LogRow[]; total: number; page: number; pages: number; actions: string[]; users: { id: number; name: string }[] }

export function LogPage({ me }: PageProps) {
  const [f, setF] = useState({ from: '', to: '', user_id: '', tb: '', action: '', lang: '' });
  const [page, setPage] = useState(1);
  const [openTb, setOpenTb] = useState<string | null>(null);
  const { data, error, loading } = useAsync(() => rpc<LogData>('log_page', { p_f: f, p_page: page, p_size: 100 }), [JSON.stringify(f), page]);
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1); };
  const short = (s: string | null) => (s && s.length > 160 ? s.slice(0, 160) + '…' : s);
  return (
    <div>
      <h1>Журнал изменений</h1>
      <p className="muted">{me.role === 'owner' || me.is_en_validator ? 'Все изменения.' : 'Изменения вашего языка и русской части.'} Журнал нельзя изменить или очистить.</p>
      <div className="toolbar">
        <label>с <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label>по <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
        <select value={f.user_id} onChange={(e) => set('user_id', e.target.value)}>
          <option value="">Все пользователи</option>
          {data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input placeholder="TB- или Z-" value={f.tb} onChange={(e) => set('tb', e.target.value)} />
        <select value={f.action} onChange={(e) => set('action', e.target.value)}>
          <option value="">Все действия</option>
          {data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={f.lang} onChange={(e) => set('lang', e.target.value)}>
          <option value="">Все языки</option>
          {me.languages.map((l) => <option key={l.code} value={l.code}>{l.code}</option>)}
        </select>
      </div>
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Дата и время</th><th>Пользователь</th><th>Термин / заявка</th><th>Действие</th><th>Язык</th><th>Было</th><th>Стало</th><th>Подробности</th></tr></thead>
          <tbody>{data?.items.map((r) => (
            <tr key={r.id} className={openTb && r.tb === openTb ? 'sel' : ''}>
              <td className="nowrap">{fmtDate(r.at)}</td><td>{r.user}</td>
              <td className="tb nowrap">
                {r.tb ? <button className="btn link small tb-link" title={`Открыть карточку ${r.tb}`} onClick={() => setOpenTb(r.tb)}>{r.tb}</button> : null}
                {r.tb && r.request_code ? ' · ' : null}{r.request_code}
              </td>
              <td>{r.action}</td><td>{r.lang}</td><td><LogCell value={r.before} /></td><td><LogCell value={r.after} /></td><td className="muted small">{short(r.details)}</td>
            </tr>
          ))}</tbody>
        </table>
        {!loading && data && !data.items.length ? <Empty>Записей нет.</Empty> : null}
      </div>
      {data ? <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} /> : null}
      <TermDrawer me={me} id={null} tb={openTb} onClose={() => setOpenTb(null)} />
    </div>
  );
}
