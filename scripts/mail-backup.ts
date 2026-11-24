/**
 * Отправить свежую копию базы владельцам на почту (файл .json.gz во вложении).
 *   npx tsx scripts/mail-backup.ts           — сначала сделайте копию: npm run backup
 * Нужны: DATABASE_URL, GMAIL_USER, GMAIL_APP_PASSWORD. В журнал пишется только число получателей.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import postgres from 'postgres';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { console.log('Почта не настроена (нет GMAIL_USER / GMAIL_APP_PASSWORD) — копию не отправляю.'); process.exit(0); }
const files = existsSync('backups') ? readdirSync('backups').filter((f) => f.endsWith('.json.gz')).map((f) => 'backups/' + f) : [];
if (!files.length) { console.error('Нет файла копии — сначала npm run backup'); process.exit(1); }
const file = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const owners = await sql<{ email: string }[]>`select email from profiles where active and role = 'owner'`;
const [c] = await sql<{ terms: number; tr: number }[]>`select (select count(*) from terms)::int terms, (select count(*) from translations where status <> 'obsolete')::int tr`;
await sql.end();

const { default: nodemailer } = await import('nodemailer');
const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
const day = new Date().toISOString().slice(0, 10);
await mail.sendMail({
  from: `Глоссарий <${process.env.GMAIL_USER}>`, to: owners.map((o) => o.email), subject: `Копия базы глоссария — ${day}`,
  text: `Привет! Во вложении — копия базы глоссария на ${day}.\nТерминов: ${c.terms}, переводов: ${c.tr}.\n\nФайл можно положить на WB Диск. Восстановление — scripts/backup.ts --restore (см. README).\nВ файле есть почты и имена людей — не пересылайте его наружу.`,
  attachments: [{ filename: `glossary-backup-${day}.json.gz`, path: file }]
});
console.log(`Копия отправлена владельцам: ${owners.length}.`);
