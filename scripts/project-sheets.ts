/**
 * Загрузка проектных таблиц (листы «Глоссарий Loco EN.xlsx») в базу с сопоставлением.
 *
 * Запускается через scripts/offline-apply.ts: сначала на копии базы у себя, потом готовые изменения
 * одной короткой операцией уходят в Supabase.
 *
 * Правила листов — в SHEETS ниже (проект, как понимать цвет, какие столбцы куда).
 * Для каждой строки (английский):
 *   термина нет, нет и заявки          → утверждено: новый термин с согласованным EN; черновик: заявка «Новый термин»;
 *                                        перевода нет: термин без EN («Нужен перевод»)
 *   термина нет, есть заявка (тот же EN) → утверждено: термин создаётся, заявка снимается; черновик: проект добавляется в заявку
 *   термин есть, EN тот же             → ничего, только проект (и пустые поля заполняются)
 *   термин есть, EN нет                → утверждено: EN добавляется согласованным; черновик: заявка «Перевод к существующему»
 *   термин есть, EN другой             → заявка «Замена» на решение валидатору EN
 * Проект добавляется термину во всех случаях. Пустые поля термина заполняются, заполненные не меняются.
 * Лист «запрещенка» → «Как нельзя» в английском у найденных терминов.
 */
import ExcelJS from 'exceljs';

type Status = 'approved' | 'draft';
interface Rule {
  sheet: string; project: string; header: number;               // номер строки заголовка (0 — заголовка нет)
  status: 'color' | Status;                                     // color: зелёный — утверждено, остальное — черновик
  cols: Partial<Record<'ru' | 'en' | 'context' | 'definition' | 'examples' | 'comment' | 'official' | 'enContext' | 'enExamples' | 'wrong', number>>;
  archive?: boolean; sections?: boolean;
}
const GREEN = new Set(['FFB7E1CD', 'FFD9EAD3', 'FFB6D7A8', 'FF00FF00']);
const SHEETS: Rule[] = [
  { sheet: 'WB ПВЗ', project: 'ПВЗ', header: 1, status: 'color', cols: { ru: 1, en: 2, context: 3 } },
  { sheet: 'WBWH', project: 'WBWH', header: 1, status: 'approved', cols: { ru: 1, en: 2, definition: 3, enContext: 4, wrong: 5 } },
  { sheet: 'лигал доки', project: 'Лигал', header: 1, status: 'color', cols: { ru: 1, en: 2, official: 3, context: 4 } },
  { sheet: 'статьи БЗ', project: 'Статьи БЗ', header: 2, status: 'color', cols: { ru: 1, en: 2, enContext: 3, context: 4, examples: 5, enExamples: 6 } },
  { sheet: 'разделы СЦ', project: 'Разделы СЦ', header: 1, status: 'color', cols: { ru: 1, en: 2 } },
  { sheet: 'опции Констр...', project: 'Опции конструктора тарифов', header: 1, status: 'approved', cols: { ru: 1, en: 2, context: 3 } },
  { sheet: 'WB ID DRAFT', project: 'WB ID', header: 1, status: 'draft', cols: { ru: 1, en: 2, context: 3 }, sections: true },
  { sheet: 'WB Taxi DRAFT', project: 'WB Taxi', header: 1, status: 'draft', cols: { ru: 1, en: 2, context: 3 } },
  { sheet: 'WB Job DRAFT', project: 'WB Job', header: 1, status: 'draft', cols: { ru: 1, en: 2, context: 3 } },
  { sheet: 'WB Drive DRAFT', project: 'WB Drive', header: 1, status: 'draft', cols: { ru: 1, en: 2, context: 3 } },
  { sheet: 'WB Rent DRAFT', project: 'WB Rent', header: 0, status: 'draft', cols: { ru: 1, en: 2 } },
  { sheet: 'Pro WB OLD', project: 'Pro WB', header: 0, status: 'approved', archive: true, cols: { ru: 1, en: 2, context: 3 } }
];
const FORBIDDEN_SHEET = 'запрещенка';
const LANG = 'EN';
const WHO = 'загрузка из таблиц';

/** Запрос к базе: тегированная строка (postgres.js или обёртка над PGlite). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<any[]>;

const cell = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: unknown; hyperlink?: string; result?: unknown };
    if (o.richText) return o.richText.map((x) => x.text).join('');
    if (o.text !== undefined) {
      const t = cell(o.text);
      return o.hyperlink && !t.includes(o.hyperlink) ? `${t} (${o.hyperlink})` : t;   // ссылка: текст и адрес
    }
    if (o.result !== undefined) return cell(o.result);
    return '';
  }
  return String(v);
};
const tidy = (v: string) => v.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const clean = (v: string) => (v === '—' || v === '-' ? '' : v);
const fillOf = (c: ExcelJS.Cell) => ((c.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb ?? '').toUpperCase();
const doubtful = (t: string) => /[a-z][а-яё]|[а-яё][a-z]/i.test(t) ? 'русская буква внутри английского слова'
  : /[а-яё]/i.test(t) ? 'в переводе есть пометки по-русски' : /\?/.test(t) ? 'в переводе есть вопрос' : /\|/.test(t) ? 'несколько вариантов через «|»' : '';

export async function runProjectSheets(tx: Db, xlsx: string) {
const R: Record<string, string[]> = {
  newTerm: [], newReq: [], noEn: [], addEn: [], trReq: [], repReq: [], same: [], proj: [], filled: [], reqProj: [], reqClosed: [],
  archived: [], flags: [], dup: [], forb: [], forbMiss: [], projects: [], skipped: [], sections: []
};
const perSheet: string[] = [];

const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsx);
{
  const log = (action: string, tb: string | null, req: string | null, after: string | null, details: string) =>
    tx`insert into audit_log(user_label, action, tb, request_code, lang, after, details) values (${WHO}, ${action}, ${tb}, ${req}, ${LANG}, ${after}, ${details})`;

  // проекты
  const projId = new Map<string, number>();
  for (const name of [...new Set(SHEETS.map((s) => s.project))]) {
    let [p] = await tx`select id from projects where lower(name) = lower(${name})`;
    if (!p) { [p] = await tx`insert into projects(name) values (${name}) returning id`; R.projects.push(name); }
    projId.set(name, p.id);
  }
  const seen = new Set<string>();

  for (const rule of SHEETS) {
    const ws = wb.getWorksheet(rule.sheet);
    if (!ws) { perSheet.push(`«${rule.sheet}»: лист не найден — пропущен`); continue; }
    const pid = projId.get(rule.project)!;
    const cnt: Record<string, number> = {};
    const inc = (k: string) => { cnt[k] = (cnt[k] ?? 0) + 1; };
    let section = '';
    for (let i = rule.header + 1; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const g = (k: keyof Rule['cols']) => (rule.cols[k] ? clean(tidy(cell(row.getCell(rule.cols[k]!).value))) : '');
      const ru = g('ru'); const en = g('en');
      if (!ru) continue;
      if (rule.sections && ru === en && !g('context') && fillOf(row.getCell(1))) { section = ru; R.sections.push(`${rule.sheet}: «${ru}» — раздел, стал контекстом для строк ниже`); continue; }
      const where = `${rule.sheet}, стр. ${i}`;
      const status: Status = rule.status === 'color' ? (GREEN.has(fillOf(row.getCell(rule.cols.en!))) ? 'approved' : 'draft') : rule.status;
      const context = [g('context'), rule.sections && section && section !== 'Общее' ? `${rule.project}: ${section}` : ''].filter(Boolean).join('\n');
      const definition = g('definition');
      const examples = g('examples');
      const wrong = g('wrong').split(/[,/]/).map((x) => x.trim()).filter(Boolean);
      const wrongEn = wrong.filter((w) => !/[а-яё]/i.test(w));
      const wrongRu = wrong.filter((w) => /[а-яё]/i.test(w));
      const comment = [g('official') && `Официальное название: ${g('official')}`, wrongRu.length ? `Неправильно: ${wrongRu.join(', ')}` : ''].filter(Boolean).join('\n');
      const enFields = { context: g('enContext'), examples: g('enExamples'), definition: '' };
      const forbidden = wrongEn.map((t) => ({ text: t, note: `из таблицы ${rule.sheet}` }));
      const flag = en ? doubtful(en) : '';

      const [{ k, kt }] = await tx`select norm_term(${ru}) k, norm_term(${en}) kt`;
      const key = `${k}|${kt}|${rule.project}`;
      if (seen.has(key)) { R.dup.push(`${where}: «${ru}» → ${en || '—'} — повтор в листе`); inc('повтор'); continue; }
      seen.add(key);

      const terms = await tx`
        select t.id, t.tb, t.ru, t.status, t.definition, t.examples, t.context, t.comment from terms t
        where t.ru_norm = ${k}
           or exists (select 1 from unnest(string_to_array(t.ru, '/')) p where norm_term(p) = ${k})
           or exists (select 1 from unnest(string_to_array(${ru}, '/')) q where norm_term(q) <> '' and norm_term(q) = t.ru_norm)
        order by (t.status = 'active') desc, t.tb`;
      let t = terms[0];

      // В архиве: для листа устаревших — только проект; для остальных — в отчёт
      if (t && t.status !== 'active' && !rule.archive) { R.archived.push(`${where}: «${ru}» → ${en} — ${t.tb} «${t.ru}» в архиве; не трогаю`); inc('архив'); continue; }

      const addProject = async (termId: number, tb: string) => {
        const r = await tx`insert into term_projects(term_id, project_id) values (${termId}, ${pid}) on conflict do nothing returning term_id`;
        if (r.length) R.proj.push(`${tb} «${t?.ru ?? ru}» + проект ${rule.project}`);
      };
      const fillEmpty = async (termId: number, tb: string) => {
        const upd: string[] = [];
        const cur = (await tx`select definition, examples, context, comment from terms where id = ${termId}`)[0];
        const set: Record<string, string> = {};
        if (definition && !clean(cur.definition)) set.definition = definition;
        if (examples && !clean(cur.examples)) set.examples = examples;
        if (context && !clean(cur.context)) set.context = context;
        if (comment && !cur.comment.includes(comment)) set.comment = [cur.comment, comment].filter(Boolean).join('\n');
        if (set.definition) await tx`update terms set definition = ${set.definition}, updated_at = now() where id = ${termId}`;
        if (set.examples) await tx`update terms set examples = ${set.examples}, updated_at = now() where id = ${termId}`;
        if (set.context) await tx`update terms set context = ${set.context}, updated_at = now() where id = ${termId}`;
        if (set.comment) await tx`update terms set comment = ${set.comment}, updated_at = now() where id = ${termId}`;
        upd.push(...Object.keys(set));
        await tx`select ensure_term_lang(${termId}, ${LANG})`;
        const tl = (await tx`select context, examples, definition, forbidden from term_langs where term_id = ${termId} and lang = ${LANG}`)[0];
        if (enFields.context && !tl.context) { await tx`update term_langs set context = ${enFields.context} where term_id = ${termId} and lang = ${LANG}`; upd.push('EN-контекст'); }
        if (enFields.examples && !tl.examples) { await tx`update term_langs set examples = ${enFields.examples} where term_id = ${termId} and lang = ${LANG}`; upd.push('EN-примеры'); }
        const have = new Set((tl.forbidden as { text: string }[]).map((x) => x.text.toLowerCase()));
        const add = forbidden.filter((x) => !have.has(x.text.toLowerCase()));
        if (add.length) { await tx`update term_langs set forbidden = forbidden || ${JSON.stringify(add)}::jsonb where term_id = ${termId} and lang = ${LANG}`; upd.push('«Как нельзя»'); }
        if (upd.length) R.filled.push(`${tb}: ${upd.join(', ')} (${where})`);
      };
      const createTerm = async (st: 'active' | 'archived', withEn: boolean) => {
        const [n] = await tx`
          insert into terms(tb, ru, definition, examples, context, comment, status, archive_reason)
          values ('TB-' || lpad(nextval('tb_seq')::text, 5, '0'), ${ru}, ${definition}, ${examples}, ${context}, ${comment}, ${st}, ${st === 'archived' ? 'manual' : null})
          returning id, tb, ru`;
        if (withEn) await tx`select add_translation(${n.id}, ${LANG}, ${en}, 'approved', null)`;
        t = n;
        await addProject(n.id, n.tb); R.proj.pop();
        await fillEmpty(n.id, n.tb); R.filled.pop();
        await log(withEn ? 'Термин добавлен из таблицы' : 'Термин добавлен из таблицы без перевода', n.tb, null, withEn ? en : null, `${where}; проект ${rule.project}`);
        return n;
      };
      const newRequest = async (type: 'new' | 'translation' | 'replace', target?: { id: number; text: string }) => {
        const [{ w }] = await tx`select duplicate_warnings(${type === 'new' ? ru : ''}, ${JSON.stringify({ [LANG]: en })}::jsonb, ${t?.id ?? null}, null) w`;
        const warnings = [...(flag ? [`Проверьте перевод: ${flag}`] : []), ...(w ?? [])];
        const reason = type === 'replace'
          ? `В таблице проекта ${rule.project} для «${ru}» стоит «${en}», в глоссарии — «${target!.text}». Утвердите, если правильно из таблицы; если для этого проекта нужен свой перевод — отклоните и предложите отдельный термин с контекстом.` : '';
        const note = `Из таблицы «${rule.sheet}», строка ${i}.` + (flag ? ` ⚠ Проверьте перевод: ${flag}.` : '');
        const [r] = await tx`
          insert into requests(code, type, term_id, target_translation_id, ru, definition, examples, context, comment, project_ids, lang, translation, lang_fields, reason, warnings)
          values ('Z-' || lpad(nextval('req_seq')::text, 5, '0'), ${type}, ${t?.id ?? null}, ${target?.id ?? null}, ${t?.ru ?? ru},
                  ${type === 'new' ? definition : ''}, ${type === 'new' ? examples : ''}, ${type === 'new' ? context : ''},
                  ${type === 'new' ? [note, comment].filter(Boolean).join('\n') : note}, ${type === 'new' ? [pid] : []}::int[],
                  ${LANG}, ${en}, ${JSON.stringify(type === 'new' ? { ...enFields, forbidden } : {})}::jsonb, ${reason}, ${warnings}::text[])
          returning id, code`;
        if (type === 'new') await tx`insert into request_translations(request_id, lang, text) values (${r.id}, ${LANG}, ${en})`;
        await log('Заявка из таблицы', t?.tb ?? null, r.code, en, `${where}; проект ${rule.project}`);
        if (flag) R.flags.push(`${r.code}: «${ru}» → ${en} — ${flag}`);
        return r.code as string;
      };

      if (t) {
        await addProject(t.id, t.tb);
        await fillEmpty(t.id, t.tb);
        if (!en) { inc('есть, без перевода в таблице'); continue; }
        const live = await tx`select id, text, text_norm, status from translations where term_id = ${t.id} and lang = ${LANG} and status <> 'obsolete' order by sort, id`;
        const same = live.find((x) => x.text_norm === kt);
        if (same) {
          if (status === 'approved' && same.status === 'draft' && t.status === 'active') {
            await tx`update translations set status = 'approved', approved_at = now() where id = ${same.id}`;
            R.addEn.push(`${t.tb} «${t.ru}» — черновик «${en}» согласован (${where})`); inc('черновик согласован');
          } else { R.same.push(`${t.tb} «${t.ru}» — ${en} (${where})`); inc('уже есть'); }
          continue;
        }
        if (t.status !== 'active') { R.archived.push(`${where}: «${ru}» → ${en} — ${t.tb} в архиве, перевод другой («${live[0]?.text ?? '—'}»); добавлен только проект`); inc('архив'); continue; }
        const open = await tx`select code from requests where status = 'pending' and term_id = ${t.id} and lang = ${LANG} and norm_term(translation) = ${kt}`;
        if (open.length) { R.same.push(`${t.tb} «${t.ru}» — ${en}: уже есть заявка ${open[0].code} (${where})`); inc('уже есть заявка'); continue; }
        const main = live.find((x) => x.status === 'approved' || x.status === 'unchecked');
        if (!main) {
          if (status === 'approved') {
            await tx`select add_translation(${t.id}, ${LANG}, ${en}, 'approved', null)`;
            await log('Перевод добавлен из таблицы', t.tb, null, en, `${where}; проект ${rule.project}`);
            R.addEn.push(`${t.tb} «${t.ru}» + EN «${en}» согласован (${where})`); inc('добавлен EN');
          } else { const c = await newRequest('translation'); R.trReq.push(`${c}: ${t.tb} «${t.ru}» → ${en} (${where})`); inc('заявка: перевод'); }
          continue;
        }
        const c = await newRequest('replace', { id: main.id, text: main.text });
        R.repReq.push(`${c}: ${t.tb} «${t.ru}» — сейчас «${main.text}», в таблице ${rule.project} «${en}» (${where})`); inc('заявка: замена');
        continue;
      }

      // Термина нет. Есть ли уже заявка на новый термин?
      const reqs = await tx`select id, code, translation, project_ids from requests where status = 'pending' and type = 'new' and norm_term(ru) = ${k} order by id`;
      const sameReq = reqs.find((r) => en && r.translation && reqs.length && r.translation.toLowerCase().replace(/\s+/g, ' ') === en.toLowerCase().replace(/\s+/g, ' '));
      if (rule.archive) {
        const n = await createTerm('archived', !!en); R.newTerm.push(`${n.tb} «${ru}» → ${en} — сразу в архив (${where})`); inc('в архив'); continue;
      }
      if (!en) { const n = await createTerm('active', false); R.noEn.push(`${n.tb} «${ru}» — нужен перевод (${where})`); inc('без перевода'); continue; }
      if (status === 'approved') {
        const n = await createTerm('active', true);
        R.newTerm.push(`${n.tb} «${ru}» → ${en} (${where})`); inc('новый термин');
        for (const r of reqs) {
          if (sameReq && r.id === sameReq.id) {
            await tx`update requests set status = 'auto_removed', decided_at = now(), term_id = ${n.id}, reason = ${`Термин утверждён из таблицы проекта ${rule.project}: ${n.tb}`} where id = ${r.id}`;
            R.reqClosed.push(`${r.code} снята: «${ru}» утверждён как ${n.tb} (${where})`);
          }
        }
        continue;
      }
      if (sameReq) {
        if (!sameReq.project_ids.includes(pid)) { await tx`update requests set project_ids = array_append(project_ids, ${pid}::int) where id = ${sameReq.id}`; R.reqProj.push(`${sameReq.code} «${ru}» + проект ${rule.project}`); }
        inc('уже есть заявка'); continue;
      }
      const c = await newRequest('new'); R.newReq.push(`${c}: «${ru}» → ${en} (${where})`); inc('заявка: новый');
    }
    perSheet.push(`«${rule.sheet}» → проект ${rule.project}: ` + Object.entries(cnt).map(([a, b]) => `${a} ${b}`).join(', '));
  }

  // «Как нельзя» из листа запрещенки
  const Z = wb.getWorksheet(FORBIDDEN_SHEET);
  if (Z) for (let i = 2; i <= Z.rowCount; i++) {
    const ru = clean(tidy(cell(Z.getRow(i).getCell(1).value))); const bad = clean(tidy(cell(Z.getRow(i).getCell(2).value)));
    const note = clean(tidy(cell(Z.getRow(i).getCell(3).value)));
    if (!ru || !bad) continue;
    const [t] = await tx`select t.id, t.tb, t.ru from terms t where t.status = 'active' and (t.ru_norm = norm_term(${ru}) or exists (select 1 from unnest(string_to_array(t.ru, '/')) p where norm_term(p) = norm_term(${ru}))) order by t.tb limit 1`;
    if (!t) { R.forbMiss.push(`«${ru}» — нельзя «${bad}»: термин не найден`); continue; }
    await tx`select ensure_term_lang(${t.id}, ${LANG})`;
    const [tl] = await tx`select forbidden from term_langs where term_id = ${t.id} and lang = ${LANG}`;
    if ((tl.forbidden as { text: string }[]).some((x) => x.text.toLowerCase() === bad.toLowerCase())) { R.forb.push(`${t.tb} «${t.ru}» — «${bad}» уже был`); continue; }
    await tx`update term_langs set forbidden = forbidden || ${JSON.stringify([{ text: bad, note: note || 'из таблицы «запрещенка»' }])}::jsonb where term_id = ${t.id} and lang = ${LANG}`;
    await log('Добавлено «Как нельзя» из таблицы', t.tb, null, bad, 'запрещенка');
    R.forb.push(`${t.tb} «${t.ru}» — нельзя «${bad}»`);
  }
  await tx`insert into audit_log(user_label, action, details) values (${WHO}, 'Загрузка проектных таблиц', ${perSheet.join('; ')})`;
}

const sec = (h: string, a: string[], note = '') => (a.length ? [`## ${h} (${a.length})`, ...(note ? [note] : []), ...a.map((x) => '- ' + x), ''] : []);
const report = [
  '# Проектные таблицы: сопоставление и загрузка', '',
  '## По листам', ...perSheet.map((x) => '- ' + x), '',
  ...sec('Новые проекты', R.projects),
  ...sec('Новые термины (утверждены)', R.newTerm),
  ...sec('Новые термины без перевода — «Нужен перевод»', R.noEn),
  ...sec('Согласованный EN добавлен к существующему термину', R.addEn),
  ...sec('Заявки «Новый термин» (черновики) — валидатору EN', R.newReq),
  ...sec('Заявки «Перевод к существующему» — валидатору EN', R.trReq),
  ...sec('Заявки «Замена»: у термина другой перевод — валидатору EN', R.repReq, 'Часто это значит, что в проекте термин значит другое. Тогда лучше отклонить замену и предложить отдельный термин с контекстом проекта.'),
  ...sec('Помечены «проверьте перевод»', R.flags),
  ...sec('Заявки, снятые потому что термин утверждён из таблицы', R.reqClosed),
  ...sec('Проект добавлен к уже поданной заявке', R.reqProj),
  ...sec('Проект добавлен к существующему термину', R.proj),
  ...sec('Заполнены пустые поля существующих терминов', R.filled),
  ...sec('Уже есть с тем же переводом', R.same),
  ...sec('Термин в архиве', R.archived),
  ...sec('«Как нельзя» (EN) из листа «запрещенка»', R.forb),
  ...sec('«Как нельзя»: термин не найден', R.forbMiss),
  ...sec('Строки-разделы', R.sections),
  ...sec('Повторы внутри листа', R.dup)
].join('\n');
const summary = `Итого: новых терминов ${R.newTerm.length}, без перевода ${R.noEn.length}, EN добавлен ${R.addEn.length}, заявок: новых ${R.newReq.length}, перевод ${R.trReq.length}, замена ${R.repReq.length}; проект добавлен ${R.proj.length}; поля заполнены ${R.filled.length}; «как нельзя» ${R.forb.length}, не найдено ${R.forbMiss.length}; снято заявок ${R.reqClosed.length}`;
return { report, summary, perSheet };
}
