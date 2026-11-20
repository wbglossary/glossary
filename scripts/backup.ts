/**
 * Резервная копия всех таблиц в один файл backups/backup-ГГГГ-ММ-ДД.json.gz.
 * Каждую ночь запускается GitHub Actions (.github/workflows/backup.yml), файл хранится 30 дней.
 * Заодно «будит» бесплатный Supabase, чтобы он не уснул.
 *
 * Восстановление: npm run backup -- --restore backups/backup-2026-11-20.json.gz  (только в пустую базу)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import postgres from 'postgres';

const TABLES = ['languages', 'projects', 'settings', 'profiles', 'terms', 'retired_tb', 'term_projects', 'term_langs', 'translations',
  'requests', 'request_translations', 'request_answers', 'request_comments', 'term_comments', 'audit_log', 'exports', 'feedback'];
const JSONB = ['forbidden', 'draft', 'lang_fields', 'prefs']; // столбцы jsonb
const SERIAL = ['projects', 'profiles', 'terms', 'translations', 'requests', 'request_comments', 'term_comments', 'audit_log', 'exports', 'feedback'];

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const url = process.env.DATABASE_URL;
if (!url) { console.error('Нет DATABASE_URL'); process.exit(1); }
const sql = postgres(url, { prepare: false, max: 1 });

async function backup() {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  for (const t of TABLES) out[t] = await sql.unsafe(`select * from ${t} order by 1`);
  const seq = await sql`select (select last_value from tb_seq) as tb, (select last_value from req_seq) as req`;
  out.sequences = seq[0];
  mkdirSync('backups', { recursive: true });
  const name = `backups/backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
  writeFileSync(name, gzipSync(JSON.stringify(out)));
  console.log(`Копия готова: ${name}. Терминов: ${(out.terms as unknown[]).length}.`);
}

async function restore(file: string) {
  const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  const [{ n }] = await sql`select count(*)::int as n from terms`;
  if (n > 0) { console.error('Восстановление делается в пустую базу (сначала примените db/schema.sql и db/functions.sql к новой базе).'); process.exit(1); }
  await sql.begin(async (tx) => {
    await tx`delete from settings`;
    await tx`delete from languages`;
    for (const t of TABLES) {
      const rows = data[t] as Record<string, unknown>[];
      if (!rows?.length) continue;
      const cols = Object.keys(rows[0]).filter((c) => !['ru_norm', 'text_norm'].includes(c)); // вычисляемые столбцы
      for (const r of rows) {
        // ссылку «заменён на» ставим после вставки всех переводов
        await tx.unsafe(`insert into ${t} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
          cols.map((c) => { const v = t === 'translations' && c === 'replaced_by' ? null : r[c]; return (JSONB.includes(c) && v !== null ? JSON.stringify(v) : v) as never; }));
      }
      if (t === 'translations') {
        for (const r of rows) if (r.replaced_by) await tx`update translations set replaced_by = ${r.replaced_by as number} where id = ${r.id as number}`;
      }
      if (SERIAL.includes(t)) {
        await tx.unsafe(`select setval(pg_get_serial_sequence('${t}', 'id'), (select coalesce(max(id), 1) from ${t}))`);
      }
    }
    // вход привяжется заново по почте (в новом проекте Supabase идентификаторы входа другие)
    await tx`update profiles set user_id = null`;
    await tx`select setval('tb_seq', ${Number(data.sequences.tb)})`;
    await tx`select setval('req_seq', ${Number(data.sequences.req)})`;
  });
  console.log(`Восстановлено из ${file} (копия от ${data.at}).`);
}

const i = process.argv.indexOf('--restore');
(i > 0 ? restore(process.argv[i + 1]) : backup())
  .then(() => sql.end())
  .catch((e) => { console.error(e); process.exit(1); });
