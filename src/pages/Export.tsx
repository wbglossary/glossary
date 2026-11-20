import { useState } from 'react';
import { fmtDate, rpc } from '../api';
import { buildTbx, buildViewXlsx, buildXlsx, download, type ExportData, type ViewData } from '../exportFile';
import type { PageProps } from '../router';
import { Button, Empty, Message, useAsync } from '../ui/kit';

interface Hist { id: number; at: string; user: string; langs: string[]; project: string; format: string; count: number }

export function ExportPage({ me }: PageProps) {
  const full = me.languages.filter((l) => l.active && l.kind === 'full');
  const [langs, setLangs] = useState<string[]>(full.map((l) => l.code));
  const [project, setProject] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const count = useAsync(() => rpc<number>('export_count', { p_project: project }), [project]);
  const hist = useAsync(() => rpc<Hist[]>('export_history'), []);

  const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const projName = project ? me.projects.find((p) => p.id === project)?.name ?? '' : 'все проекты';
  const base = `Глоссарий — ${projName} — ${stamp()}`;

  const run = async (format: 'xlsx' | 'tbx' | 'view') => {
    if (format !== 'view' && !langs.length) return setMsg({ kind: 'error', text: 'Выберите хотя бы один язык.' });
    setBusy(format); setMsg(null);
    try {
      let n = 0;
      if (format === 'view') {
        const d = await rpc<ViewData>('export_view', { p_project: project });
        n = d.terms.length;
        download(await buildViewXlsx(d), `${base} — просмотр.xlsx`);
      } else {
        const d = await rpc<ExportData>('export_data', { p_langs: langs, p_project: project });
        n = d.terms.length;
        download(format === 'xlsx' ? await buildXlsx(d) : buildTbx(d, base), `${base}.${format}`);
      }
      await rpc('log_export', { p_langs: format === 'view' ? me.languages.filter((l) => l.active).map((l) => l.code) : langs, p_project: project,
        p_format: format === 'view' ? 'xlsx (просмотр)' : format, p_count: n });
      setMsg({ kind: 'ok', text: `Файл скачан, терминов: ${n}.` });
      hist.reload();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };

  return (
    <div className="narrow">
      <h1>Выгрузка</h1>
      <div className="card">
        <label className="field"><span>Проект</span>
          <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Все проекты</option>
            {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.closed ? ' (закрыт)' : ''}</option>)}
          </select>
        </label>
        <div className="field"><span>Языки для Smartcat и TBX</span>
          <div className="checks">{full.map((l) => (
            <label key={l.code}><input type="checkbox" checked={langs.includes(l.code)}
              onChange={(e) => setLangs(e.target.checked ? [...langs, l.code] : langs.filter((x) => x !== l.code))} /> {l.code} — {l.name}</label>
          ))}</div>
          <span className="muted small">Сокращённые глоссарии подрядчиков ({me.languages.filter((l) => l.kind === 'short').map((l) => l.code).join(', ') || '—'}) в Smartcat не выгружаются.</span>
        </div>
        <p>Терминов будет выгружено: <b>{count.data ?? '…'}</b>. Попадают только согласованные переводы; «Не актуально для языка» — пустая ячейка.</p>
        {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
        <div className="actions">
          <Button kind="primary" disabled={!!busy} onClick={() => run('xlsx')}>{busy === 'xlsx' ? 'Готовлю…' : 'Скачать для Smartcat (.xlsx)'}</Button>
          <Button disabled={!!busy} onClick={() => run('tbx')}>{busy === 'tbx' ? 'Готовлю…' : 'Скачать TBX'}</Button>
          <Button disabled={!!busy} onClick={() => run('view')}>{busy === 'view' ? 'Готовлю…' : 'Таблица для просмотра (.xlsx)'}</Button>
        </div>
        <p className="muted small">В файле для Smartcat заметки по языкам и «Нельзя: …» попадают в колонку Comments. Таблица для просмотра — все языки со статусами, пустые ячейки красные.</p>
      </div>
      <h3>Последние выгрузки</h3>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Когда</th><th>Кто</th><th>Проект</th><th>Формат</th><th>Языки</th><th>Терминов</th></tr></thead>
          <tbody>{hist.data?.map((h) => (
            <tr key={h.id}><td className="nowrap">{fmtDate(h.at)}</td><td>{h.user}</td><td>{h.project}</td><td>{h.format}</td><td className="small">{h.langs.join(', ')}</td><td>{h.count}</td></tr>
          ))}</tbody>
        </table>
        {hist.data && !hist.data.length ? <Empty>Выгрузок ещё не было.</Empty> : null}
      </div>
    </div>
  );
}
