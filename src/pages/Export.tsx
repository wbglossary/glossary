import { useState } from 'react';
import { fmtDate, rpc } from '../api';
import { buildContractorXlsx, buildXml, buildViewXlsx, buildXlsx, download, type ContractorData, type ExportData, type ViewData } from '../exportFile';
import type { PageProps } from '../router';
import { Button, Empty, Message, useAsync } from '../ui/kit';

interface Hist { id: number; at: string; user: string; langs: string[]; project: string; format: string; count: number }

export function ExportPage({ me }: PageProps) {
  const full = me.languages.filter((l) => l.active && l.kind === 'full');
  const [langs, setLangs] = useState<string[]>(full.map((l) => l.code));
  const [project, setProject] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // сначала — сокращённые языки (их переводят подрядчики), потом остальные
  const contractorLangs = [...me.languages.filter((l) => l.active && l.kind === 'short'), ...me.languages.filter((l) => l.active && l.kind === 'full')];
  const [cLangs, setCLangs] = useState<string[]>(me.languages.filter((l) => l.active && l.kind === 'short').map((l) => l.code));
  const count = useAsync(() => rpc<number>('export_count', { p_project: project }), [project]);
  const hist = useAsync(() => rpc<Hist[]>('export_history'), []);

  const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const projName = project ? me.projects.find((p) => p.id === project)?.name ?? '' : 'все проекты';
  const base = `Глоссарий — ${projName} — ${stamp()}`;

  const run = async (format: 'xlsx' | 'xml' | 'view') => {
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
        download(format === 'xlsx' ? await buildXlsx(d) : buildXml(d, base), `${base}.${format}`);
      }
      await rpc('log_export', { p_langs: format === 'view' ? me.languages.filter((l) => l.active).map((l) => l.code) : langs, p_project: project,
        p_format: format === 'view' ? 'xlsx (просмотр)' : format, p_count: n });
      setMsg({ kind: 'ok', text: `Файл скачан, терминов: ${n}.` });
      hist.reload();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };

  const runContractor = async () => {
    setBusy('contractor'); setMsg(null);
    try {
      const d = await rpc<ContractorData>('export_contractor', { p_langs: cLangs, p_project: project });
      if (!d.terms.length) { setMsg({ kind: 'ok', text: 'На выбранных языках всё уже переведено — выгружать нечего.' }); return; }
      download(await buildContractorXlsx(d), `${base} — перевести ${cLangs.join(', ')}.xlsx`);
      await rpc('log_export', { p_langs: cLangs, p_project: project, p_format: 'xlsx (для подрядчика)', p_count: d.terms.length });
      setMsg({ kind: 'ok', text: `Файл скачан, терминов: ${d.terms.length}.` });
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
        <div className="field"><span>Языки для Smartcat и XML</span>
          <div className="checks">{full.map((l) => (
            <label key={l.code}><input type="checkbox" checked={langs.includes(l.code)}
              onChange={(e) => setLangs(e.target.checked ? [...langs, l.code] : langs.filter((x) => x !== l.code))} /> {l.code} — {l.name}</label>
          ))}</div>
          <span className="muted small">Сокращённые глоссарии подрядчиков ({me.languages.filter((l) => l.kind === 'short').map((l) => l.code).join(', ') || '—'}) в Smartcat не выгружаются.</span>
        </div>
        <p>Терминов будет выгружено: <b>{count.data ?? '…'}</b>. Попадают согласованные переводы, а у языков без валидатора (например, TR, SW) — и «Без проверки». «Не актуально для языка» — пустая ячейка.</p>
        {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
        <div className="actions">
          <Button kind="primary" disabled={!!busy} onClick={() => run('xlsx')}>{busy === 'xlsx' ? 'Готовлю…' : 'Скачать для Smartcat (.xlsx)'}</Button>
          <Button disabled={!!busy} onClick={() => run('xml')}>{busy === 'xml' ? 'Готовлю…' : 'Скачать XML'}</Button>
          <Button disabled={!!busy} onClick={() => run('view')}>{busy === 'view' ? 'Готовлю…' : 'Таблица для просмотра (.xlsx)'}</Button>
        </div>
        <p className="muted small">В файле для Smartcat в колонку Comments попадает русское определение. Таблица для просмотра — все языки со статусами, пустые ячейки красные.</p>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Для подрядчиков: что перевести</h3>
        <p className="muted small">Файл с терминами, у которых на выбранных языках ещё нет перевода (проект — как выбран выше). Подрядчик вписывает переводы в жёлтые ячейки, а готовый файл загружается в «Загрузку терминов».</p>
        <div className="checks">{contractorLangs.map((l) => (
          <label key={l.code}><input type="checkbox" checked={cLangs.includes(l.code)}
            onChange={(e) => setCLangs(e.target.checked ? [...cLangs, l.code] : cLangs.filter((x) => x !== l.code))} /> {l.code} — {l.name}{l.kind === 'short' ? ' (сокр.)' : ''}</label>
        ))}</div>
        <div className="actions">
          <Button kind="primary" disabled={!!busy || !cLangs.length} why={!cLangs.length ? 'Отметьте языки' : undefined} onClick={runContractor}>
            {busy === 'contractor' ? 'Готовлю…' : 'Скачать пустые для подрядчика (.xlsx)'}</Button>
        </div>
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
