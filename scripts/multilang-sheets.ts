/**
 * Многоязычные таблицы проектов → глоссарий, с сопоставлением. Статус — по цвету каждой ячейки перевода.
 * Данные: папка с <имя>.json — строки таблицы, каждая ячейка [значение, цвет RRGGBB] (снято из Google Таблиц).
 * Запуск через scripts/offline-apply.ts multilang <папка> <отчёт.md> [--apply].
 *
 * Для каждой строки и каждого языка:
 *   термин есть, перевода на язык нет        → перевод добавляется (утверждён / черновик по цвету)
 *   термин есть, перевод тот же              → ничего (черновик того же текста согласуется, если в таблице утверждён)
 *   термин есть, перевод другой              → заявка «Замена» валидатору языка
 *   термина нет, есть утверждённые переводы  → новый термин; черновые ячейки — черновиками
 *   термина нет, все переводы черновые       → заявка «Новый термин» на все языки с этими переводами
 * Ждущие заявки на этот же русский термин закрываются: их переводы переносятся в термин черновиками.
 * Проект добавляется термину всегда; пустые поля русской части и языков заполняются, заполненные не меняются.
 */
import { readFileSync } from 'node:fs';
import type { Db } from './project-sheets';

type Cell = [string, string];
type Status = 'approved' | 'draft';
interface LangCol { lang: string; col: number; note?: number; variants?: number }
interface Spec {
  file: string; title: string; project: string;
  ru: number; definition?: number; context?: number; category?: number; lqa?: number; ruVariants?: number;
  langs: LangCol[];
  status: (row: Cell[], rowNo: number, col: number) => Status;   // rowNo — номер строки в таблице (заголовок — 1)
}
const RED = new Set(['F4CCCC', 'FF0000', 'EA9999', 'E06666', 'CC0000']);
const WHITE = new Set(['FFFFFF']);

export const SPECS: Spec[] = [
  {
    file: 'marketing', title: 'Маркетинг', project: 'Маркетинг', ru: 2, definition: 3, category: 0, lqa: 1, ruVariants: 4,
    langs: [{ lang: 'HY', col: 5, variants: 6 }, { lang: 'KA', col: 7, variants: 8 }, { lang: 'UZ', col: 9, variants: 10 },
      { lang: 'KY', col: 11, variants: 12 }, { lang: 'KK', col: 13, variants: 14 }, { lang: 'TG', col: 15, variants: 16 }],
    // утверждено всё, что не выделено красным (ни ячейка перевода, ни русский термин)
    status: (row, _n, col) => (RED.has(row[col]?.[1] ?? '') || RED.has(row[2]?.[1] ?? '') ? 'draft' : 'approved')
  },
  {
    file: 'pvz', title: 'Глоссарий ПВЗ все языки', project: 'ПВЗ', ru: 1, context: 0,
    langs: ['EN', 'KA', 'HY', 'KK', 'KY', 'TR', 'UZ', 'TG', 'AZ', 'ZH', 'AM', 'SW'].map((lang, i) => ({ lang, col: i + 2 })),
    // строки после 65-й — черновики; красные ячейки — тоже черновики
    status: (row, n, col) => (n > 65 || RED.has(row[col]?.[1] ?? '') ? 'draft' : 'approved')
  },
  {
    file: 'taxi', title: 'Глоссарий для проектов Taxi', project: 'WB Taxi', ru: 1, context: 0,
    langs: ['EN', 'KY', 'UZ', 'HY', 'KA', 'KK'].map((lang, i) => ({ lang, col: i + 2 })),
    // без заливки — утверждено, с любой заливкой — черновик
    status: (row, _n, col) => (WHITE.has(row[col]?.[1] ?? 'FFFFFF') ? 'approved' : 'draft')
  },
  {
    file: 'job', title: 'Глоссарий WB Job', project: 'WB Job', ru: 1, context: 0,
    langs: [{ lang: 'KK', col: 2, note: 3 }, { lang: 'UZ', col: 4, note: 5 }, { lang: 'TG', col: 6, note: 7 }, { lang: 'HY', col: 8, note: 9 }, { lang: 'KY', col: 10 }],
    // белая заливка — нормальные (утверждено), остальное — черновик
    status: (row, _n, col) => (WHITE.has(row[col]?.[1] ?? 'FFFFFF') ? 'approved' : 'draft')
  }
];

const tidy = (v: string) => (v ?? '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const clean = (v: string) => (v === '—' || v === '-' ? '' : v);
// сравнение переводов: регистр, пробелы и все виды апострофа (узб. ʻ ‘ ’ ') не различаем
const same = (a: string, b: string) => {
  const f = (x: string) => x.toLowerCase().replace(/[ʻʼ‘’'`´]/g, '').replace(/\s+/g, ' ').trim();
  return f(a) === f(b);
};
const doubtful = (t: string) => /\?/.test(t) ? 'в переводе есть вопрос' : /\|/.test(t) ? 'несколько вариантов через «|»' : '';

export async function runMultilang(tx: Db, dir: string) {
  const R: Record<string, string[]> = {
    newTerm: [], newReq: [], addTr: [], approved: [], repReq: [], same: [], proj: [], filled: [], closed: [], archived: [], flags: [], skipped: []
  };
  const perSheet: string[] = [];
  const noValidator = new Map<string, number>();
  const WHO = 'загрузка из таблиц';
  const log = (action: string, tb: string | null, req: string | null, lang: string | null, after: string | null, details: string) =>
    tx`insert into audit_log(user_label, action, tb, request_code, lang, after, details) values (${WHO}, ${action}, ${tb}, ${req}, ${lang}, ${after}, ${details})`;
  const langsOk = new Set((await tx`select code from languages where active`).map((r: { code: string }) => r.code));
  const hasValidator = new Set((await tx`select lang from profiles where role = 'validator' and active`).map((r: { lang: string }) => r.lang));

  for (const spec of SPECS) {
    const rows: Cell[][] = JSON.parse(readFileSync(`${dir}/${spec.file}.json`, 'utf8'));
    const [p] = await tx`select id from projects where lower(name) = lower(${spec.project})`;
    if (!p) throw new Error(`Нет проекта «${spec.project}»`);
    const pid: number = p.id;
    const cnt: Record<string, number> = {};
    const inc = (k: string, n = 1) => { cnt[k] = (cnt[k] ?? 0) + n; };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; const rowNo = i + 1; const where = `${spec.title}, стр. ${rowNo}`;
      const v = (c?: number) => (c === undefined ? '' : clean(tidy(row[c]?.[0] ?? '')));
      const ru = v(spec.ru);
      if (!ru) continue;
      if (/^[\d\s.,/-]+$/.test(ru)) { R.skipped.push(`${where}: «${ru}» — не похоже на термин (только цифры)`); continue; }
      const definition = v(spec.definition);
      const context = [v(spec.context), spec.category !== undefined && v(spec.category) ? `Категория: ${v(spec.category)}` : ''].filter(Boolean).join('\n');
      const comment = [v(spec.lqa) && `LQA: ${v(spec.lqa)}`, v(spec.ruVariants) && `Варианты в маркетинге: ${v(spec.ruVariants)}`].filter(Boolean).join('\n');
      const cells = spec.langs.map((l) => ({ ...l, text: v(l.col), status: spec.status(row, rowNo, l.col),
        langContext: [l.variants !== undefined && v(l.variants) ? `Варианты: ${v(l.variants)}` : '', l.note !== undefined ? v(l.note) : ''].filter(Boolean).join('\n') }))
        .filter((c) => c.text && langsOk.has(c.lang));
      if (!cells.length) { R.skipped.push(`${where}: «${ru}» — нет ни одного перевода`); continue; }

      const [{ k }] = await tx`select norm_term(${ru}) k`;
      const terms = await tx`
        select t.id, t.tb, t.ru, t.status from terms t
        where t.ru_norm = ${k}
           or exists (select 1 from unnest(string_to_array(t.ru, '/')) q where norm_term(q) = ${k})
           or exists (select 1 from unnest(string_to_array(${ru}, '/')) q where norm_term(q) <> '' and norm_term(q) = t.ru_norm)
        order by (t.status = 'active') desc, t.tb`;
      let t = terms[0] as { id: number; tb: string; ru: string; status: string } | undefined;
      if (t && t.status !== 'active') { R.archived.push(`${where}: «${ru}» — ${t.tb} «${t.ru}» в архиве; не трогаю`); inc('архив'); continue; }

      const fillTerm = async (id: number, tb: string, isNew: boolean) => {
        const r = await tx`insert into term_projects(term_id, project_id) values (${id}, ${pid}) on conflict do nothing returning term_id`;
        if (r.length && !isNew) R.proj.push(`${tb} «${t?.ru ?? ru}» + проект ${spec.project}`);
        const [cur] = await tx`select definition, context, comment from terms where id = ${id}`;
        const upd: string[] = [];
        if (definition && !clean(cur.definition)) { await tx`update terms set definition = ${definition}, updated_at = now() where id = ${id}`; upd.push('определение'); }
        if (context && !clean(cur.context)) { await tx`update terms set context = ${context}, updated_at = now() where id = ${id}`; upd.push('контекст'); }
        if (comment && !cur.comment.includes(comment)) { await tx`update terms set comment = ${[cur.comment, comment].filter(Boolean).join('\n')}, updated_at = now() where id = ${id}`; upd.push('комментарий'); }
        for (const c of cells) {
          if (!c.langContext) continue;
          await tx`select ensure_term_lang(${id}, ${c.lang})`;
          const [tl] = await tx`select context from term_langs where term_id = ${id} and lang = ${c.lang}`;
          if (!tl.context) { await tx`update term_langs set context = ${c.langContext} where term_id = ${id} and lang = ${c.lang}`; upd.push(`${c.lang}-контекст`); }
        }
        if (upd.length && !isNew) R.filled.push(`${tb}: ${upd.join(', ')} (${where})`);
      };

      // Ждущие заявки на этот же термин (например, из «in progress»): переводы — в термин черновиками, заявки снимаем
      const absorbRequests = async (term: { id: number; tb: string }) => {
        const reqs = await tx`select id, code, lang, translation from requests where status = 'pending' and type = 'new' and norm_term(ru) = ${k}`;
        for (const r of reqs) {
          const trs = await tx`select lang, text from request_translations where request_id = ${r.id}`;
          for (const x of trs) {
            const have = await tx`select 1 from translations where term_id = ${term.id} and lang = ${x.lang} and status <> 'obsolete' and text_norm = norm_term(${x.text})`;
            if (!have.length && langsOk.has(x.lang)) await tx`select add_translation(${term.id}, ${x.lang}, ${x.text}, 'draft', null)`;
          }
          await tx`update requests set status = 'auto_removed', decided_at = now(), term_id = ${term.id},
            reason = ${`Термин заведён из таблицы «${spec.title}» (${term.tb}); переводы из заявки добавлены черновиками.`} where id = ${r.id}`;
          R.closed.push(`${r.code} «${ru}» → ${term.tb}, переводы заявки — черновиками (${where})`);
        }
      };

      if (!t) {
        const anyApproved = cells.some((c) => c.status === 'approved');
        if (!anyApproved) {
          const [{ w }] = await tx`select duplicate_warnings(${ru}, ${JSON.stringify(Object.fromEntries(cells.map((c) => [c.lang, c.text])))}::jsonb, null, null) w`;
          const [rq] = await tx`
            insert into requests(code, type, ru, definition, context, comment, project_ids, lang, translation, warnings)
            values ('Z-' || lpad(nextval('req_seq')::text, 5, '0'), 'new', ${ru}, ${definition}, ${context},
                    ${[`Из таблицы «${spec.title}», строка ${rowNo}.`, comment].filter(Boolean).join('\n')}, ${[pid]}::int[], null, '', ${w ?? []}::text[])
            returning id, code`;
          for (const c of cells) await tx`insert into request_translations(request_id, lang, text) values (${rq.id}, ${c.lang}, ${c.text})`;
          await log('Заявка из таблицы', null, rq.code, null, ru, `${where}; проект ${spec.project}; языки ${cells.map((c) => c.lang).join(', ')}`);
          R.newReq.push(`${rq.code}: «${ru}» — ${cells.map((c) => `${c.lang} ${c.text}`).join('; ')} (${where})`); inc('заявка: новый');
          continue;
        }
        const [n] = await tx`insert into terms(tb, ru, definition, context, comment) values ('TB-' || lpad(nextval('tb_seq')::text, 5, '0'), ${ru}, ${definition}, ${context}, ${comment}) returning id, tb, ru, status`;
        t = n as typeof t;
        await fillTerm(n.id, n.tb, true);
        for (const c of cells) await tx`select add_translation(${n.id}, ${c.lang}, ${c.text}, ${c.status}, null)`;
        await absorbRequests(n);
        await log('Термин добавлен из таблицы', n.tb, null, null, ru, `${where}; проект ${spec.project}`);
        const a = cells.filter((c) => c.status === 'approved').map((c) => c.lang); const d = cells.filter((c) => c.status === 'draft').map((c) => c.lang);
        R.newTerm.push(`${n.tb} «${ru}» — утверждено: ${a.join(', ') || '—'}${d.length ? `; черновики: ${d.join(', ')}` : ''} (${where})`); inc('новый термин');
        continue;
      }

      await fillTerm(t.id, t.tb, false);
      await absorbRequests(t);
      for (const c of cells) {
        const flag = doubtful(c.text);
        const live = await tx`select id, text, status from translations where term_id = ${t.id} and lang = ${c.lang} and status <> 'obsolete' order by sort, id`;
        const [{ kt }] = await tx`select norm_term(${c.text}) kt`;
        const found = (live as { id: number; text: string; status: string }[]).find((x) => same(x.text, c.text))
          ?? (await tx`select id, text, status from translations where term_id = ${t.id} and lang = ${c.lang} and status <> 'obsolete' and text_norm = ${kt} limit 1`)[0];
        if (found) {
          if (c.status === 'approved' && found.status === 'draft') {
            await tx`update translations set status = 'approved', approved_at = now() where id = ${found.id}`;
            await log('Черновик согласован по таблице', t.tb, null, c.lang, c.text, where);
            R.approved.push(`${t.tb} «${t.ru}» ${c.lang} «${c.text}» — черновик согласован (${where})`); inc('черновик согласован');
          } else { R.same.push(`${t.tb} «${t.ru}» ${c.lang} — ${c.text}`); inc('уже есть'); }
          continue;
        }
        const main = (live as { id: number; text: string; status: string }[]).find((x) => x.status === 'approved' || x.status === 'unchecked');
        const draftOnly = live.length && !main;
        if (!main) {
          if (draftOnly && c.status === 'draft') { R.same.push(`${t.tb} «${t.ru}» ${c.lang} — уже есть другой черновик, новый не добавляю: «${c.text}»`); inc('уже есть черновик'); continue; }
          await tx`select add_translation(${t.id}, ${c.lang}, ${c.text}, ${c.status}, null)`;
          await log(c.status === 'approved' ? 'Перевод добавлен из таблицы' : 'Черновик добавлен из таблицы', t.tb, null, c.lang, c.text, `${where}; проект ${spec.project}`);
          R.addTr.push(`${t.tb} «${t.ru}» + ${c.lang} «${c.text}» (${c.status === 'approved' ? 'утверждён' : 'черновик'}) (${where})`); inc(c.status === 'approved' ? 'добавлен перевод' : 'добавлен черновик');
          continue;
        }
        const open = await tx`select code from requests where status = 'pending' and term_id = ${t.id} and lang = ${c.lang} and norm_term(translation) = ${kt}`;
        if (open.length) { R.same.push(`${t.tb} «${t.ru}» ${c.lang} — уже есть заявка ${open[0].code}`); inc('уже есть заявка'); continue; }
        const [{ w }] = await tx`select duplicate_warnings('', ${JSON.stringify({ [c.lang]: c.text })}::jsonb, ${t.id}, null) w`;
        const [rq] = await tx`
          insert into requests(code, type, term_id, target_translation_id, ru, comment, lang, translation, reason, warnings)
          values ('Z-' || lpad(nextval('req_seq')::text, 5, '0'), 'replace', ${t.id}, ${main.id}, ${t.ru}, ${`Из таблицы «${spec.title}», строка ${rowNo}.` + (flag ? ` ⚠ ${flag}.` : '')},
                  ${c.lang}, ${c.text},
                  ${`В таблице проекта ${spec.project} для «${ru}» стоит «${c.text}», в глоссарии — «${main.text}». Утвердите, если правильно из таблицы; если для проекта нужен свой перевод — отклоните и предложите отдельный термин с контекстом.`},
                  ${[...(flag ? [`Проверьте перевод: ${flag}`] : []), ...((w as string[]) ?? [])]}::text[])
          returning code`;
        await log('Заявка из таблицы', t.tb, rq.code, c.lang, c.text, `${where}; проект ${spec.project}`);
        if (!hasValidator.has(c.lang)) noValidator.set(c.lang, (noValidator.get(c.lang) ?? 0) + 1);
        if (flag) R.flags.push(`${rq.code}: ${t.tb} ${c.lang} «${c.text}» — ${flag}`);
        R.repReq.push(`${rq.code}: ${t.tb} «${t.ru}» ${c.lang} — сейчас «${main.text}», в таблице «${c.text}» (${where})`); inc('заявка: замена');
      }
    }
    perSheet.push(`«${spec.title}» → проект ${spec.project}: ` + Object.entries(cnt).map(([a, b]) => `${a} ${b}`).join(', '));
  }
  await tx`insert into audit_log(user_label, action, details) values (${WHO}, 'Загрузка многоязычных таблиц', ${perSheet.join('; ')})`;

  const sec = (h: string, a: string[], note = '') => (a.length ? [`## ${h} (${a.length})`, ...(note ? [note] : []), ...a.map((x) => '- ' + x), ''] : []);
  const report = [
    '# Многоязычные таблицы проектов: сопоставление и загрузка', '',
    '## По таблицам', ...perSheet.map((x) => '- ' + x), '',
    ...sec('Новые термины', R.newTerm),
    ...sec('Заявки «Новый термин» — все переводы в таблице черновые', R.newReq),
    ...sec('Добавлены переводы к существующим терминам', R.addTr),
    ...sec('Черновики согласованы (в таблице утверждены)', R.approved),
    ...sec('Заявки «Замена»: у термина другой перевод — валидатору языка', R.repReq,
      noValidator.size ? `У языков без валидатора эти заявки пока видит только владелец: ${[...noValidator].map(([l, n]) => `${l} — ${n}`).join(', ')}.` : ''),
    ...sec('Помечены «проверьте перевод»', R.flags),
    ...sec('Заявки сняты: термин заведён из таблицы, их переводы — черновиками', R.closed),
    ...sec('Проект добавлен к существующему термину', R.proj),
    ...sec('Заполнены пустые поля', R.filled),
    ...sec('Термин в архиве — не трогаю', R.archived),
    ...sec('Уже есть', R.same),
    ...sec('Пропущено', R.skipped)
  ].join('\n');
  const summary = `Итого: новых терминов ${R.newTerm.length}, заявок «новый» ${R.newReq.length}, добавлено переводов ${R.addTr.length}, согласовано черновиков ${R.approved.length}, замен ${R.repReq.length}, проект добавлен ${R.proj.length}, снято заявок ${R.closed.length}`;
  return { report, summary, perSheet };
}
