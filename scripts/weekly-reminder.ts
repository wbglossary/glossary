/**
 * Еженедельное напоминание переводчикам, валидаторам и менеджерам: письмо + уведомление в браузере.
 *   npx tsx scripts/weekly-reminder.ts --preview            — показать тексты этой недели (ничего не отправляет)
 *   npx tsx scripts/weekly-reminder.ts --only=почта@x.ru    — отправить только одному человеку (проверка)
 *   npx tsx scripts/weekly-reminder.ts --all                — всем (только если REMINDERS_ON=yes)
 * Нужны: DATABASE_URL; для писем GMAIL_USER и GMAIL_APP_PASSWORD; для браузера VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY.
 * В журнал GitHub пишутся только числа — без имён и почт.
 */
import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { ALL_CLEAR, pickReminder, REMINDERS } from './reminders';
import { VAPID_PUBLIC as SITE_VAPID_PUBLIC } from '../src/vapid';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const args = process.argv.slice(2);
const preview = args.includes('--preview');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).toLowerCase();
const all = args.includes('--all');
const SITE = process.env.SITE_URL || 'https://wbglossary.github.io/glossary/';
if (!preview && !only && !all) { console.error('Укажите --preview, --only=почта или --all'); process.exit(1); }
if (all && process.env.REMINDERS_ON !== 'yes') { console.log('Рассылка выключена (REMINDERS_ON не равно yes) — ничего не отправляю.'); process.exit(0); }

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
interface Person { id: number; email: string; name: string; role: string }
const people = await sql<Person[]>`select id, email, name, role from profiles
  where active and role in ('translator','validator','manager') order by id`;

/** Что ждёт человека — строками */
async function todo(p: Person): Promise<string[]> {
  const out: string[] = [];
  const langs = await sql<{ lang: string; role: string; kind: string }[]>`select pl.lang, pl.role, l.kind from profile_langs pl join languages l on l.code = pl.lang
    where pl.profile_id = ${p.id} and l.active order by pl.lang`;
  for (const l of langs) {
    const [c] = await sql<{ need: number; draft: number; req: number; review: number }[]>`select
      (select count(*) from terms t where t.status = 'active' and lang_status(t.id, ${l.lang}) = 'need')::int need,
      (select count(*) from terms t where t.status = 'active' and lang_status(t.id, ${l.lang}) = 'draft')::int draft,
      (select count(*) from requests r where r.status = 'pending' and r.type <> 'obsolete' and request_for_lang(r, ${l.lang}))::int req,
      (select count(*) from translations x join terms t on t.id = x.term_id where t.status = 'active' and x.lang = ${l.lang} and x.status = 'unchecked')::int review`;
    if (c.need && l.kind === 'full') out.push(`${l.lang}: нужен перевод — ${c.need}`);
    if (l.role === 'validator') {
      if (c.draft) out.push(`${l.lang}: черновики ждут твоего согласования — ${c.draft}`);
      if (c.req) out.push(`${l.lang}: заявки ждут решения — ${c.req}`);
      if (c.review) out.push(`${l.lang}: переводы «Без проверки» на пересмотр — ${c.review}`);
    } else if (c.draft) out.push(`${l.lang}: твои черновики ждут валидатора — ${c.draft}`);
  }
  if (p.role === 'manager') {
    const [m] = await sql<{ n: number }[]>`select count(*)::int n from requests where author_id = ${p.id} and status = 'pending'`;
    if (m.n) out.push(`Твои заявки ещё на рассмотрении — ${m.n}`);
  }
  return out;
}

const r = pickReminder();
const fill = (s: string, name: string) => s.replaceAll('{name}', name);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(p: Person, items: string[]) {
  const first = p.name.split(/\s+/)[0] || p.name;
  const list = items.length ? items : [ALL_CLEAR];
  const text = `${fill(r.intro, first)}\n\n${list.map((x) => '• ' + x).join('\n')}\n\n${fill(r.outro, first)}\n\n${SITE}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#17112b">
    <p>${esc(fill(r.intro, first))}</p>
    <ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p>${esc(fill(r.outro, first))}</p>
    <p><a href="${SITE}" style="display:inline-block;background:#3d0b6e;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none">Открыть глоссарий</a></p>
    <p style="color:#6a6383;font-size:12px">Это еженедельное напоминание глоссария. Уведомления в браузере можно выключить на Главной.</p></div>`;
  const push = { title: r.subject, body: items.length ? `${r.push}\n${items[0]}${items.length > 1 ? ` и ещё ${items.length - 1}` : ''}` : r.push, url: SITE };
  return { subject: r.subject, text, html, push };
}

if (preview) {
  console.log(`Тексты этой недели (№${REMINDERS.indexOf(r) + 1} из ${REMINDERS.length}):\n`);
  const sample = render({ id: 0, email: '', name: 'Имя', role: 'validator' }, ['UZ: нужен перевод — 12', 'UZ: черновики ждут твоего согласования — 3']);
  console.log('Тема:', sample.subject, '\n\n' + sample.text, '\n\nВ браузере:', sample.push.title, '—', sample.push.body);
  await sql.end(); process.exit(0);
}

// Проверка на одном человеке — любая роль, хоть владелец: письмо придёт, даже если у него нет задач
const targets = only
  ? await sql<Person[]>`select id, email, name, role from profiles where active and lower(email) = ${only}`
  : people;
if (!targets.length) {
  console.log(only
    ? 'В глоссарии нет включённого пользователя с такой почтой. Проверьте, что почта вписана так же, как в «Администрировании».'
    : 'Некому отправлять: нет переводчиков, валидаторов и менеджеров.');
  await sql.end(); process.exit(1);
}
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) console.log('Почта не настроена: нет секретов GMAIL_USER и GMAIL_APP_PASSWORD — письмо не уйдёт.');
if (!process.env.VAPID_PRIVATE_KEY) console.log('Уведомления в браузере не настроены: нет секрета VAPID_PRIVATE_KEY.');

const { default: nodemailer } = await import('nodemailer');
const mail = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } }) : null;
const { default: webpush } = await import('web-push');
// Публичный ключ не секретный — он же зашит в сайт (src/push.tsx); берём его оттуда, чтобы не зависеть от копирования.
// Секретом остаётся только приватный ключ. Лишние пробелы, кавычки и переносы строк срезаем.
const clean = (v?: string) => (v ?? '').trim().replace(/^["']|["']$/g, '').replace(/^VAPID_(PUBLIC|PRIVATE)_KEY=/, '').trim();
const VAPID_PUBLIC = SITE_VAPID_PUBLIC || clean(process.env.VAPID_PUBLIC_KEY);
let pushOn = !!(VAPID_PUBLIC && clean(process.env.VAPID_PRIVATE_KEY));
if (pushOn) {
  try { webpush.setVapidDetails('mailto:' + (process.env.GMAIL_USER || 'glossary@example.com'), VAPID_PUBLIC, clean(process.env.VAPID_PRIVATE_KEY)); }
  catch (e) {
    pushOn = false;
    console.log('Уведомления в браузере пропущены: ключ VAPID_PRIVATE_KEY в секретах GitHub записан неверно (' + (e as Error).message + '). Письма всё равно уйдут.');
  }
}

let sent = 0, pushed = 0, failed = 0, gone = 0;
for (const p of targets) {
  const m = render(p, await todo(p));
  if (mail) {
    try { await mail.sendMail({ from: `Глоссарий <${process.env.GMAIL_USER}>`, to: p.email, subject: m.subject, text: m.text, html: m.html }); sent++; }
    catch { failed++; }
  }
  if (pushOn) {
    const subs = await sql<{ endpoint: string; p256dh: string; auth: string }[]>`select endpoint, p256dh, auth from push_subs where profile_id = ${p.id}`;
    for (const s of subs) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(m.push)); pushed++; }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { await sql`delete from push_subs where endpoint = ${s.endpoint}`; gone++; } else failed++;
      }
    }
  }
}
console.log(`Напоминание №${REMINDERS.indexOf(r) + 1}: людей ${targets.length}, писем ${sent}${mail ? '' : ' (почта не настроена)'}, уведомлений ${pushed}${pushOn ? '' : ' (браузер не настроен)'}, ошибок ${failed}, устаревших подписок убрано ${gone}.`);
if (only && !sent && !pushed) { console.log(failed ? 'Ничего не отправлено: ошибка при отправке. Чаще всего неверный пароль приложения Gmail.' : 'Ничего не отправлено — см. сообщения выше.'); await sql.end(); process.exit(1); }
await sql.end();
