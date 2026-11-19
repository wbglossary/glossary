/**
 * Дополнить файл переноса терминами из других таблиц (например, «Глоссарий Loco EN»).
 *
 * npx tsx scripts/merge-sources.ts "главная.xlsx" "источник.xlsx" "результат.xlsx"
 *
 * Берёт скачанную главную Google Таблицу (с листами «Эталон — …») и добавляет в её «Эталоны»:
 *  - новые термины с листов из LISTS (номера TB- продолжают нумерацию);
 *  - если русский термин уже есть, а английский перевод другой — заявку «Замена» на решение валидатору EN;
 *  - если термин есть и перевод тот же — ничего.
 * Главный файл не меняется: результат пишется в новый файл, рядом — отчёт .md.
 * Дальше результат переносится обычным npm run import.
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';

interface ListRule {
  sheet: string;
  status: 'approved' | 'draft';
  archive?: boolean;          // термины сразу в архив
  headerless?: boolean;       // у листа нет строки заголовков: RU | EN | комментарий
  project?: string;           // проект (создаётся, если нет)
  ruCommentTo?: 'definition' | 'context';
}

// Какие листы переносить сейчас (решение от 20.11.2026). Остальные вкладки — позже.
const LISTS: ListRule[] = [
  { sheet: 'APPROVED', status: 'approved', ruCommentTo: 'definition' },
  { sheet: 'APRVD_misc', status: 'approved', ruCommentTo: 'context' },
  { sheet: 'Pro WB OLD', status: 'approved', archive: true, headerless: true, ruCommentTo: 'context' }
];
const WHO = 'перенос из Loco EN';

const s = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: string; result?: unknown };
    if (o.richText) return o.richText.map((x) => x.text).join('').trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return String(o.result ?? '').trim();
    return '';
  }
  return String(v).trim();
};
const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е').replace(/[«»"„“”']/g, '').replace(/[ \s]+/g, ' ').replace(/[‐‑–—]/g, '-').trim();
const parts = (t: string) => [norm(t), ...t.split(/\s+\/\s+/).map(norm)].filter(Boolean);
const clean = (t: string) => (t === '—' ? '' : t);

const [mainFile, srcFile, outFile] = process.argv.slice(2);
if (!mainFile || !srcFile || !outFile) { console.error('Нужно: главная.xlsx источник.xlsx результат.xlsx'); process.exit(1); }

const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(mainFile);
const sheet = (n: string) => { const ws = wb.getWorksheet(n); if (!ws) throw new Error(`В главном файле нет листа «${n}»`); return ws; };
const T = sheet('Эталон — понятия'), TR = sheet('Эталон — переводы'), RQ = sheet('Эталон — заявки'), META = sheet('Эталон — служебное');
const cols = (ws: ExcelJS.Worksheet) => { const h: Record<string, number> = {}; ws.getRow(1).eachCell((c, n) => { h[s(c.value)] = n; }); return h; };
const tc = cols(T), trc = cols(TR), rqc = cols(RQ);
const put = (ws: ExcelJS.Worksheet, c: Record<string, number>, o: Record<string, unknown>) => {
  const row = ws.getRow(ws.rowCount + 1);
  for (const [k, v] of Object.entries(o)) { if (!c[k]) throw new Error(`Нет столбца «${k}» на листе «${ws.name}»`); row.getCell(c[k]).value = v as ExcelJS.CellValue; }
  row.commit();
};

// Что уже есть в главном файле
const byRu = new Map<string, { tb: string; ru: string }[]>();
let maxTb = 0;
T.eachRow((r, i) => {
  if (i === 1) return;
  const tb = s(r.getCell(tc['Номер']).value), ru = s(r.getCell(tc['Русский термин']).value);
  if (!/^TB-\d+$/.test(tb)) return;
  maxTb = Math.max(maxTb, Number(tb.slice(3)));
  for (const p of parts(ru)) byRu.set(p, [...(byRu.get(p) ?? []), { tb, ru }]);
});
const enOf = new Map<string, { id: string; text: string; sort: number }[]>();
let maxTr = 0;
TR.eachRow((r, i) => {
  if (i === 1) return;
  const id = s(r.getCell(trc['ID']).value); const m = id.match(/(\d+)$/); if (m) maxTr = Math.max(maxTr, Number(m[1]));
  if (s(r.getCell(trc['Язык']).value) !== 'EN' || s(r.getCell(trc['Статус']).value) === 'Устарел') return;
  const tb = s(r.getCell(trc['Номер']).value);
  enOf.set(tb, [...(enOf.get(tb) ?? []), { id, text: s(r.getCell(trc['Перевод']).value), sort: Number(s(r.getCell(trc['Порядок']).value)) || 1 }]);
});
let maxZ = 0;
RQ.eachRow((r, i) => { if (i > 1) { const m = s(r.getCell(rqc['ID']).value).match(/^Z-(\d+)$/); if (m) maxZ = Math.max(maxZ, Number(m[1])); } });
const metaRow = (p: string) => { let n = 0; META.eachRow((r, i) => { if (s(r.getCell(1).value) === p) n = i; }); return n; };
maxTb = Math.max(maxTb, (Number(s(META.getRow(metaRow('Следующий номер TB')).getCell(2).value)) || 1) - 1);
maxZ = Math.max(maxZ, (Number(s(META.getRow(metaRow('Следующий ID заявки') || 1).getCell(2).value)) || 1) - 1);

// Английские переводы главного глоссария → термины (чтобы узнать переименованные термины)
const loose = (t: string) => norm(t).replace(/s\b/g, '');   // UP ~ UPs
const mainEn = new Map<string, string[]>();
for (const [tb, list] of enOf) for (const x of list) mainEn.set(loose(x.text), [...(mainEn.get(loose(x.text)) ?? []), tb]);
const ruOfTb = new Map<string, string>(); for (const list of byRu.values()) for (const x of list) ruOfTb.set(x.tb, x.ru);

// Похожие русские термины главного глоссария (переименования вроде «АП» → «АПы», «N» → «%s»)
const bigrams = (t: string) => { const x = ' ' + norm(t).replace(/%s|\bn\b/g, '#') + ' '; const m = new Map<string, number>(); for (let i = 0; i < x.length - 1; i++) m.set(x.slice(i, i + 2), (m.get(x.slice(i, i + 2)) ?? 0) + 1); return m; };
const dice = (a: Map<string, number>, b: Map<string, number>) => { let o = 0, na = 0, nb = 0; for (const v of a.values()) na += v; for (const v of b.values()) nb += v; for (const [k, v] of a) o += Math.min(v, b.get(k) ?? 0); return (2 * o) / (na + nb || 1); };
const mainBg = [...ruOfTb].map(([tb, ru]) => ({ tb, ru, bg: bigrams(ru) }));
const similarRu = (ru: string) => { const b = bigrams(ru); const best = mainBg.map((x) => ({ ...x, d: dice(b, x.bg) })).filter((x) => x.d >= 0.75 && norm(ru).length >= 6 && norm(ru).split(' ').length === norm(x.ru).split(' ').length).sort((x, y) => y.d - x.d)[0]; return best ? `${best.tb} «${best.ru}»` : null; };

// Источник
const src = new ExcelJS.Workbook(); await src.xlsx.readFile(srcFile);
const now = new Date();
const rep: string[] = [];
const added: string[] = [], requests: string[] = [], same: string[] = [], dupInSrc: string[] = [], skipped: string[] = [], renamed: string[] = [];
const addedNow = new Map<string, string>(); // norm ru → tb (повторы внутри источников)

for (const rule of LISTS) {
  const ws = src.getWorksheet(rule.sheet);
  if (!ws) { rep.push(`Лист «${rule.sheet}» не найден в источнике — пропущен.`); continue; }
  const h: Record<string, number> = rule.headerless ? { RU: 1, EN: 2, 'Комментарий RU': 3 } : cols(ws);
  const c = (r: ExcelJS.Row, k: string) => (h[k] ? clean(s(r.getCell(h[k]).value)) : '');
  let n = 0, a = 0, q = 0, k0 = 0;
  ws.eachRow((r, i) => {
    if (!rule.headerless && i === 1) return;
    const ru = s(r.getCell(1).value); const en = s(r.getCell(h['EN']).value);
    if (!ru) return; n++;
    if (!en) { skipped.push(`${rule.sheet}, строка ${i}: «${ru}» без английского перевода`); return; }
    const ruNote = c(r, 'Определение') || c(r, 'Комментарий RU');
    const enNote = c(r, 'Комментарий EN');
    const examples = c(r, 'Примеры использования RU');
    const hit = parts(ru).flatMap((p) => byRu.get(p) ?? []);
    if (addedNow.has(norm(ru))) { dupInSrc.push(`${rule.sheet}, строка ${i}: «${ru}» уже добавлен как ${addedNow.get(norm(ru))}`); return; }
    if (hit.length) {
      const tb = hit[0].tb;
      const ens = hit.flatMap((x) => enOf.get(x.tb) ?? []);
      if (ens.some((x) => norm(x.text) === norm(en))) { same.push(`${tb} «${hit[0].ru}»`); k0++; return; }
      const target = (enOf.get(tb) ?? []).sort((x, y) => x.sort - y.sort)[0];
      const code = `Z-${String(++maxZ).padStart(5, '0')}`;
      put(RQ, rqc, {
        ID: code, Тип: 'Замена', Статус: 'На рассмотрении', Номер: tb, 'ID заменяемого перевода': target?.id ?? '',
        'Русский термин': hit[0].ru, Язык: 'EN', Перевод: en,
        Причина: `В таблице «Loco EN» (лист ${rule.sheet}) для «${ru}» стоит «${en}», а в глоссарии — «${target?.text ?? '—'}». ` +
          'Утвердите, если правильный перевод из Loco EN. Если верны оба — отклоните и добавьте вариант в карточке термина.',
        Автор: WHO, Подано: now
      });
      requests.push(`${code}: ${tb} «${hit[0].ru}» — сейчас «${target?.text ?? '—'}», в Loco EN «${en}» (лист ${rule.sheet})`);
      q++; return;
    }
    const near = similarRu(ru);
    if (near) {
      renamed.push(`«${ru}» → ${en} (лист ${rule.sheet}): очень похож на ${near}`);
      return;
    }
    const sameEn = mainEn.get(loose(en));
    if (sameEn) {
      renamed.push(`«${ru}» → ${en} (лист ${rule.sheet}): такой перевод уже есть у ${sameEn.map((t) => `${t} «${ruOfTb.get(t)}»`).join(', ')}`);
      return;
    }
    const tb = `TB-${String(++maxTb).padStart(5, '0')}`;
    put(T, tc, {
      Номер: tb, 'Русский термин': ru,
      Определение: rule.ruCommentTo === 'definition' ? ruNote : '',
      Примеры: examples,
      'Значение или контекст': rule.ruCommentTo === 'context' ? ruNote : '',
      Проекты: rule.project ?? '',
      Комментарий: enNote ? `EN: ${enNote}` : '',
      Статус: rule.archive ? 'В архиве' : 'Действует',
      Создано: now, 'Кем создано': WHO, Изменено: now, 'Кем изменено': WHO
    });
    put(TR, trc, {
      ID: `T${++maxTr}`, Номер: tb, Язык: 'EN', Перевод: en, Порядок: 1,
      Статус: rule.status === 'approved' ? 'Согласовано' : 'Черновик',
      Добавлено: now, 'Кем добавлено': WHO,
      Согласовано: rule.status === 'approved' ? now : null, 'Кем согласовано': rule.status === 'approved' ? WHO : ''
    });
    for (const p of parts(ru)) byRu.set(p, [...(byRu.get(p) ?? []), { tb, ru }]);
    enOf.set(tb, [{ id: `T${maxTr}`, text: en, sort: 1 }]);
    addedNow.set(norm(ru), tb);
    added.push(`${tb} «${ru}» → ${en}${rule.archive ? ' (в архиве)' : ''} (лист ${rule.sheet})`);
    a++;
  });
  rep.push(`Лист «${rule.sheet}»: строк ${n}; новых терминов ${a}${rule.archive ? ' (сразу в архив)' : ''}; уже есть с тем же переводом ${k0}; заявок на замену ${q}.`);
}

META.getRow(metaRow('Следующий номер TB')).getCell(2).value = maxTb + 1;
const tr = metaRow('Следующий ID перевода'); if (tr) META.getRow(tr).getCell(2).value = maxTr + 1;
const zr = metaRow('Следующий ID заявки'); if (zr) META.getRow(zr).getCell(2).value = maxZ + 1; else { META.addRow(['Следующий ID заявки', maxZ + 1]); }

await wb.xlsx.writeFile(outFile);
const md = [
  `# Отчёт: дополнение глоссария из «${srcFile.split('/').pop()}»`, '',
  `Главный файл: ${mainFile.split('/').pop()}. Результат: ${outFile.split('/').pop()}. Главный файл не изменён.`, '',
  ...rep.map((x) => '- ' + x), '',
  `## Новые термины (${added.length})`, ...added.map((x) => '- ' + x), '',
  `## Заявки на решение валидатору EN (${requests.length})`, ...requests.map((x) => '- ' + x), '',
  `## Не добавлены: похоже на существующий термин (${renamed.length})`,
  'Такого русского термина нет, но есть очень похожий или с тем же английским переводом — вероятно, его переименовали. Если это всё же отдельный термин — его можно предложить на сайте.',
  ...renamed.map((x) => '- ' + x), '',
  `## Повторы внутри источника — не добавлены (${dupInSrc.length})`, ...dupInSrc.map((x) => '- ' + x), '',
  `## Пропущено (${skipped.length})`, ...skipped.map((x) => '- ' + x), ''
].join('\n');
writeFileSync(outFile.replace(/\.xlsx$/, ' — отчёт.md'), md);
console.log(rep.join('\n'));
console.log(`Новых: ${added.length}, заявок: ${requests.length}, похоже на переименованные: ${renamed.length}, повторов: ${dupInSrc.length}, пропущено: ${skipped.length}`);
