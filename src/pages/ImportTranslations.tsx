import { useState } from 'react';
import { rpc } from '../api';
import type { PageProps } from '../router';
import { Button, Message } from '../ui/kit';

/** Загрузка готовых переводов от подрядчиков: файл .xlsx → проверка совпадений → «Без проверки». */

interface Row { row: number; tb: string | null; ru: string; text: string; current: string | null; status: 'add' | 'same' | 'differs' | 'not_found' | 'ambiguous' | 'empty' }
interface Sheet { name: string; header: string[]; rows: string[][] }

const STATUS: Record<Row['status'], { label: string; cls: string }> = {
  add: { label: 'будет добавлен', cls: 'st-approved' },
  same: { label: 'уже есть такой же', cls: 'st-unused' },
  differs: { label: 'уже есть другой перевод — пропущен', cls: 'st-draft' },
  not_found: { label: 'термин не найден', cls: 'st-need' },
  ambiguous: { label: 'несколько терминов с таким русским — укажите номер TB', cls: 'st-need' },
  empty: { label: 'пустой перевод', cls: 'st-unused' }
};

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (o.richText) return o.richText.map((x) => x.text).join('');
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return '';
  }
  return String(v).trim();
};

const guess = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h));

export function ImportTranslationsPage({ me }: PageProps) {
  const allowed = me.languages.filter((l) => l.active && (l.kind === 'short' || !l.has_validator));
  const [lang, setLang] = useState(allowed[0]?.code ?? '');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIx, setSheetIx] = useState(0);
  const [colTb, setColTb] = useState(-1);
  const [colRu, setColRu] = useState(-1);
  const [colTr, setColTr] = useState(-1);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const sheet = sheets[sheetIx];

  const pickSheet = (list: Sheet[], ix: number, lg = lang) => {
    setSheetIx(ix); setCheck(null);
    const h = list[ix]?.header ?? [];
    const L = me.languages.find((l) => l.code === lg);
    setColTb(guess(h, /^\s*(tb|номер)/i));
    setColRu(guess(h, /рус|^\s*ru\b|russian|термин/i));
    const byLang = L ? h.findIndex((x) => new RegExp(`\\b${L.code}\\b|${L.name.slice(0, 5)}`, 'i').test(x)) : -1;
    setColTr(byLang >= 0 ? byLang : guess(h, /перевод|translation/i));
  };

  const readFile = async (f: File) => {
    setMsg(null); setCheck(null); setFileName(f.name);
    try {
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await f.arrayBuffer());
      const list: Sheet[] = [];
      wb.eachSheet((ws) => {
        const rows: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (r) => {
          const out: string[] = [];
          for (let i = 1; i <= ws.columnCount; i++) out.push(cellText(r.getCell(i).value));
          rows.push(out);
        });
        if (rows.length) list.push({ name: ws.name, header: rows[0], rows: rows.slice(1) });
      });
      if (!list.length) { setMsg({ kind: 'error', text: 'В файле нет данных.' }); return; }
      setSheets(list); pickSheet(list, 0);
    } catch {
      setMsg({ kind: 'error', text: 'Не получилось прочитать файл. Нужен .xlsx (в Google Таблицах: Файл → Скачать → Microsoft Excel).' });
    }
  };

  const payload = () => (sheet?.rows ?? [])
    .map((r) => ({ tb: colTb >= 0 ? r[colTb] : '', ru: colRu >= 0 ? r[colRu] : '', text: colTr >= 0 ? r[colTr] : '' }))
    .filter((x) => x.tb || x.ru || x.text);

  const run = async (apply: boolean) => {
    if (colTr < 0) return setMsg({ kind: 'error', text: 'Выберите столбец с переводом.' });
    if (colTb < 0 && colRu < 0) return setMsg({ kind: 'error', text: 'Выберите столбец с номером TB или с русским термином — по нему найдём термин.' });
    setBusy(true); setMsg(null);
    try {
      const r = await rpc<{ rows: Row[]; added: number }>('import_translations', { p_lang: lang, p_rows: payload(), p_apply: apply });
      if (apply) {
        setMsg({ kind: 'ok', text: `Загружено переводов: ${r.added}. Они видны в глоссарии со статусом «Без проверки».` });
        setCheck(null); setSheets([]); setFileName('');
      } else setCheck(r.rows);
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (!allowed.length) {
    return <div className="narrow"><h1>Загрузка переводов</h1><Message kind="info">Сейчас нет сокращённых языков и языков без валидатора — загружать некуда.</Message></div>;
  }
  const counts = check ? Object.fromEntries(Object.keys(STATUS).map((k) => [k, check.filter((x) => x.status === k).length])) as Record<Row['status'], number> : null;
  const colSelect = (label: string, v: number, set: (n: number) => void, optional = false) => (
    <label className="field"><span>{label}</span>
      <select value={v} onChange={(e) => { set(Number(e.target.value)); setCheck(null); }}>
        <option value={-1}>{optional ? '— нет —' : '— выберите —'}</option>
        {sheet?.header.map((h, i) => <option key={i} value={i}>{h || `Столбец ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <div className="import-page">
      <h1>Загрузка переводов подрядчиков</h1>
      <p className="muted">Для сокращённых языков и языков без валидатора. Переводы попадут в глоссарий со статусом «Без проверки».
        Сначала покажем, что с чем совпало, — ничего не сохранится, пока вы не нажмёте «Загрузить».</p>
      <ol className="small muted">
        <li>Таблица подрядчика: в одном столбце номер TB или русский термин, в другом — перевод. Первая строка — названия столбцов.</li>
        <li>Если у термина уже есть перевод на этот язык — его не трогаем, строка будет пропущена.</li>
        <li>Несколько вариантов перевода в одной ячейке разделяйте точкой с запятой.</li>
      </ol>
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      <div className="card">
        <label className="field"><span>Язык</span>
          <select value={lang} onChange={(e) => { setLang(e.target.value); if (sheets.length) pickSheet(sheets, sheetIx, e.target.value); }}>
            {allowed.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}{l.kind === 'short' ? ' (сокращённый)' : ' (без валидатора)'}</option>)}
          </select>
        </label>
        <label className="field"><span>Файл .xlsx</span>
          <input type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
          {fileName ? <span className="small muted">{fileName}</span> : null}
        </label>
        {sheets.length > 1 ? (
          <label className="field"><span>Лист</span>
            <select value={sheetIx} onChange={(e) => pickSheet(sheets, Number(e.target.value))}>
              {sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} строк)</option>)}
            </select>
          </label>
        ) : null}
        {sheet ? (
          <>
            <div className="row gap wrap">
              {colSelect('Номер TB', colTb, setColTb, true)}
              {colSelect('Русский термин', colRu, setColRu, true)}
              {colSelect(`Перевод (${lang})`, colTr, setColTr)}
            </div>
            <p className="small muted">Строк с данными: {payload().length}. Термин ищем по номеру TB, а если его нет — по русскому термину.</p>
            <Button kind="primary" disabled={busy} onClick={() => run(false)}>{busy && !check ? 'Проверяю…' : 'Проверить'}</Button>
          </>
        ) : null}
      </div>

      {check && counts ? (
        <>
          <h2>Что получилось</h2>
          <div className="row gap wrap">
            {(Object.keys(STATUS) as Row['status'][]).filter((k) => counts[k]).map((k) => (
              <span key={k} className={`badge ${STATUS[k].cls}`}>{STATUS[k].label}: {counts[k]}</span>
            ))}
          </div>
          <div className="actions">
            <Button kind="primary" disabled={busy || !counts.add} why={!counts.add ? 'Нечего добавлять' : undefined} onClick={() => run(true)}>
              Загрузить {counts.add} {lang}</Button>
            <Button kind="link" onClick={() => setCheck(null)}>Отмена</Button>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Строка</th><th>Номер</th><th>Русский термин</th><th>Перевод из файла</th><th>Сейчас в глоссарии</th><th>Что будет</th></tr></thead>
              <tbody>{check.map((r) => (
                <tr key={r.row}>
                  <td className="muted">{r.row + 1}</td>
                  <td className="tb">{r.tb ?? ''}</td>
                  <td><b>{r.ru}</b></td>
                  <td>{r.text}</td>
                  <td className="muted">{r.current ?? ''}</td>
                  <td><span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
