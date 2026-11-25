/** Сборка файлов выгрузки в браузере: .xlsx для Smartcat, XML (внутри — стандарт TBX) и таблица для просмотра. */
import type { Cell, Forbidden } from './api';

interface LangFields { comment: string; forbidden: Forbidden[] }
export interface ExportData {
  ru_code: string;
  languages: { code: string; smartcat: string }[];
  terms: { tb: string; ru: string; definition: string; examples: string; comment: string;
    created_at: string; updated_at: string; tr: Record<string, string[]>; fields: Record<string, LangFields> }[];
}
export interface ViewData {
  languages: { code: string; kind: 'full' | 'short' }[];
  terms: { tb: string; ru: string; definition: string; projects: string; cells: Record<string, Cell> }[];
}

const FIXED = ['Comments', 'CreationDate', 'Author', 'LastModifiedDate', 'LastModifiedBy'];
const pad = (n: number) => String(n).padStart(2, '0');
const scDate = (s: string) => {
  const d = new Date(s);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const clean = (v: string | null | undefined) => (v && v.trim() !== '—' ? v.trim() : '');

/** Колонка Comments в Smartcat: только русское определение — по нему переводчик понимает, о чём термин,
 *  и различает одинаковые русские термины. */
export function smartcatComment(c: ExportData['terms'][number]) {
  return clean(c.definition);
}

export function smartcatTable(d: ExportData) {
  const maxN: Record<string, number> = {};
  for (const l of d.languages) maxN[l.code] = Math.max(1, ...d.terms.map((c) => c.tr[l.code]?.length ?? 0));
  const header = [...FIXED, `${d.ru_code} Term1`];
  for (const l of d.languages) for (let i = 1; i <= maxN[l.code]; i++) header.push(`${l.smartcat} Term${i}`);
  const rows = d.terms.map((c) => {
    const r = [smartcatComment(c), scDate(c.created_at), '', scDate(c.updated_at), '', c.ru];
    for (const l of d.languages) for (let i = 0; i < maxN[l.code]; i++) r.push(c.tr[l.code]?.[i] ?? '');
    return r;
  });
  return { header, rows };
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function buildXlsx(d: ExportData): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const { header, rows } = smartcatTable(d);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Glossary');
  ws.addRow(header);
  rows.forEach((r) => { ws.addRow(r).getCell(1).alignment = { wrapText: true, vertical: 'top' }; });
  ws.getRow(1).font = { bold: true };
  ws.getColumn(1).width = 50;
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE });
}

const LABEL: Record<string, string> = { need: 'нужен перевод', optional: 'по желанию', draft: 'черновик', unchecked: 'без проверки', approved: '', unused: 'не актуально' };

/** Таблица для просмотра: все языки, пустые ячейки полных языков — красные. */
export async function buildViewXlsx(d: ViewData): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Глоссарий');
  ws.addRow(['Номер', 'Русский термин', 'Определение', 'Проекты', ...d.languages.map((l) => l.code)]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 10 : i === 1 ? 30 : 22; });
  const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  for (const t of d.terms) {
    const row = ws.addRow([t.tb, t.ru, t.definition, t.projects, ...d.languages.map((l) => {
      const c = t.cells[l.code];
      if (!c || c.s === 'unused') return '';
      const text = c.t.join('; ');
      return text && LABEL[c.s] ? `${text} (${LABEL[c.s]})` : text;
    })]);
    d.languages.forEach((l, i) => {
      const c = t.cells[l.code];
      const cell = row.getCell(5 + i);
      cell.alignment = { wrapText: true, vertical: 'top' };
      if (!c) return;
      if (c.s === 'unused') return;
      else if (c.s === 'need' && l.kind === 'full') cell.fill = fill('FFF8C9C9');
      else if (c.s === 'unchecked') cell.fill = fill('FFEDE4FA');
      else if (c.s === 'draft') cell.fill = fill('FFFFF1C9');
    });
  }
  const legend = wb.addWorksheet('Пояснение');
  [['Красная ячейка', 'нужен перевод (только для полных языков)'], ['Белая пустая', 'нет перевода, но он по желанию — менеджер этот язык не заказывал'], ['Жёлтая', 'черновик'], ['Сиреневая', 'без проверки'],
    ['Белая с пометкой «не актуально»', 'термин не актуален для этого языка']].forEach((r) => legend.addRow(r));
  legend.getColumn(1).width = 18; legend.getColumn(2).width = 50;
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE });
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Глоссарий в XML. Внутри — стандартная разметка TBX, её понимают CAT-программы. */
export function buildXml(d: ExportData, title: string): Blob {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<martif type="TBX" xml:lang="${esc(d.ru_code)}">`,
    `<martifHeader><fileDesc><sourceDesc><p>${esc(title)}</p></sourceDesc></fileDesc></martifHeader>`, '<text><body>'];
  for (const c of d.terms) {
    out.push(`<termEntry id="${esc(c.tb)}">`);
    const note = smartcatComment(c);
    if (note) out.push(`<descrip type="definition">${esc(note)}</descrip>`);
    out.push(`<langSet xml:lang="${esc(d.ru_code)}"><tig><term>${esc(c.ru)}</term></tig></langSet>`);
    for (const l of d.languages) {
      const list = c.tr[l.code] ?? [];
      const f = c.fields?.[l.code];
      if (!list.length && !f?.forbidden?.length) continue;
      const lnote = f ? clean(f.comment) : '';
      out.push(`<langSet xml:lang="${esc(l.smartcat)}">` + (lnote ? `<note>${esc(lnote)}</note>` : '') +
        list.map((x) => `<tig><term>${esc(x)}</term><termNote type="administrativeStatus">preferredTerm-admn-sts</termNote></tig>`).join('') +
        (f?.forbidden ?? []).filter((x) => clean(x.text)).map((x) =>
          `<tig><term>${esc(x.text)}</term><termNote type="administrativeStatus">deprecatedTerm-admn-sts</termNote>${clean(x.note) ? `<note>${esc(x.note)}</note>` : ''}</tig>`).join('') +
        '</langSet>');
    }
    out.push('</termEntry>');
  }
  out.push('</body></text></martif>');
  return new Blob([out.join('\n')], { type: 'application/xml' });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export interface ContractorData {
  languages: { code: string; name: string }[];
  terms: { tb: string; ru: string; definition: string; examples: string; tr: Record<string, string> }[];
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Таблица для подрядчика: пустые ячейки — то, что нужно перевести. Её же потом можно загрузить в «Загрузку терминов». */
export async function buildContractorXlsx(d: ContractorData): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Перевести');
  ws.addRow(['Номер', 'Русский термин', 'Определение', 'Примеры', ...d.languages.map((l) => cap(l.name))]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 11 : i === 1 ? 30 : i < 4 ? 40 : 28; });
  for (const t of d.terms) {
    const row = ws.addRow([t.tb, t.ru, clean(t.definition), clean(t.examples), ...d.languages.map((l) => t.tr[l.code] ?? '')]);
    row.alignment = { wrapText: true, vertical: 'top' };
    d.languages.forEach((l, i) => { if (!t.tr[l.code]) row.getCell(5 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }; });
  }
  const help = wb.addWorksheet('Как заполнить');
  [['Впишите перевод в жёлтые ячейки.'], ['Несколько вариантов — через точку с запятой.'], ['Столбцы и их названия не меняйте — файл загрузится обратно на сайт.']].forEach((r) => help.addRow(r));
  help.getColumn(1).width = 70;
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE });
}

/** Скачать из «Глоссария» то, что на экране: те же фильтры, столбцы и языки. */
export async function buildGlossaryXlsx(items: {
  tb: string; ru: string; definition?: string; examples?: string; comment?: string; projects: string[];
  cells: Record<string, Cell>;
}[], fields: { key: string; label: string }[], langs: string[], langComments: boolean): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Глоссарий');
  const header = ['Номер', 'Русский термин', ...fields.map((f) => f.label)];
  for (const l of langs) { header.push(l); if (langComments) header.push(`Комментарий ${l}`); }
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 11 : i === 1 ? 30 : 26; });
  const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  for (const t of items) {
    const vals: string[] = [t.tb, t.ru, ...fields.map((f) => f.key === 'projects' ? t.projects.join(', ') : clean((t as unknown as Record<string, string>)[f.key]))];
    for (const l of langs) {
      const c = t.cells[l];
      const text = c ? c.t.join('; ') : '';
      vals.push(c && c.s === 'unused' ? 'не актуально' : text && c && LABEL[c.s] ? `${text} (${LABEL[c.s]})` : text);
      if (langComments) vals.push(c?.c ?? '');
    }
    const row = ws.addRow(vals);
    row.alignment = { wrapText: true, vertical: 'top' };
    let col = 3 + fields.length;
    for (const l of langs) {
      const c = t.cells[l]; const cell = row.getCell(col);
      if (c?.s === 'need') cell.fill = fill('FFF8C9C9');
      else if (c?.s === 'draft') cell.fill = fill('FFFFF1C9');
      else if (c?.s === 'unchecked') cell.fill = fill('FFEDE4FA');
      col += langComments ? 2 : 1;
    }
  }
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE });
}

/** Шаблон для «Загрузки терминов»: какие столбцы ждёт сайт, с одной строкой-примером. */
export async function buildImportTemplate(langs: { code: string; name: string }[]): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Термины');
  ws.addRow(['Русский термин', 'Определение', ...langs.map((l) => l.code)]);
  ws.addRow(['Пункт выдачи', 'Место, где покупатель забирает заказ.', ...langs.map((l) => (l.code === 'EN' ? 'Pick-up point' : ''))]);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = i === 1 ? 50 : i === 0 ? 28 : 22; });
  return new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
