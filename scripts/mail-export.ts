/**
 * Таблицы глоссария на почту (например, Outlook): общая выгрузка и отдельно по каждому проекту,
 * в двух видах — «для просмотра» (все языки со статусами) и «для Smartcat».
 *   npx tsx scripts/mail-export.ts            — собрать и отправить на EXPORT_TO
 *   npx tsx scripts/mail-export.ts --dry      — только собрать файлы в папку exports/ (ничего не отправляет)
 * Нужны: DATABASE_URL; для отправки — GMAIL_USER, GMAIL_APP_PASSWORD и EXPORT_TO (одна или несколько почт через запятую).
 * Адрес получателя хранится только в секрете GitHub EXPORT_TO — в коде его нет. В журнал пишутся только числа.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { buildViewXlsx, buildXlsx, type ExportData, type ViewData } from '../src/exportFile';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const dry = process.argv.includes('--dry');
const to = (process.env.EXPORT_TO ?? '').split(/[,;\s]+/).filter(Boolean);
if (!dry) {
  if (!to.length) { console.log('Не указан EXPORT_TO (куда слать таблицы) — ничего не отправляю.'); process.exit(0); }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { console.log('Почта не настроена (нет GMAIL_USER / GMAIL_APP_PASSWORD) — ничего не отправляю.'); process.exit(0); }
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
// Выгрузка собирается теми же функциями базы, что и кнопки на сайте, — от имени владельца.
const [owner] = await sql<{ user_id: string }[]>`select user_id::text from profiles where active and role = 'owner' and user_id is not null order by id limit 1`;
if (!owner) { console.error('Нет владельца, который хотя бы раз входил на сайт, — не от чьего имени собрать выгрузку.'); await sql.end(); process.exit(1); }
const projects = await sql<{ id: number; name: string; closed: boolean }[]>`select id, name, closed from projects order by closed, name`;
const langs = (await sql<{ code: string }[]>`select code from languages where active and kind = 'full' order by sort, code`).map((l) => l.code);

async function asOwner<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    const claims = JSON.stringify({ sub: owner.user_id, role: 'authenticated' });
    await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${owner.user_id}, true), set_config('app.uid', ${owner.user_id}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
const view = (p: number | null) => asOwner(async (tx) => (await tx<{ d: ViewData }[]>`select export_view(${p}::int) d`)[0].d);
const smartcat = (p: number | null) => asOwner(async (tx) => (await tx<{ d: ExportData }[]>`select export_data(${langs}::text[], ${p}::int) d`)[0].d);

const day = new Date().toISOString().slice(0, 10);
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim();
const files: { filename: string; content: Buffer }[] = [];
const lines: string[] = [];
const buf = async (b: Blob) => Buffer.from(await b.arrayBuffer());

for (const p of [{ id: null as number | null, name: 'Все проекты', closed: false }, ...projects]) {
  const v = await view(p.id);
  const s = await smartcat(p.id);
  const title = p.id === null ? 'Все проекты' : `Проект ${safe(p.name)}${p.closed ? ' (закрыт)' : ''}`;
  if (!v.terms.length) { lines.push(`${title}: терминов нет — файлов нет`); continue; }
  files.push({ filename: `${day} — ${title} — просмотр.xlsx`, content: await buf(await buildViewXlsx(v)) });
  if (s.terms.length) files.push({ filename: `${day} — ${title} — Smartcat.xlsx`, content: await buf(await buildXlsx(s)) });
  lines.push(`${title}: терминов ${v.terms.length}, для Smartcat ${s.terms.length}`);
}
await sql.end();

if (dry) {
  mkdirSync('exports', { recursive: true });
  for (const f of files) writeFileSync(`exports/${f.filename}`, f.content);
  console.log(`Собрано файлов: ${files.length} (папка exports/).\n` + lines.join('\n'));
  process.exit(0);
}

const { default: nodemailer } = await import('nodemailer');
const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
await mail.sendMail({
  from: `Глоссарий <${process.env.GMAIL_USER}>`, to, subject: `Выгрузка глоссария — ${day}`,
  text: `Привет! Во вложении — свежая выгрузка глоссария на ${day}.\n\n${lines.map((l) => '• ' + l).join('\n')}\n\n`
    + `«просмотр» — все языки со статусами, пустые ячейки красные.\n«Smartcat» — согласованные переводы полных языков (${langs.join(', ')}), можно сразу загружать в Smartcat.\n\nhttps://wbglossary.github.io/glossary/`,
  attachments: files
});
console.log(`Выгрузка отправлена: получателей ${to.length}, файлов ${files.length}.`);
