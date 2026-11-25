import { useState } from 'react';
import { fmtDate, rpc } from '../api';
import { buildContractorXlsx, buildXml, buildViewXlsx, buildXlsx, download, type ContractorData, type ExportData, type ViewData } from '../exportFile';
import type { PageProps } from '../router';
import { Button, Empty, Message, useAsync } from '../ui/kit';
import { HelpLink } from '../ui/HelpLink';
import { Icon } from '../ui/Icon';

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
  const count = useAsync(() => rpc<number>('export_count', { p_project: project, p_langs: langs }), [project, langs.join(',')]);
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

  const LangChips = ({ list }: { list: string[] }) => (
    <span className="lang-chips" title={list.join(', ')}>
      {list.slice(0, 4).map((l) => <span key={l} className="badge">{l}</span>)}
      {list.length > 4 ? <span className="badge more">+{list.length - 4}</span> : null}
    </span>
  );
  const fmtIcon = (f: string) => (f.includes('подряд') ? 'upload' : f.includes('xml') ? 'book' : f.includes('просмотр') ? 'eye' : 'download');
  const FORMATS = [
    { key: 'xlsx' as const, icon: 'download', title: 'Для Smartcat', btn: 'Скачать .xlsx', primary: true,
      what: 'Загрузите в Smartcat как глоссарий. Выбранные языки, в «Comments» — русское определение.' },
    { key: 'xml' as const, icon: 'book', title: 'XML', btn: 'Скачать .xml',
      what: 'Те же термины и языки, но в формате XML — для других программ.' },
    { key: 'view' as const, icon: 'eye', title: 'Таблица для просмотра', btn: 'Скачать .xlsx',
      what: 'Все языки со статусами, чтобы посмотреть глазами. Пустые ячейки — красные.' }
  ];

  return (
    <div className="narrow">
      <h1>Выгрузка <HelpLink topics={['Скачать для Smartcat', 'Отправить подрядчику, что перевести']} /></h1>
      <div className="card steps">
        <h3 className="step-title"><span className="step-n">1</span> Что выгружаем</h3>
        <label className="field"><span>Проект</span>
          <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Все проекты</option>
            {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.closed ? ' (закрыт)' : ''}</option>)}
          </select>
        </label>
        <div className="field"><span>Языки для Smartcat и XML <span className="muted">· выбрано {langs.length}</span></span>
          <div className="row gap quick-pick">
            <Button small onClick={() => setLangs(full.map((l) => l.code))}>Все</Button>
            <Button small kind="link" onClick={() => setLangs([])}>Снять все</Button>
          </div>
          <div className="checks">{full.map((l) => (
            <label key={l.code}><input type="checkbox" checked={langs.includes(l.code)}
              onChange={(e) => setLangs(e.target.checked ? [...langs, l.code] : langs.filter((x) => x !== l.code))} /> {l.code} — {l.name}</label>
          ))}</div>
        </div>

        <h3 className="step-title"><span className="step-n">2</span> Сколько получится</h3>
        <div className="big-count"><b>{count.data?.toLocaleString('ru-RU') ?? '…'}</b> {count.data === undefined || count.data === null ? '' : plural(count.data, 'термин', 'термина', 'терминов')}</div>
        <details className="more-info">
          <summary>Что попадёт в файл</summary>
          <ul>
            <li>Согласованные переводы. У языков без валидатора (например, TR, SW) — ещё и «Без проверки».</li>
            <li>«Не актуально для языка» — пустая ячейка.</li>
            <li>Термины без единого перевода на выбранные языки в файл не попадают.</li>
            <li>Сокращённые языки ({me.languages.filter((l) => l.kind === 'short').map((l) => l.code).join(', ') || '—'}) в Smartcat не выгружаются.</li>
          </ul>
        </details>

        <h3 className="step-title"><span className="step-n">3</span> Скачать</h3>
        {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
        <div className="format-tiles">
          {FORMATS.map((f) => (
            <div key={f.key} className={`format-tile${f.primary ? ' main' : ''}`}>
              <span className="ft-ico"><Icon name={f.icon} size={18} /></span>
              <b>{f.title}</b>
              <span className="muted small">{f.what}</span>
              <Button kind={f.primary ? 'primary' : undefined} small disabled={!!busy} onClick={() => run(f.key)}>{busy === f.key ? 'Готовлю…' : f.btn}</Button>
            </div>
          ))}
        </div>
      </div>

      <div className="card contractor-card">
        <h3 className="step-title"><span className="step-n alt"><Icon name="upload" size={14} /></span> Для подрядчиков: что перевести</h3>
        <p className="muted small">Файл с терминами, у которых на выбранных языках ещё нет перевода (проект — как выбран выше).
          Подрядчик вписывает переводы в жёлтые ячейки, а готовый файл загружается в «Загрузку терминов».</p>
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
          <thead><tr><th>Формат</th><th>Когда</th><th>Кто</th><th>Проект</th><th>Языки</th><th>Терминов</th></tr></thead>
          <tbody>{hist.data?.map((h) => (
            <tr key={h.id}>
              <td className="nowrap"><span className="fmt"><Icon name={fmtIcon(h.format)} size={14} /> {h.format}</span></td>
              <td className="nowrap">{fmtDate(h.at)}</td><td>{h.user}</td><td>{h.project}</td><td><LangChips list={h.langs} /></td><td>{h.count}</td>
            </tr>
          ))}</tbody>
        </table>
        {hist.data && !hist.data.length ? <Empty icon="download">Выгрузок ещё не было.</Empty> : null}
      </div>
    </div>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
