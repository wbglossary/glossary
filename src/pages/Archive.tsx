import { useState } from 'react';
import { fmtDate, rpc, type Cell, type RequestItem } from '../api';
import type { PageProps } from '../router';
import { Button, Confirm, Empty, Message, SearchBox, useAsync } from '../ui/kit';
import { RequestDrawer } from '../ui/RequestDrawer';
import { TermDrawer } from '../ui/TermDrawer';

interface ArchTerm { id: number; tb: string; ru: string; definition: string; version: number; reason: string; updated_at: string; updated_by: string; cells: Record<string, Cell> }

export function ArchivePage({ me }: PageProps) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'terms' | 'rejected'>('terms');
  const { data, error, reload } = useAsync(() => rpc<{ can_restore: boolean; can_delete: boolean; terms: ArchTerm[]; rejected: RequestItem[] }>('archive_lists', { p_q: q || null }), [q]);
  const [open, setOpen] = useState<number | null>(null);
  const [openReq, setOpenReq] = useState<RequestItem | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'restore' | 'delete'; t: ArchTerm } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const act = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === 'restore') await rpc('restore_term', { p_term: confirm.t.id, p_version: confirm.t.version });
      else await rpc('delete_term', { p_term: confirm.t.id, p_typed_tb: confirm.t.tb });
      setMsg({ kind: 'ok', text: confirm.kind === 'restore' ? `${confirm.t.tb} возвращён в глоссарий.` : `${confirm.t.tb} удалён навсегда.` });
      reload();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    setConfirm(null);
  };

  return (
    <div>
      <h1>Архив</h1>
      <div className="toolbar">
        <div className="seg">
          <button className={tab === 'terms' ? 'on' : ''} onClick={() => setTab('terms')}>Термины в архиве ({data?.terms.length ?? '…'})</button>
          <button className={tab === 'rejected' ? 'on' : ''} onClick={() => setTab('rejected')}>Отклонённые заявки ({data?.rejected.length ?? '…'})</button>
        </div>
        <SearchBox value={q} onChange={setQ} />
      </div>
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      {error ? <Message kind="error">{error}</Message> : null}
      {tab === 'terms' ? (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Номер</th><th>Русский термин</th><th>Определение</th><th>Переводы</th><th>Почему в архиве</th><th>Когда, кто</th><th /></tr></thead>
            <tbody>{data?.terms.map((t) => (
              <tr key={t.id}>
                <td className="tb link" onClick={() => setOpen(t.id)}>{t.tb}</td>
                <td className="link" onClick={() => setOpen(t.id)}><b>{t.ru}</b></td>
                <td className="muted"><div className="clip" title={t.definition}>{t.definition}</div></td>
                <td className="small">{Object.entries(t.cells).map(([l, c]) => c.t.length ? `${l}: ${c.t[0]}` : null).filter(Boolean).join(' · ')}</td>
                <td>{t.reason}</td>
                <td className="small">{fmtDate(t.updated_at)}<div className="muted">{t.updated_by}</div></td>
                <td className="nowrap">
                  {data.can_restore ? <Button small kind="primary" onClick={() => setConfirm({ kind: 'restore', t })}>Вернуть</Button> : null}
                  {data.can_delete ? <Button small kind="danger" onClick={() => setConfirm({ kind: 'delete', t })}>Удалить окончательно</Button> : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {data && !data.terms.length ? <Empty>В архиве пусто.</Empty> : null}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Заявка</th><th>Что</th><th>Русский термин</th><th>Перевод</th><th>Отклонил</th><th>Когда</th></tr></thead>
            <tbody>{data?.rejected.map((r) => (
              <tr key={r.id} onClick={() => setOpenReq(r)} style={{ cursor: 'pointer' }}>
                <td className="link">{r.code}</td><td>{r.type_label}</td><td><b>{r.ru}</b></td>
                <td>{r.lang ? `${r.lang}: ${r.translation}` : ''}</td><td>{r.decided_by}</td><td className="nowrap">{fmtDate(r.decided_at)}</td>
              </tr>
            ))}</tbody>
          </table>
          {data && !data.rejected.length ? <Empty>Отклонённых заявок нет.</Empty> : null}
          <p className="muted small">Отклонённую заявку вернуть нельзя — при необходимости её подают заново.</p>
        </div>
      )}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={reload} list={data?.terms.map((t) => t.id)} onOpen={setOpen} />
      <RequestDrawer item={openReq} onClose={() => setOpenReq(null)} />
      {confirm?.kind === 'restore' ? (
        <Confirm title={`Вернуть ${confirm.t.tb} «${confirm.t.ru}»?`} confirmLabel="Вернуть" onCancel={() => setConfirm(null)} onConfirm={act}>
          Термин вернётся в глоссарий с теми же переводами и статусами, что были до архива.
        </Confirm>
      ) : null}
      {confirm?.kind === 'delete' ? (
        <Confirm title={`Удалить ${confirm.t.tb} «${confirm.t.ru}» навсегда?`} confirmLabel="Удалить навсегда" danger requireText={confirm.t.tb}
          onCancel={() => setConfirm(null)} onConfirm={act}>
          Термин и все переводы удалятся без возможности вернуть. В журнале останется запись, кто и когда удалил.
        </Confirm>
      ) : null}
    </div>
  );
}
