/**
 * Перенос из Google Таблицы в Supabase (один раз, в пустую базу).
 *
 * 1. В Google Таблице: «Файл» → «Скачать» → «Microsoft Excel (.xlsx)». Скрытые листы «Эталон — …» попадут в файл.
 * 2. В .env.local впиши DATABASE_URL (Supabase → Connect → Session pooler → URI, с паролем базы).
 * 3. npm run import -- "путь/к/файлу.xlsx"
 *
 * Переносит: языки, проекты, людей (из «Настроек»), термины с номерами TB-, переводы со статусами
 * (у сокращённых языков AM, SW, TR, AZ — «Без проверки»),
 * заявки, журнал. В конце пишет отчёт import-report.txt: сколько перенесено и что не удалось.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';

let report: string[] = [];
let problems: string[] = [];
let quiet = false;
const note = (s: string) => { report.push(s); if (!quiet) console.log(s); };
const problem = (s: string) => { problems.push(s); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

const ROLE: Record<string, string> = {
  'владелец': 'owner', 'валидатор': 'validator', 'менеджер': 'manager', 'подрядчик': 'contractor',
  'переводчик en': 'translator', 'переводчик на английский': 'translator', 'переводчик': 'translator', 'читатель': 'reader'
};
const ROLE_RANK = ['owner', 'validator', 'manager', 'translator', 'contractor', 'reader'];
/** Сокращённые глоссарии подрядчиков: в Smartcat не выгружаются, переводы переносятся «Без проверки». */
const SHORT_LANGS = new Set(['AM', 'SW', 'TR', 'AZ']);
const TR_STATUS: Record<string, string> = { 'черновик': 'draft', 'согласовано': 'approved', 'без проверки': 'unchecked', 'устарел': 'obsolete' };
const REQ_TYPE: Record<string, string> = {
  'новое понятие': 'new', 'новый термин': 'new', 'повторное предложение': 'new', 'перевод к существующему': 'translation',
  'дополнительный вариант': 'variant', 'замена': 'replace'
};
const REQ_STATUS: Record<string, string> = { 'на рассмотрении': 'pending', 'утверждена': 'approved', 'отклонена': 'rejected', 'снята автоматически': 'auto_removed' };

/** Перенос в базу через подключение sql (postgres.js или совместимое). */
export async function runImport(sql: Sql, file: string, opts: { force?: boolean; quiet?: boolean } = {}) {
  report = []; problems = []; quiet = !!opts.quiet;
  const force = !!opts.force;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = (...names: string[]) => {
    const ws = wb.worksheets.find((w) => names.includes(w.name.trim()));
    if (!ws) fail(`В файле нет листа «${names[0]}». Скачайте Google Таблицу целиком в формате .xlsx.`);
    return ws!;
  };
  const rows = (...names: string[]) => tableRows(sheet(...names));

  const [{ n }] = await sql`select count(*)::int as n from terms`;
  if (n > 0 && !force) fail(`В базе уже есть термины (${n}). Перенос делается в пустую базу. Если точно нужно — добавьте --force.`);

  await sql.begin(async (tx: Sql) => {
    // ---- Настройки: языки, проекты, люди, параметры
    const st = sheet('Настройки');
    const head = rowValues(st.getRow(1));
    const col = (h: string) => head.findIndex((x) => x === h);
    const [cEmail, cName, cRole, cLangs, cCode, cLName, cSc, cOrd, cProj, cPar, cVal] =
      ['Email', 'Имя', 'Роль', 'Языки', 'Код языка', 'Название языка', 'Код Smartcat', 'Порядок', 'Проект', 'Параметр', 'Значение'].map(col);
    let langs = 0, projects = 0;
    const people: { row: number; email: string; name: string; roleText: string; langsText: string }[] = [];
    for (let i = 2; i <= st.rowCount; i++) {
      const v = rowValues(st.getRow(i));
      const code = s(v[cCode]).toUpperCase();
      if (code) {
        const kind = SHORT_LANGS.has(code) ? 'short' : 'full';
        await tx`insert into languages(code, name, smartcat_code, kind, sort) values (${code}, ${s(v[cLName]) || code}, ${s(v[cSc]) || code.toLowerCase()}, ${kind}, ${Number(v[cOrd]) || 100})
                 on conflict (code) do update set name = excluded.name, smartcat_code = excluded.smartcat_code, kind = excluded.kind, sort = excluded.sort`;
        langs++;
      }
      const p = s(v[cProj]);
      if (p) { await tx`insert into projects(name) values (${p}) on conflict (name) do nothing`; projects++; }
      const email = s(v[cEmail]).toLowerCase();
      if (email) people.push({ row: i, email, name: s(v[cName]) || email, roleText: s(v[cRole]), langsText: s(v[cLangs]) });
      if (s(v[cPar]) === 'Код Smartcat для русского' && s(v[cVal])) {
        await tx`update settings set value = ${s(v[cVal])} where key = 'ru_smartcat_code'`;
      }
    }
    const langSet = new Set((await tx`select code from languages`).map((r: Sql) => r.code as string));
    const shortSet = new Set((await tx`select code from languages where kind = 'short'`).map((r: Sql) => r.code as string));

    // Люди: одна роль и один язык на человека, у языка один валидатор
    let users = 0, contractors = 0;
    const validatorOf = new Set<string>();
    for (const p of people) {
      const texts = p.roleText.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
      const roles = texts.map((r) => ROLE[r]).filter(Boolean);
      if (!roles.length) { problem(`Настройки, строка ${p.row}: у ${p.email} неизвестная роль «${p.roleText}» — не перенесён.`); continue; }
      let role = ROLE_RANK.find((r) => roles.includes(r))!;
      if (roles.length > 1) problem(`Настройки: у ${p.email} несколько ролей (${p.roleText}) — оставлена одна: ${role}. Проверьте в «Администрировании».`);
      let lang: string | null = null;
      if (role === 'translator' || role === 'validator') {
        const ls = texts.some((t) => t.includes(' en') || t.includes('английский')) ? ['EN']
          : p.langsText.split(',').map((x) => x.trim().toUpperCase()).filter((x) => x && langSet.has(x));
        // в Google Таблице валидатор был и переводчиком на английский — в новой системе он валидатор английского (главный редактор)
        if (!ls.length && role === 'validator' && langSet.has('EN')) ls.push('EN');
        if (!ls.length) {
          problem(`Настройки: у ${p.email} (${p.roleText}) не указан язык — перенесён как читатель. Назначьте роль и язык в «Администрировании».`);
          role = 'reader';
        } else {
          lang = ls[0];
          if (ls.length > 1) problem(`Настройки: у ${p.email} несколько языков (${ls.join(', ')}) — оставлен ${lang}. У человека теперь один язык.`);
          if (role === 'validator' && validatorOf.has(lang)) {
            problem(`Настройки: у языка ${lang} уже есть валидатор — ${p.email} перенесён как переводчик ${lang}.`);
            role = 'translator';
          }
          if (role === 'validator') validatorOf.add(lang);
        }
      }
      await tx`insert into profiles(email, name, role, lang, contractor_no)
               values (${p.email}, ${p.name}, ${role}, ${lang}, ${role === 'contractor' ? ++contractors : null})
               on conflict do nothing`;
      users++;
    }
    note(`Языков: ${langs} (сокращённых: ${shortSet.size}), проектов: ${projects}, людей: ${users}.`);
    const projByName = new Map((await tx`select id, name from projects`).map((r: Sql) => [r.name as string, r.id as number] as [string, number]));
    const profByLabel = new Map<string, number>();
    for (const p of await tx`select id, email, name from profiles`) { profByLabel.set(p.email, p.id); profByLabel.set(p.name, p.id); }
    const who = (label: unknown) => { const l = s(label); return l ? profByLabel.get(labelEmail(l)) ?? profByLabel.get(l) ?? null : null; };

    // ---- Термины
    const termId = new Map<string, number>();
    let maxTb = 0;
    for (const r of rows('Эталон — термины', 'Эталон — понятия')) {
      const tb = s(r['Номер']).toUpperCase();
      if (!/^TB-\d+$/.test(tb)) { problem(`Термины: строка ${r._row} без номера TB- — пропущена.`); continue; }
      if (termId.has(tb)) { problem(`Термины: номер ${tb} повторяется (строка ${r._row}) — пропущена.`); continue; }
      const ru = s(r['Русский термин']);
      if (!ru) { problem(`Термины: ${tb} без русского термина — пропущен.`); continue; }
      const status = s(r['Статус']) === 'В архиве' ? 'archived' : 'active';
      const created = d(r['Создано']) ?? new Date();
      const [c] = await tx`insert into terms(tb, ru, definition, examples, context, comment, status, archive_reason, created_at, created_by, updated_at, updated_by)
        values (${tb}, ${ru}, ${s(r['Определение'])}, ${s(r['Примеры'])}, ${s(r['Значение или контекст'])}, ${s(r['Комментарий'])}, ${status},
          ${status === 'archived' ? 'manual' : null}, ${created}, ${who(r['Кем создано'])}, ${d(r['Изменено']) ?? created}, ${who(r['Кем изменено'])}) returning id`;
      termId.set(tb, c.id);
      maxTb = Math.max(maxTb, Number(tb.slice(3)));
      for (const pn of s(r['Проекты']).split(',').map((x) => x.trim()).filter(Boolean)) {
        const pid = projByName.get(pn);
        if (!pid) { problem(`${tb}: проект «${pn}» не найден в настройках — привязка пропущена.`); continue; }
        await tx`insert into term_projects values (${c.id}, ${pid}) on conflict do nothing`;
      }
    }
    note(`Терминов: ${termId.size}.`);

    // ---- Переводы
    const trId = new Map<string, number>();
    const replaced: [number, string][] = [];
    let trCount = 0, uncheckedCount = 0;
    for (const r of rows('Эталон — переводы')) {
      const tid = termId.get(s(r['Номер']).toUpperCase());
      const lang = s(r['Язык']).toUpperCase();
      const text = s(r['Перевод']);
      let status = TR_STATUS[s(r['Статус']).toLowerCase()];
      if (!tid) { problem(`Переводы: ${s(r['ID'])} — термин ${s(r['Номер'])} не найден, пропущен.`); continue; }
      if (!langSet.has(lang)) { problem(`Переводы: ${s(r['ID'])} — язык «${lang}» не в настройках, пропущен.`); continue; }
      if (!text || !status) { problem(`Переводы: ${s(r['ID'])} — пустой перевод или неизвестный статус, пропущен.`); continue; }
      // переводы сокращённых языков переносятся «Без проверки» — валидатор языка пересмотрит их, когда появится
      if (shortSet.has(lang) && status === 'approved') { status = 'unchecked'; uncheckedCount++; }
      const [t] = await tx`insert into translations(term_id, lang, text, sort, status, created_at, created_by, approved_at, approved_by, obsolete_at)
        values (${tid}, ${lang}, ${text}, ${Number(r['Порядок']) || 1}, ${status}, ${d(r['Добавлено']) ?? new Date()}, ${who(r['Кем добавлено'])},
          ${status === 'approved' ? d(r['Согласовано']) : null}, ${status === 'approved' ? who(r['Кем согласовано']) : null}, ${d(r['Устарел'])}) returning id`;
      trId.set(s(r['ID']), t.id);
      if (s(r['Заменён на'])) replaced.push([t.id, s(r['Заменён на'])]);
      trCount++;
    }
    for (const [id, to] of replaced) {
      const nid = trId.get(to);
      if (nid) await tx`update translations set replaced_by = ${nid} where id = ${id}`;
      else problem(`Переводы: замена ${to} не найдена — история замены без ссылки.`);
    }
    note(`Переводов: ${trCount}${uncheckedCount ? ` (из них «Без проверки» в сокращённых языках: ${uncheckedCount})` : ''}.`);

    // ---- Заявки
    let maxZ = 0, reqCount = 0;
    for (const r of rows('Эталон — заявки')) {
      const code = s(r['ID']).toUpperCase();
      const type = REQ_TYPE[s(r['Тип']).toLowerCase()];
      const status = REQ_STATUS[s(r['Статус']).toLowerCase()];
      if (!/^Z-\d+$/.test(code) || !type || !status) { problem(`Заявки: строка ${r._row} (${code || 'без ID'}) — неизвестный тип или статус, пропущена.`); continue; }
      let lang = s(r['Язык']).toUpperCase() || null;
      if (lang && !langSet.has(lang)) lang = null;
      let translation = s(r['Перевод']);
      const en = s(r['EN']);
      if (!lang && en) { lang = 'EN'; translation = en; }
      const [q] = await tx`insert into requests(code, type, status, term_id, target_translation_id, ru, lang, translation, definition, examples, context,
          project_ids, comment, reason, warnings, author_id, created_at, decided_by, decided_at)
        values (${code}, ${type}, ${status}, ${termId.get(s(r['Номер']).toUpperCase()) ?? null}, ${trId.get(s(r['ID заменяемого перевода'])) ?? null},
          ${s(r['Русский термин'])}, ${lang}, ${translation}, ${s(r['Определение'])}, ${s(r['Примеры'])}, ${s(r['Значение или контекст'])},
          ${s(r['Проекты']).split(',').map((x) => projByName.get(x.trim())).filter((x): x is number => !!x)},
          ${[s(r['Комментарий']), s(r['Тип']).toLowerCase() === 'повторное предложение' ? '(перенесено: повторное предложение)' : ''].filter(Boolean).join('\n')},
          ${s(r['Причина'])}, ${s(r['Предупреждения']).split('\n').filter(Boolean)},
          ${who(r['Автор'])}, ${d(r['Подано']) ?? new Date()}, ${who(r['Кем решено'])}, ${d(r['Когда решено'])}) returning id`;
      // английский вариант в заявке на другой язык — отдельной строкой перевода в заявке
      if (en && lang && lang !== 'EN' && langSet.has('EN')) {
        await tx`insert into request_translations(request_id, lang, text, author_id) values (${q.id}, 'EN', ${en}, ${who(r['Автор'])})`;
      }
      if (!who(r['Автор']) && s(r['Автор'])) problem(`Заявки: ${code} — автор «${s(r['Автор'])}» не найден среди людей, заявка без автора.`);
      maxZ = Math.max(maxZ, Number(code.slice(2)));
      reqCount++;
    }
    note(`Заявок: ${reqCount}.`);

    // ---- Журнал
    let logCount = 0;
    for (const r of rows('Эталон — журнал')) {
      const obj = s(r['Объект']).toUpperCase();
      const label = s(r['Кто']);
      await tx`insert into audit_log(at, user_id, user_label, action, tb, request_code, lang, before, after, details)
        values (${d(r['Дата']) ?? new Date()}, ${who(label)}, ${label || 'система'}, ${s(r['Действие']) || '—'},
          ${/^TB-\d+$/.test(obj) ? obj : null}, ${/^Z-\d+$/.test(obj) ? obj : null}, ${s(r['Язык']) || null},
          ${s(r['Было']) || null}, ${s(r['Стало']) || null}, ${s(r['Подробности']) || null})`;
      logCount++;
    }
    await tx`insert into audit_log(user_label, action, details) values ('перенос', 'Перенос из Google Таблицы',
      ${`Терминов: ${termId.size}, переводов: ${trCount}, заявок: ${reqCount}, записей журнала: ${logCount}`})`;
    note(`Записей журнала: ${logCount}.`);

    // ---- Счётчики: номера не переиспользуются
    const meta = tableRowsSafe(wb, 'Эталон — служебное');
    const metaTb = Number(meta.find((m) => s(m['Параметр']) === 'Следующий номер TB')?.['Значение']) || 0;
    const metaZ = Number(meta.find((m) => s(m['Параметр']) === 'Следующий ID заявки')?.['Значение']) || 0;
    await tx`select setval('tb_seq', ${Math.max(maxTb + 1, metaTb, 1)}, false)`;
    await tx`select setval('req_seq', ${Math.max(maxZ + 1, metaZ, 1)}, false)`;
    note(`Следующий номер TB: TB-${String(Math.max(maxTb + 1, metaTb, 1)).padStart(5, '0')}.`);
  });
  const text = [`Отчёт переноса ${new Date().toLocaleString('ru-RU')}`, `Файл: ${file}`, '', ...report, '',
    problems.length ? `Не удалось перенести или нужно проверить (${problems.length}):` : 'Ошибок нет: всё перенесено.', ...problems.map((p) => '• ' + p)].join('\n');
  return { text, report, problems };
}

async function main() {
  loadEnv();
  const file = process.argv[2];
  if (!file) fail('Укажите файл: npm run import -- "Глоссарий.xlsx"');
  if (!process.env.DATABASE_URL) fail('В .env.local нет DATABASE_URL.');
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const r = await runImport(sql, file, { force: process.argv.includes('--force') });
  await sql.end();
  writeFileSync('import-report.txt', r.text);
  console.log(`\n${r.problems.length ? `Замечаний: ${r.problems.length}.` : 'Ошибок нет.'} Отчёт: import-report.txt`);
}

// ---------- утилиты ----------
function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v && 'richText' in v) return (v as { richText: { text: string }[] }).richText.map((x) => x.text).join('').trim();
  if (typeof v === 'object' && v && 'text' in v) return String((v as { text: string }).text).trim();
  if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '').trim();
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
function d(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const t = s(v);
  if (!t) return null;
  const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const x = new Date(t);
  return isNaN(x.getTime()) ? null : x;
}
function labelEmail(label: string) {
  const m = label.match(/<([^>]+)>/);
  return (m ? m[1] : label).toLowerCase();
}
function rowValues(row: ExcelJS.Row): string[] {
  const out: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, n) => { out[n - 1] = s(cell.value); });
  return out;
}
function tableRows(ws: ExcelJS.Worksheet) {
  const head = rowValues(ws.getRow(1));
  const out: Record<string, unknown>[] = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const o: Record<string, unknown> = { _row: i };
    let any = false;
    head.forEach((h, j) => { if (!h) return; const v = row.getCell(j + 1).value; o[h] = v; if (s(v)) any = true; });
    if (any) out.push(o);
  }
  return out;
}
function tableRowsSafe(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.worksheets.find((w) => w.name.trim() === name);
  return ws ? tableRows(ws) : [];
}
function loadEnv() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
function fail(msg: string): never {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error('Перенос не выполнен, база не изменилась.\n', e); process.exit(1); });
}
