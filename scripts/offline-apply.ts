/**
 * Большие загрузки без долгих операций в живой базе.
 *
 * 1. Снимок Supabase (все таблицы) → встроенный PostgreSQL на этом компьютере (PGlite) со схемой и правилами из db/.
 * 2. Загрузка выполняется на копии — быстро, без сети.
 * 3. Сравнение копии со снимком: какие строки добавлены и изменены.
 * 4. С --apply изменения уходят в Supabase одной транзакцией из нескольких запросов. Перед этим проверяется,
 *    что с момента снимка в базе ничего не поменялось; если поменялось — ничего не пишется, нужно запустить снова.
 *
 * npx tsx scripts/offline-apply.ts "Глоссарий Loco EN.xlsx" "отчёт.md"            — пробный прогон
 * npx tsx scripts/offline-apply.ts "Глоссарий Loco EN.xlsx" "отчёт.md" --apply    — загрузить
 */
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runProjectSheets, type Db } from './project-sheets';

const [xlsx, reportFile] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!xlsx || !reportFile) { console.error('Нужно: файл.xlsx отчёт.md [--apply]'); process.exit(1); }
const env = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
if (!env) { console.error('В .env.local нет DATABASE_URL'); process.exit(1); }
const remote = postgres(env.slice(13).trim(), { prepare: false, max: 1 });

// таблица → ключ; порядок — с учётом ссылок
const TABLES: [string, string[]][] = [
  ['languages', ['code']], ['projects', ['id']], ['settings', ['key']], ['profiles', ['id']], ['terms', ['id']], ['retired_tb', ['tb']],
  ['term_projects', ['term_id', 'project_id']], ['term_langs', ['term_id', 'lang']], ['translations', ['id']],
  ['requests', ['id']], ['request_translations', ['request_id', 'lang']], ['request_answers', ['request_id', 'lang']],
  ['request_comments', ['id']], ['term_comments', ['id']], ['audit_log', ['id']], ['exports', ['id']]
];
const GENERATED = new Set(['ru_norm', 'text_norm']);
const SERIAL = ['projects', 'profiles', 'terms', 'translations', 'requests', 'request_comments', 'term_comments', 'audit_log', 'exports'];
type Row = Record<string, unknown>;

// ---------- 1. Снимок
console.log('Снимок базы…');
const snap: Record<string, Row[]> = {};
for (const [t] of TABLES) snap[t] = await remote.unsafe(`select * from ${t}`);
const seqs: Record<string, string> = {};
const [s0] = await remote`select (select last_value from tb_seq) tb, (select last_value from req_seq) rq`;
for (const t of SERIAL) { const [r] = await remote.unsafe(`select coalesce(max(id), 0)::text m from ${t}`); seqs[t] = r.m; }
const fingerprint = async (db: typeof remote) => {
  const [f] = await db`select (select count(*) from terms) a, (select coalesce(max(id),0) from terms) b, (select count(*) from translations) c,
    (select coalesce(max(id),0) from translations) d, (select count(*) from requests) e, (select coalesce(max(id),0) from requests) f,
    (select coalesce(sum(version),0) from terms) g, (select coalesce(sum(version),0) from requests) h, (select count(*) from term_projects) i,
    (select count(*) from term_langs) j, (select coalesce(max(id),0) from audit_log) k, (select count(*) from projects) l,
    (select last_value from tb_seq) m, (select last_value from req_seq) n`;
  return JSON.stringify(f);
};
const fp0 = await fingerprint(remote);
console.log(`  терминов ${snap.terms.length}, переводов ${snap.translations.length}, заявок ${snap.requests.length}`);

// ---------- 2. Копия
console.log('Копия у себя…');
const pg = await PGlite.create({ extensions: { pg_trgm } });
await pg.exec(`create role anon; create role authenticated; create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;`);
await pg.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await pg.exec(readFileSync(new URL('../db/functions.sql', import.meta.url), 'utf8'));
const colTypes = async (t: string) => (await pg.query<{ c: string; ty: string }>(
  `select attname c, format_type(atttypid, atttypmod) ty from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and attgenerated = ''`, [t])).rows;
const types: Record<string, { c: string; ty: string }[]> = {};
for (const [t] of TABLES) types[t] = await colTypes(t);
await pg.exec('delete from settings; delete from languages;');
await pg.exec('alter table audit_log disable trigger audit_log_no_update;');
for (const [t] of TABLES) {
  const rows = snap[t]; if (!rows.length) continue;
  const cols = types[t].map((x) => x.c);
  await pg.query(`insert into ${t} (${cols.join(',')}) select ${cols.join(',')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`,
    [JSON.stringify(t === 'translations' ? rows.map((r) => ({ ...r, replaced_by: null })) : rows)]);
}
await pg.query(`update translations x set replaced_by = s.replaced_by from jsonb_populate_recordset(null::translations, $1::jsonb) s where s.id = x.id and s.replaced_by is not null`,
  [JSON.stringify(snap.translations)]);
await pg.exec('alter table audit_log enable trigger audit_log_no_update;');
await pg.query(`select setval('tb_seq', $1::bigint)`, [s0.tb]); await pg.query(`select setval('req_seq', $1::bigint)`, [s0.rq]);
for (const t of SERIAL) await pg.query(`select setval(pg_get_serial_sequence('${t}', 'id'), greatest($1::bigint, 1))`, [seqs[t]]);

// ---------- 3. Загрузка на копии
console.log('Загрузка на копии…');
const tag: Db = async (strings, ...vals) => {
  let text = strings[0]; vals.forEach((_, i) => { text += `$${i + 1}` + strings[i + 1]; });
  return (await pg.query(text, vals as unknown[])).rows as never;
};
await pg.exec('begin');
const res = await runProjectSheets(tag, xlsx);
await pg.exec('commit');
console.log(res.perSheet.join('\n')); console.log(res.summary);

// ---------- 4. Разница
const key = (t: string, r: Row) => TABLES.find((x) => x[0] === t)![1].map((k) => String(r[k])).join('|');
const norm = (v: unknown): string => v == null ? 'null' : v instanceof Date ? v.toISOString()
  : typeof v === 'object' ? JSON.stringify(v) : String(v);   // числа из Supabase приходят строками, из копии — числами
const diff: Record<string, { ins: Row[]; upd: Row[] }> = {};
for (const [t] of TABLES) {
  const before = new Map(snap[t].map((r) => [key(t, r), r]));
  const after = (await pg.query<Row>(`select * from ${t}`)).rows;
  const cols = types[t].map((x) => x.c);
  const ins: Row[] = [], upd: Row[] = [];
  for (const r of after) {
    const b = before.get(key(t, r));
    if (!b) ins.push(r);
    else if (cols.some((c) => norm(b[c]) !== norm(r[c]))) { upd.push(r); if (process.env.SHOW_DIFF === t) console.log(t, key(t, r), cols.filter((c) => norm(b[c]) !== norm(r[c])).map((c) => `${c}: ${norm(b[c]).slice(0, 60)} → ${norm(r[c]).slice(0, 60)}`).join(' | ')); }
  }
  const removed = snap[t].length - after.length + ins.length;
  if (removed) throw new Error(`На копии из ${t} пропали строки (${removed}) — так быть не должно, остановлено.`);
  if (ins.length || upd.length) diff[t] = { ins, upd };
}
const [s1] = (await pg.query<{ tb: string; rq: string }>(`select (select last_value from tb_seq)::text tb, (select last_value from req_seq)::text rq`)).rows;
const changes = Object.entries(diff).map(([t, d]) => `${t}: +${d.ins.length}${d.upd.length ? `, изменено ${d.upd.length}` : ''}`).join('; ');
console.log('Изменения:', changes || 'нет');

writeFileSync(reportFile, [res.report, '', `## Технически: строки в базе`, `- ${changes || 'изменений нет'}`, '',
  apply ? '**Загружено в базу.**' : '**Пробный прогон — база не изменена.** Номера TB- и Z- станут такими же при загрузке, если до неё в базе ничего не поменяется.'].join('\n'));

// ---------- 5. Запись в Supabase
if (apply && Object.keys(diff).length) {
  console.log('Запись в Supabase…');
  await remote.begin(async (tx) => {
    await tx`lock table terms, translations, requests, term_projects, term_langs, request_translations, projects in share row exclusive mode`;
    if ((await fingerprint(tx as unknown as typeof remote)) !== fp0) throw new Error('С момента снимка в базе что-то изменилось (кто-то работал на сайте). Ничего не записано — запустите ещё раз.');
    for (const [t, pk] of TABLES) {
      const d = diff[t]; if (!d) continue;
      const cols = types[t].map((x) => x.c).filter((c) => !GENERATED.has(c));
      if (d.ins.length) {
        const rows = t === 'translations' ? d.ins.map((r) => ({ ...r, replaced_by: null })) : d.ins;
        await tx.unsafe(`insert into ${t} (${cols.join(',')}) select ${cols.join(',')} from jsonb_populate_recordset(null::${t}, $1::text::jsonb)`, [JSON.stringify(rows)] as never);
      }
      const updRows = [...d.upd, ...(t === 'translations' ? d.ins.filter((r) => r.replaced_by) : [])];
      if (updRows.length) {
        if (t === 'audit_log') throw new Error('Журнал менять нельзя — остановлено.');
        const setCols = cols.filter((c) => !pk.includes(c));
        await tx.unsafe(`update ${t} x set ${setCols.map((c) => `${c} = s.${c}`).join(', ')}
          from jsonb_populate_recordset(null::${t}, $1::text::jsonb) s where ${pk.map((k) => `x.${k} = s.${k}`).join(' and ')}`, [JSON.stringify(updRows)] as never);
      }
    }
    await tx`select setval('tb_seq', ${s1.tb}::bigint)`; await tx`select setval('req_seq', ${s1.rq}::bigint)`;
    for (const t of SERIAL) await tx.unsafe(`select setval(pg_get_serial_sequence('${t}', 'id'), greatest((select coalesce(max(id), 1) from ${t}), 1))`);
  });
  console.log('Готово: изменения в Supabase.');
}
await remote.end();
await pg.close();
