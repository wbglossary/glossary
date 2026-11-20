import { useState } from 'react';
import { rpc, type Language } from '../api';
import type { PageProps } from '../router';
import { Button, Message } from '../ui/kit';

/**
 * Загрузка готовых переводов от подрядчиков: одна таблица, сколько угодно языков.
 * Столбцы и языки определяются по названиям столбцов; термин ищется по русскому и определению.
 */

type LangSt = 'add' | 'same' | 'differs' | 'skip' | 'no_lang';
interface LangRes { text: string; current: string | null; status: LangSt; as: 'draft' | 'unchecked' }
interface Row {
  row: number; match: 'ok' | 'ambiguous' | 'not_found'; tb: string | null; ru: string; definition: string | null;
  candidates: { tb: string; definition: string }[] | null; langs: Record<string, LangRes>;
}
interface Sheet { name: string; header: string[]; rows: string[][] }
type Role = '' | 'tb' | 'ru' | 'definition' | `lang:${string}`;

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

// Другие названия языков, которые встречаются в таблицах
const ALIASES: Record<string, string[]> = {
  EN: ['english', 'англ'], KA: ['georgian', 'грузин'], HY: ['armenian', 'армян'], KK: ['kazakh', 'казах'],
  UZ: ['uzbek', 'узбек'], KY: ['kyrgyz', 'kirghiz', 'кыргыз', 'киргиз'], TG: ['tajik', 'таджик'], TR: ['turkish', 'турец'],
  ZH: ['chinese', 'китай'], SW: ['swahili', 'суахили'], AZ: ['azerbaijani', 'азербайдж'], AM: ['amharic', 'амхар']
};

/** Что лежит в столбце — по его названию */
function guessRole(h: string, langs: Language[]): Role {
  const s = h.trim().toLowerCase();
  if (!s) return '';
  if (/^(tb|номер|№|id)\b/.test(s)) return 'tb';
  if (/определ|definition|значение|описание/.test(s)) return 'definition';
  if (/коммент|comment|примеч|note|пример/.test(s)) return '';
  for (const l of langs) {
    const words = [l.name.toLowerCase().slice(0, 5), ...(ALIASES[l.code] ?? [])];
    if (new RegExp(`(^|[^a-zа-я])${l.code.toLowerCase()}([^a-zа-я]|$)`).test(s) || words.some((w) => s.includes(w))) return `lang:${l.code}`;
  }
  if (/рус|^ru\b|russian|термин|term|source/.test(s)) return 'ru';
  return '';
}

const MATCH: Record<Row['match'], { label: string; total: string; cls: string }> = {
  ok: { label: 'найден', total: 'Термин найден', cls: 'st-approved' },
  ambiguous: { label: 'несколько терминов — нужно определение', total: 'Нужно определение', cls: 'st-draft' },
  not_found: { label: 'термина нет в глоссарии', total: 'Нет в глоссарии', cls: 'st-need' }
};
const LST: Record<LangSt, { label: string; cls: string }> = {
  add: { label: 'добавим', cls: 'st-approved' },
  same: { label: 'уже есть', cls: 'st-unused' },
  differs: { label: 'уже есть другой — пропустим', cls: 'st-draft' },
  skip: { label: 'пропустим', cls: 'st-unused' },
  no_lang: { label: 'такого языка нет', cls: 'st-need' }
};

export function ImportTranslationsPage({ me }: PageProps) {
  const langs = me.languages.filter((l) => l.active);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIx, setSheetIx] = useState(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const sheet = sheets[sheetIx];

  const pickSheet = (list: Sheet[], ix: number) => {
    setSheetIx(ix); setCheck(null);
    const r = (list[ix]?.header ?? []).map((h) => guessRole(h, langs));
    // русский термин не нашёлся по названию — берём первый столбец без роли
    if (!r.includes('ru')) { const i = r.findIndex((x) => x === ''); if (i >= 0) r[i] = 'ru'; }
    setRoles(r);
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

  const langCols = roles.map((r, i) => [r, i] as const).filter(([r]) => r.startsWith('lang:')).map(([r, i]) => ({ code: r.slice(5), i }));
  const payload = () => (sheet?.rows ?? []).map((r) => {
    const get = (role: Role) => { const i = roles.indexOf(role); return i >= 0 ? r[i] ?? '' : ''; };
    const tr: Record<string, string> = {};
    langCols.forEach(({ code, i }) => { if (r[i]) tr[code] = tr[code] ? `${tr[code]}; ${r[i]}` : r[i]; });
    return { tb: get('tb'), ru: get('ru'), definition: get('definition'), tr };
  }).filter((x) => (x.ru || x.tb) && Object.keys(x.tr).length);

  const run = async (apply: boolean) => {
    if (!roles.includes('ru') && !roles.includes('tb')) return setMsg({ kind: 'error', text: 'Укажите, в каком столбце русский термин.' });
    if (!langCols.length) return setMsg({ kind: 'error', text: 'Не нашла ни одного столбца с языком. Укажите язык у столбцов с переводами.' });
    setBusy(true); setMsg(null);
    try {
      const r = await rpc<{ rows: Row[]; added: number }>('import_translations', { p_rows: payload(), p_apply: apply });
      if (apply) {
        setMsg({ kind: 'ok', text: `Загружено переводов: ${r.added}.` });
        setCheck(null); setSheets([]); setFileName('');
      } else setCheck(r.rows);
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const toAdd = check ? check.reduce((n, r) => n + Object.values(r.langs).filter((l) => l.status === 'add').length, 0) : 0;
  const byMatch = check ? (Object.keys(MATCH) as Row['match'][]).map((k) => [k, check.filter((r) => r.match === k).length] as const) : [];
  const perLang = check ? Object.entries(check.reduce<Record<string, { add: number; as: string }>>((acc, r) => {
    Object.entries(r.langs).forEach(([c, l]) => { acc[c] ??= { add: 0, as: l.as }; if (l.status === 'add') acc[c].add++; });
    return acc;
  }, {})) : [];

  return (
    <div className="import-page">
      <h1>Загрузка переводов подрядчиков</h1>
      <p className="muted">Таблица от подрядчика: русский термин, определение и столбцы с переводами. Сайт сам разложит переводы по языкам.</p>
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      <div className="card">
        <div className="filepick">
          <label className="btn primary">
            Выбрать таблицу .xlsx
            <input type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
          </label>
          <span className={fileName ? '' : 'muted'}>{fileName || 'Файл не выбран'}</span>
        </div>
        {sheets.length > 1 ? (
          <label className="field"><span>Лист</span>
            <select value={sheetIx} onChange={(e) => pickSheet(sheets, Number(e.target.value))}>
              {sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} строк)</option>)}
            </select>
          </label>
        ) : null}
        {sheet ? (
          <>
            <div className="field"><span>Что в столбцах (поправьте, если сайт ошибся)</span>
              <div className="colroles">
                {sheet.header.map((h, i) => (
                  <label key={i} className={roles[i] ? 'on' : ''}>
                    <span className="small">{h || `Столбец ${i + 1}`}</span>
                    <select value={roles[i] ?? ''} onChange={(e) => { const r = [...roles]; r[i] = e.target.value as Role; setRoles(r); setCheck(null); }}>
                      <option value="">— не загружать —</option>
                      <option value="ru">Русский термин</option>
                      <option value="definition">Определение</option>
                      <option value="tb">Номер TB</option>
                      {langs.map((l) => <option key={l.code} value={`lang:${l.code}`}>Перевод {l.code} — {l.name}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <p className="small muted">
              Языки: {langCols.length ? [...new Set(langCols.map((c) => c.code))].join(', ') : 'не найдены'} · строк с переводами: {payload().length}
            </p>
            <Button kind="primary" disabled={busy} onClick={() => run(false)}>{busy && !check ? 'Проверяю…' : 'Проверить'}</Button>
            <p className="small muted">«Проверить» ничего не сохраняет — просто покажет, что куда попадёт.</p>
          </>
        ) : null}
      </div>

      {check ? (
        <>
          <h2>Что получилось</h2>
          <div className="row gap wrap">
            {byMatch.filter(([, n]) => n).map(([k, n]) => <span key={k} className={`badge ${MATCH[k].cls}`}>{MATCH[k].total}: {n}</span>)}
          </div>
          <div className="row gap wrap" style={{ marginTop: 8 }}>
            {perLang.map(([c, x]) => <span key={c} className="badge">{c}: добавим {x.add}{x.add ? (x.as === 'draft' ? ' (черновиком)' : ' (без проверки)') : ''}</span>)}
          </div>
          <div className="actions">
            <Button kind="primary" disabled={busy || !toAdd} why={!toAdd ? 'Нечего добавлять' : undefined} onClick={() => run(true)}>Загрузить {toAdd} перев.</Button>
            <Button kind="link" onClick={() => setCheck(null)}>Отмена</Button>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Строка</th><th>Термин</th><th>Совпадение</th><th>Переводы</th></tr></thead>
              <tbody>{check.map((r) => (
                <tr key={r.row}>
                  <td className="muted">{r.row + 1}</td>
                  <td>
                    {r.tb ? <><span className="tb">{r.tb}</span>{' '}</> : null}<b>{r.ru}</b>
                    {r.definition ? <div className="muted small clip" title={r.definition}>{r.definition}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${MATCH[r.match].cls}`}>{MATCH[r.match].label}</span>
                    {r.candidates?.length ? <div className="small muted">{r.candidates.map((c) => `${c.tb}: ${c.definition || 'без определения'}`).join(' · ')}</div> : null}
                  </td>
                  <td className="small">{Object.entries(r.langs).map(([c, l]) => (
                    <div key={c}><b>{c}</b> {l.text} <span className={`badge ${LST[l.status].cls}`}>{LST[l.status].label}</span>
                      {l.status === 'differs' && l.current ? <span className="muted"> сейчас: {l.current}</span> : null}</div>
                  ))}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
