/**
 * Неутверждённые термины из таблицы → заявки в базе (на решение валидатору языка).
 *
 * npx tsx scripts/sheet-requests.ts строки.json EN "название таблицы"            — пробный прогон: только отчёт, база не меняется
 * npx tsx scripts/sheet-requests.ts строки.json EN "название таблицы" --apply    — создать заявки
 *
 * строки.json — массив строк таблицы: [русский, перевод, комментарий, пример, пример…], первая строка — заголовки.
 * Для каждой строки:
 *  - такого русского термина нет                 → заявка «Новый термин» с переводом;
 *  - термин есть, перевода на язык нет            → заявка «Перевод к существующему»;
 *  - термин есть, перевод тот же                  → ничего;
 *  - термин есть, перевод другой                  → заявка «Замена» (валидатор решит, заменить или отклонить);
 *  - термин в архиве                              → только в отчёт.
 * Сомнительные переводы (вопросы, пометки по-русски, несколько вариантов через «|») получают пометку в заявке.
 * Отчёт пишется рядом со строки.json: «… — отчёт.md».
 */
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

const [file, lang, title] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!file || !lang || !title) { console.error('Нужно: строки.json КОД_ЯЗЫКА "название таблицы" [--apply]'); process.exit(1); }

const env = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
if (!env) { console.error('В .env.local нет DATABASE_URL'); process.exit(1); }
const sql = postgres(env.slice(13).trim(), { prepare: false, max: 1 });

const tidy = (v: unknown) => String(v ?? '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const doubtful = (t: string) => /[a-z][а-яё]|[а-яё][a-z]/i.test(t) || /(^|\s)[асеорху][a-z]/i.test(t) ? 'русская буква внутри английского слова (похожа на латинскую)'
  : /[а-яё]/i.test(t) ? 'в переводе есть пометки по-русски'
  : /\?/.test(t) ? 'в переводе есть вопрос' : /\|/.test(t) ? 'несколько вариантов через «|»' : '';

const rows: string[][] = JSON.parse(readFileSync(file, 'utf8')).slice(1);
const out = { neu: [] as string[], tr: [] as string[], rep: [] as string[], same: [] as string[], arch: [] as string[], dup: [] as string[], skip: [] as string[], flag: [] as string[] };
const seen = new Map<string, string>();
let created = 0;
// пробный прогон не должен расходовать номера заявок: запомним счётчик и вернём его
const [{ last, called }] = await sql`select last_value as last, is_called as called from req_seq`;

await sql.begin(async (tx) => {
  for (const [n, raw] of rows.entries()) {
    const line = n + 2;
    const [ru, tr, c, ...ex] = [tidy(raw[0]), tidy(raw[1]), tidy(raw[2]), ...raw.slice(3).map(tidy)];
    if (!ru && !tr) continue;
    if (!ru || !tr) { out.skip.push(`строка ${line}: «${ru || tr}» — нет ${ru ? 'перевода' : 'русского термина'}`); continue; }
    const [{ k, kt }] = await tx`select norm_term(${ru}) k, norm_term(${tr}) kt`;
    const key = `${k}|${kt}`;
    if (seen.has(key)) { out.dup.push(`строка ${line}: «${ru}» → ${tr} — повтор строки ${seen.get(key)}`); continue; }
    seen.set(key, String(line));
    const flag = doubtful(tr);
    const examples = ex.filter((x) => x && x !== '—').join('\n');
    const comment = `Из таблицы «${title}», строка ${line}.` + (flag ? ` ⚠ Проверьте перевод: ${flag}.` : '');

    // Есть ли такой термин (целиком или как часть «А / Б»), сначала действующие
    const terms = await tx`
      select t.id, t.tb, t.ru, t.status from terms t
      where t.ru_norm = ${k}
         or exists (select 1 from unnest(string_to_array(t.ru, '/')) p where norm_term(p) = ${k})
         or exists (select 1 from unnest(string_to_array(${ru}, '/')) q where norm_term(q) <> '' and norm_term(q) = t.ru_norm)
      order by (t.status = 'active') desc, t.tb`;
    const t = terms[0];
    if (t && t.status !== 'active') { out.arch.push(`строка ${line}: «${ru}» → ${tr} — термин ${t.tb} «${t.ru}» в архиве; заявку не создаю`); continue; }

    let type: 'new' | 'translation' | 'replace' = 'new';
    let target: { id: number; text: string } | undefined;
    if (t) {
      const live = await tx`select id, text, text_norm, status from translations where term_id = ${t.id} and lang = ${lang} and status <> 'obsolete' order by sort, id`;
      if (live.some((x) => x.text_norm === kt)) { out.same.push(`${t.tb} «${t.ru}» — ${tr}`); continue; }
      const main = live.find((x) => x.status === 'approved' || x.status === 'unchecked');
      if (main) { type = 'replace'; target = { id: main.id, text: main.text }; } else type = 'translation';
      const open = await tx`select code from requests where status = 'pending' and term_id = ${t.id} and lang = ${lang} and norm_term(translation) = ${kt}`;
      if (open.length) { out.same.push(`${t.tb} «${t.ru}» — ${tr} (уже есть заявка ${open[0].code})`); continue; }
    }

    const [{ w }] = await tx`select duplicate_warnings(${type === 'new' ? ru : ''}, ${sql.json({ [lang]: tr })}, ${t?.id ?? null}, null) w`;
    const warnings: string[] = [...(flag ? [`Проверьте перевод: ${flag}`] : []), ...(w ?? [])];
    const reason = type === 'replace' ? `В таблице «${title}» для «${ru}» предложено «${tr}», в глоссарии — «${target!.text}». Утвердите, если правильно из таблицы; если верны оба — отклоните и добавьте вариант в карточке термина.` : '';
    const [{ code, id }] = await tx`
      insert into requests(code, type, term_id, target_translation_id, ru, context, examples, comment, lang, translation, reason, warnings)
      values ('Z-' || lpad(nextval('req_seq')::text, 5, '0'), ${type}, ${t?.id ?? null}, ${target?.id ?? null}, ${t ? t.ru : ru},
              ${type === 'new' ? c : ''}, ${type === 'new' ? examples : ''},
              ${type === 'new' ? comment : [comment, c && `Комментарий: ${c}`, examples && `Пример: ${examples}`].filter(Boolean).join('\n')},
              ${lang}, ${tr}, ${reason}, ${warnings})
      returning code, id`;
    if (type === 'new') await tx`insert into request_translations(request_id, lang, text) values (${id}, ${lang}, ${tr})`;
    created++;
    const label = `${code}: «${ru}» → ${tr}`;
    if (type === 'new') out.neu.push(label);
    else if (type === 'translation') out.tr.push(`${label} (к ${t.tb} «${t.ru}», перевода ${lang} не было)`);
    else out.rep.push(`${label} (${t.tb} «${t.ru}», сейчас «${target!.text}»)`);
    if (flag) out.flag.push(`${code}: «${ru}» → ${tr} — ${flag}`);
  }
  await tx`insert into audit_log(user_label, action, lang, details) values ('загрузка из таблицы', 'Заявки из таблицы', ${lang}, ${`«${title}»: создано заявок ${created}`})`;
  if (!apply) throw new Error('DRY_RUN');
}).catch((e) => { if ((e as Error).message !== 'DRY_RUN') throw e; });
if (!apply) await sql`select setval('req_seq', ${last}, ${called})`;
await sql.end();

const sec = (h: string, a: string[], note = '') => [`## ${h} (${a.length})`, ...(note ? [note] : []), ...a.map((x) => '- ' + x), ''];
const md = [
  `# ${apply ? 'Загружено' : 'Пробный прогон (база не изменена)'}: «${title}» → заявки ${lang}`, '',
  `Строк в таблице: ${rows.length}. ${apply ? 'Создано' : 'Будет создано'} заявок: ${created}. Номера заявок в пробном прогоне условные.`, '',
  ...sec('Новые термины', out.neu),
  ...sec('Перевод к существующему термину', out.tr),
  ...sec('Другой перевод у существующего термина — на решение валидатору', out.rep),
  ...sec('Помечены «проверьте перевод»', out.flag, 'Заявки созданы, но в переводе есть вопросы, пометки или несколько вариантов — валидатору нужно выбрать один.'),
  ...sec('Уже есть в глоссарии с тем же переводом — пропущено', out.same),
  ...sec('Термин в архиве — пропущено', out.arch),
  ...sec('Повторы внутри таблицы — пропущено', out.dup),
  ...sec('Пустые или неполные строки — пропущено', out.skip)
].join('\n');
const rep = file.replace(/\.json$/, ' — отчёт.md');
writeFileSync(rep, md);
console.log(`${apply ? 'Создано' : 'Будет создано'} заявок: ${created} (новых ${out.neu.length}, к существующим ${out.tr.length}, замен ${out.rep.length}); пропущено: тот же перевод ${out.same.length}, архив ${out.arch.length}, повторы ${out.dup.length}, неполные ${out.skip.length}; с пометкой ${out.flag.length}`);
console.log('Отчёт:', rep);
