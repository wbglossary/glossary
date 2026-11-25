import { Fragment, useState } from 'react';
import { rpc, type Language } from '../api';
import type { PageProps } from '../router';
import { Button, Message } from '../ui/kit';
import { HelpLink } from '../ui/HelpLink';
import { readXlsxRaw } from '../xlsxRaw';
import { buildImportTemplate, download } from '../exportFile';
import { Icon } from '../ui/Icon';

/**
 * Загрузка готовых переводов от подрядчиков: одна таблица, сколько угодно языков.
 * Столбцы и языки определяются по названиям столбцов; термин ищется по русскому и определению.
 */

type LangSt = 'add' | 'same' | 'differs' | 'skip' | 'no_lang' | 'new' | 'to_request';
interface LangRes { text: string; current: string | null; status: LangSt; as: 'draft' | 'unchecked' | 'request' }
interface Row {
  row: number; match: 'ok' | 'new' | 'direct' | 'in_request' | 'from_request' | 'dup_in_file' | 'ambiguous' | 'not_found' | 'no_translations';
  tb: string | null; ru: string; definition: string | null; request: string | null;
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
  if (s === 'comments') return 'definition';   // Smartcat: общий комментарий = определение
  if (/^ru(-ru)?\s+term\d*$/.test(s)) return 'ru';
  const sc = s.match(/^([a-z]{2}(?:-[a-z]+)?)\s+term\d*$/);
  if (sc) { const l = langs.find((x) => x.smartcat.toLowerCase() === sc[1] || x.code.toLowerCase() === sc[1].split('-')[0]); return l ? `lang:${l.code}` : ''; }
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
  ok: { label: 'уже есть в глоссарии', total: 'Уже есть в глоссарии', cls: 'st-approved' },
  new: { label: 'новый — уйдёт валидаторам на проверку', total: 'Новых — на проверку', cls: 'st-unchecked' },
  direct: { label: 'новый — сразу, «Без проверки» (у языков нет валидатора)', total: 'Новых — сразу без проверки', cls: 'st-unchecked' },
  in_request: { label: 'ждёт проверки в заявке — допишем перевод в заявку, утвердит валидатор', total: 'Ждут в заявках (допишем перевод)', cls: 'st-unchecked' },
  from_request: { label: 'ждал в заявке — создадим термин сразу (перевод уже принят подрядчиком), заявку заберём в него', total: 'Создадим из заявок', cls: 'st-unchecked' },
  dup_in_file: { label: 'повтор в файле — пропустим', total: 'Не загрузится: повтор в файле', cls: 'st-need' },
  ambiguous: { label: 'несколько одинаковых терминов — не понятно, какой', total: 'Не загрузится: одинаковые термины', cls: 'st-need' },
  not_found: { label: 'нет русского термина', total: 'Не загрузится: нет русского термина', cls: 'st-need' },
  no_translations: { label: 'нет переводов — пропустим', total: 'Не загрузится: нет переводов', cls: 'st-need' }
};
const LST: Record<LangSt, { label: string; cls: string }> = {
  add: { label: 'добавим', cls: 'st-approved' },
  new: { label: 'в новый термин', cls: 'st-unchecked' },
  to_request: { label: 'допишем в заявку', cls: 'st-unchecked' },
  same: { label: 'уже есть', cls: 'st-unused' },
  differs: { label: 'уже есть другой — не загрузим', cls: 'st-need' },
  skip: { label: 'пропустим', cls: 'st-unused' },
  no_lang: { label: 'такого языка нет', cls: 'st-need' }
};

/** Почему строка (или перевод) не загрузились — простыми словами. null — всё в порядке. */
function whyNot(r: Row): string[] {
  const out: string[] = [];
  if (r.match === 'ambiguous') {
    out.push(`В глоссарии несколько терминов «${r.ru}» с одинаковым написанием, даже с учётом заглавных букв: `
      + (r.candidates ?? []).map((c) => `${c.tb} (${c.definition || 'без определения'})`).join('; ')
      + '. В файле нет определения, по которому можно понять, к какому из них относится перевод, поэтому сайт его не загрузил. '
      + 'Что сделать: откройте нужный термин в «Глоссарии» и впишите перевод вручную. Или добавьте в файл столбец «Определение» и загрузите эту строку ещё раз.');
  }
  if (r.match === 'not_found') out.push('В строке нет русского термина — сайту не к чему привязать перевод. Впишите русский термин в файл и загрузите строку ещё раз.');
  if (r.match === 'no_translations') out.push('В строке нет ни одного перевода — загружать нечего.');
  if (r.match === 'dup_in_file') out.push('Этот русский термин уже был выше в этом же файле — загружена первая строка, эта пропущена. Если перевод здесь другой и он правильный, впишите его вручную в карточке термина.');
  for (const [c, l] of Object.entries(r.langs)) {
    if (l.status === 'differs') out.push(`${c}: у термина уже есть перевод «${l.current}», а в файле — «${l.text}». Сайт не заменяет готовые переводы. Если правильный — из файла, откройте термин и нажмите «Заменить».`);
    if (l.status === 'no_lang') out.push(`${c}: такого языка нет в глоссарии или он выключен — перевод не загружен.`);
  }
  return out;
}

export function ImportTranslationsPage({ me }: PageProps) {
  const langs = me.languages.filter((l) => l.active);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIx, setSheetIx] = useState(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<Row[] | null>(null);
  const [projects, setProjects] = useState<number[]>([]);
  const [done, setDone] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
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
      const buf = await f.arrayBuffer();
      let list: Sheet[] = [];
      try {
        const { default: ExcelJS } = await import('exceljs');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        wb.eachSheet((ws) => {
          const rows: string[][] = [];
          ws.eachRow({ includeEmpty: false }, (r) => {
            const out: string[] = [];
            for (let i = 1; i <= ws.columnCount; i++) out.push(cellText(r.getCell(i).value));
            rows.push(out);
          });
          if (rows.length) list.push({ name: ws.name, header: rows[0], rows: rows.slice(1) });
        });
      } catch {
        // файл из Smartcat — читаем напрямую
        list = (await readXlsxRaw(buf)).map((s) => {
          const w = Math.max(...s.rows.map((r) => r.length));
          const pad = (r: string[]) => [...r, ...Array(w - r.length).fill('')];
          return { name: s.name, header: pad(s.rows[0]), rows: s.rows.slice(1).map(pad) };
        });
      }
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
      const r = await rpc<{ rows: Row[]; added: number; requests: string[] }>('import_translations', { p_rows: payload(), p_apply: apply, p_projects: projects.length ? projects : null });
      if (apply) {
        const failed = r.rows.filter((x) => whyNot(x).length).length;
        setMsg({ kind: failed ? 'warn' : 'ok', text: `Готово. Загружено переводов: ${r.added}.`
          + (r.requests.length ? ` Новых терминов на проверку валидаторам: ${r.requests.length} (${r.requests.slice(0, 5).join(', ')}${r.requests.length > 5 ? '…' : ''}) — они в «Заявках».` : '')
          + (failed ? ` Не загрузилось строк: ${failed} — они ниже, выделены красным, под каждой написано почему.` : ' Всё загрузилось.') });
        setCheck(r.rows); setDone(true); setOnlyFailed(failed > 0); setSheets([]); setFileName('');
      } else { setCheck(r.rows); setDone(false); setOnlyFailed(false); }
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const toAdd = check ? check.reduce((n, r) => n + Object.values(r.langs).filter((l) => l.status === 'add' || l.status === 'to_request').length, 0) : 0;
  const toNew = check ? check.filter((r) => r.match === 'new' || r.match === 'direct' || r.match === 'from_request').length : 0;
  const failedRows = check ? check.filter((r) => whyNot(r).length).length : 0;
  const unchanged = check ? check.filter((r) => !whyNot(r).length && !Object.values(r.langs).some((l) => l.status === 'add' || l.status === 'to_request' || l.status === 'new')).length : 0;
  const byMatch = check ? (Object.keys(MATCH) as Row['match'][]).map((k) => [k, check.filter((r) => r.match === k).length] as const) : [];
  const perLang = check ? Object.entries(check.reduce<Record<string, { add: number; as: string }>>((acc, r) => {
    Object.entries(r.langs).forEach(([c, l]) => { acc[c] ??= { add: 0, as: l.as }; if (l.status === 'add' || l.status === 'new' || l.status === 'to_request') acc[c].add++; });
    return acc;
  }, {})) : [];

  return (
    <div className="import-page">
      <h1>Загрузка терминов и переводов <HelpLink topics={['Загрузить таблицу']} /></h1>
      <p className="muted">Таблица из Smartcat или от подрядчика: русский термин, определение и столбцы с переводами. То, что уже есть, сайт пропустит. Новые переводы и новые термины уйдут валидаторам на проверку.</p>
      <ol className="stepper" aria-label="Шаги">
        {['Файл', 'Проверка', 'Результат'].map((t, i) => {
          const cur = done ? 2 : check ? 1 : 0;
          return <li key={t} className={i === cur ? 'on' : i < cur ? 'past' : ''} aria-current={i === cur ? 'step' : undefined}><span>{i < cur ? <Icon name="check" size={13} /> : i + 1}</span>{t}</li>;
        })}
      </ol>
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      <div className="card">
        <div className={`dropzone${drag ? ' over' : ''}${fileName ? ' has' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}>
          <span className="dz-ico"><Icon name="upload" size={22} /></span>
          <div className="filepick">
            <label className="btn primary">
              Выбрать таблицу .xlsx
              <input type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
            </label>
            <span className={fileName ? '' : 'muted'}>{fileName || 'или перетащите файл сюда'}</span>
          </div>
        </div>
        {!sheet ? (
          <details className="more-info">
            <summary>Как должна выглядеть таблица</summary>
            <p className="small muted">Первая строка — названия столбцов. Порядок любой, лишние столбцы можно оставить — сайт их пропустит.</p>
            <table className="grid compact example-table">
              <thead><tr><th>Русский термин</th><th>Определение</th><th>EN</th><th>KA</th></tr></thead>
              <tbody><tr><td>Пункт выдачи</td><td>Место, где покупатель забирает заказ.</td><td>Pick-up point</td><td>…</td></tr></tbody>
            </table>
            <Button small onClick={async () => download(await buildImportTemplate(langs), 'Шаблон загрузки терминов.xlsx')}><Icon name="download" size={14} /> Скачать шаблон .xlsx</Button>
          </details>
        ) : null}
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
            <div className="field"><span>Проекты для новых терминов (по желанию, можно несколько)</span>
              <div className="checks">{me.projects.filter((p) => !p.closed).map((p) => (
                <label key={p.id}><input type="checkbox" checked={projects.includes(p.id)}
                  onChange={(e) => { setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id)); setCheck(null); }} /> {p.name}</label>
              ))}</div>
            </div>
            <Button kind="primary" disabled={busy} onClick={() => run(false)}>{busy && !check ? 'Проверяю…' : 'Проверить'}</Button>
            <p className="small muted">«Проверить» ничего не сохраняет — просто покажет, что куда попадёт.</p>
          </>
        ) : null}
      </div>

      {check ? (
        <>
          <h2>{done ? 'Результат загрузки' : 'Что получится'}</h2>
          <div className="tiles">
            <div className="tile ok"><b>{toAdd}</b><span>{done ? 'переводов добавлено' : 'переводов добавится'}</span></div>
            <div className="tile new"><b>{toNew}</b><span>новых терминов — на проверку</span></div>
            <div className="tile skip"><b>{unchanged}</b><span>строк без изменений — уже есть</span></div>
            <button type="button" className={`tile err${onlyFailed ? ' on' : ''}`} disabled={!failedRows} aria-pressed={onlyFailed} onClick={() => setOnlyFailed(!onlyFailed)}
              title={failedRows ? 'Нажмите, чтобы показать только эти строки' : ''}>
              <b>{failedRows}</b><span>{failedRows ? (onlyFailed ? 'показаны только ошибки — нажмите, чтобы показать всё' : 'с ошибками — нажмите, чтобы показать только их') : 'ошибок нет'}</span></button>
          </div>
          <details className="more-info">
            <summary>Подробнее по совпадениям и языкам</summary>
            <div className="row gap wrap" style={{ marginTop: 8 }}>
              {byMatch.filter(([, n]) => n).map(([k, n]) => <span key={k} className={`badge ${MATCH[k].cls}`}>{MATCH[k].total}: {n}</span>)}
            </div>
            <div className="row gap wrap" style={{ marginTop: 8 }}>
              {perLang.map(([c, x]) => <span key={c} className="badge">{c}: новых переводов {x.add}</span>)}
            </div>
          </details>
          {done ? null : <div className="actions">
            <Button kind="primary" disabled={busy || !(toAdd + toNew)} why={!(toAdd + toNew) ? 'Нечего добавлять — всё уже есть' : undefined} onClick={() => run(true)}>
              Загрузить{toNew ? ` ${toNew} нов. терм.` : ''}{toNew && toAdd ? ' и' : ''}{toAdd ? ` ${toAdd} перев.` : ''}</Button>
            <Button kind="link" onClick={() => setCheck(null)}>Отмена</Button>
          </div>}
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Строка</th><th>Термин</th><th>Совпадение</th><th>Переводы</th></tr></thead>
              <tbody>{check.filter((r) => !onlyFailed || whyNot(r).length).map((r) => { const why = whyNot(r); return (<Fragment key={r.row}>
                <tr className={why.length ? 'row-fail' : ''}>
                  <td className="muted">{r.row + 1}</td>
                  <td>
                    {r.tb ? <><span className="tb">{r.tb}</span>{' '}</> : null}<b>{r.ru}</b>
                    {r.definition ? <div className="muted small clip" title={r.definition}>{r.definition}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${MATCH[r.match].cls}`}>{MATCH[r.match].label}</span>
                    {r.request ? <div className="small muted">заявка {r.request}</div> : null}
                    {r.candidates?.length ? <div className="small muted">{r.candidates.map((c) => `${c.tb}: ${c.definition || 'без определения'}`).join(' · ')}</div> : null}
                  </td>
                  <td className="small">{Object.entries(r.langs).map(([c, l]) => (
                    <div key={c}><b>{c}</b> {l.text} <span className={`badge ${LST[l.status].cls}`}>{LST[l.status].label}{l.status === 'add' ? (l.as === 'draft' ? ' — на проверку' : ' — без проверки') : ''}</span>
                      {l.status === 'differs' && l.current ? <span className="muted"> сейчас: {l.current}</span> : null}</div>
                  ))}</td>
                </tr>
                {why.length ? <tr className="row-fail-why"><td /><td colSpan={3}><b>Почему не {done ? 'загрузилось' : 'загрузится'}:</b>{why.map((w, i) => <div key={i}>{w}</div>)}</td></tr> : null}
              </Fragment>); })}</tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
