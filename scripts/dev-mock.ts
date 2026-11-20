/**
 * Локальная подмена Supabase для проверки сайта без интернета.
 * Встроенный PostgreSQL (PGlite) + те же db/schema.sql и db/functions.sql + простой HTTP,
 * который понимает вызовы supabase.rpc и выдаёт тестовые входы.
 *
 * npx tsx scripts/dev-mock.ts "путь/к/Глоссарий.xlsx"   → http://localhost:54321
 * Вход под тестовым пользователем: открыть сайт с ?as=ven (owner, man, ven, en, vka, ka, con, reader).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runImport } from './import-from-sheets';

const PORT = 54321;
const pg = await PGlite.create({ extensions: { pg_trgm } });
await pg.exec(`create role anon; create role authenticated; create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;`);
await pg.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await pg.exec(readFileSync(new URL('../db/functions.sql', import.meta.url), 'utf8'));

// postgres.js-подобная обёртка, чтобы прогнать настоящий скрипт переноса
type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
function tag(q: Q) {
  const f = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    let text = strings[0];
    vals.forEach((_, i) => { text += `$${i + 1}` + strings[i + 1]; });
    return (await q.query(text, vals)).rows;
  };
  return f;
}
const sqlLike = Object.assign(tag(pg as unknown as Q), {
  begin: (fn: (tx: unknown) => Promise<unknown>) => pg.transaction(async (t) => fn(tag(t as unknown as Q)))
});

const file = process.argv[2];
if (file) {
  const r = await runImport(sqlLike, file, { quiet: true });
  console.log(r.report.join('\n'));
  console.log(`Замечаний переноса: ${r.problems.length}`);
} else {
  await pg.query(`insert into languages(code, name, smartcat_code, kind, sort) values ('EN','английский','en-US','full',1),('KA','грузинский','ka','full',2),('AM','амхарский','am','short',3)`);
}
await pg.query(`insert into projects(name) values ('ПВЗ'),('такси') on conflict do nothing`);
// тестовые валидаторы заменяют перенесённых (у языка один валидатор)
await pg.query(`update profiles set active = false where role = 'validator' and lang in ('EN','KA','UZ')`);

const USERS: Record<string, { email: string; name: string; role: string; lang: string | null; uid: string }> = {};
const TEST: [string, string, string, string | null][] = [
  ['owner', 'Владелец Тест', 'owner', null], ['man', 'Менеджер Тест', 'manager', null],
  ['ven', 'Валидатор EN', 'validator', 'EN'], ['en', 'Переводчик EN', 'translator', 'EN'],
  ['vka', 'Валидатор KA', 'validator', 'KA'], ['ka', 'Переводчик KA', 'translator', 'KA'],
  ['con', 'Подрядчик Тест', 'contractor', null], ['reader', 'Читатель Тест', 'reader', null],
  ['mix', 'Валидатор UZ, переводчик KY', 'validator', 'UZ']
];
for (const [key, name, role, lang] of TEST) {
  if (lang && !(await pg.query(`select 1 from languages where code = $1`, [lang])).rows.length) continue;   // языка нет в этой копии
  const email = `${key}@test.local`;
  await pg.query(`insert into profiles(email, name, role, lang, contractor_no)
    values ($1,$2,$3,$4, case when $3 = 'contractor' then (select coalesce(max(contractor_no), 0) + 1 from profiles) end)
    on conflict (email) do nothing`, [email, name, role, lang]);
  const uid = randomUUID();
  await pg.query(`insert into auth.users(id, email) values ($1,$2)`, [uid, email]);
  USERS[key] = { email, name, role, lang, uid };
}
// второй язык со своей ролью у тестового «mix» (если в базе есть KY)
await pg.query(`insert into profile_langs(profile_id, lang, role) select id, 'KY', 'translator' from profiles where email = 'mix@test.local' and exists (select 1 from languages where code = 'KY') on conflict do nothing`).catch(() => null);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (key: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USERS[key].uid, email: USERS[key].email, role: 'authenticated', exp: 4102444800 })}.sig`;
const uidFrom = (auth?: string) => {
  try { return JSON.parse(Buffer.from((auth ?? '').replace('Bearer ', '').split('.')[1], 'base64url').toString()).sub as string; } catch { return ''; }
};

const argTypes = new Map<string, { names: string[]; types: string[] }>();
async function callRpc(fn: string, args: Record<string, unknown>, uid: string) {
  if (!argTypes.has(fn)) {
    const [p] = (await pg.query<{ names: string[] | null; types: string[] }>(
      `select proargnames as names, array(select format_type(t, null) from unnest(proargtypes) t) as types from pg_proc where proname = $1 limit 1`, [fn])).rows;
    if (!p) throw Object.assign(new Error(`Нет функции ${fn}`), { code: 'PGRST202' });
    argTypes.set(fn, { names: p.names ?? [], types: p.types });
  }
  const meta = argTypes.get(fn)!;
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(args)) {
    const i = meta.names.indexOf(k);
    if (i < 0) throw Object.assign(new Error(`Неизвестный параметр ${k}`), { code: 'PGRST202' });
    const type = meta.types[i];
    let val: unknown = v;
    if (v === null || v === undefined) val = null;
    else if (type === 'jsonb' || type === 'json') val = JSON.stringify(v);
    else if (type.endsWith('[]')) val = '{' + (v as unknown[]).map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(',') + '}';
    else if (type === 'boolean' || type === 'integer') val = v;
    else val = String(v);
    params.push(val);
    parts.push(`${k} := $${params.length}::${type}`);
  }
  return pg.transaction(async (t) => {
    await t.query(`select set_config('app.uid', $1, true)`, [uid]);
    const [r] = (await t.query<{ r: unknown }>(`select ${fn}(${parts.join(', ')}) as r`, params)).rows;
    return r?.r ?? null;
  });
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const body = await new Promise<string>((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d)); });
  const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.slice('/rest/v1/rpc/'.length);
      const t0 = Date.now();
      const r = await callRpc(fn, body ? JSON.parse(body) : {}, uidFrom(req.headers.authorization));
      console.log(`rpc ${fn} ${Date.now() - t0}ms`);
      return send(200, r);
    }
    if (url.pathname === '/auth/v1/user') {
      const uid = uidFrom(req.headers.authorization);
      const u = Object.values(USERS).find((x) => x.uid === uid);
      return u ? send(200, { id: u.uid, email: u.email, aud: 'authenticated', role: 'authenticated' }) : send(401, { message: 'no user' });
    }
    if (url.pathname === '/auth/v1/logout') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/dev/session') {
      const key = url.searchParams.get('as') ?? 'owner';
      const u = USERS[key];
      if (!u) return send(404, { message: 'нет такого тестового пользователя' });
      return send(200, { access_token: token(key), refresh_token: 'r-' + key, token_type: 'bearer', expires_in: 3600 * 24 * 365,
        expires_at: 4102444800, user: { id: u.uid, email: u.email, aud: 'authenticated', role: 'authenticated' } });
    }
    send(404, { message: 'not found' });
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code !== 'P0001') console.error(url.pathname, err.message);
    send(400, { code: err.code ?? 'XX000', message: err.message, details: null, hint: null });
  }
}).listen(PORT, () => console.log(`Подмена Supabase: http://localhost:${PORT}  (тестовые входы: ${Object.keys(USERS).join(', ')})`));
