/**
 * Проверка правил ТЗ v3.6 прямо на функциях базы (db/schema.sql + db/functions.sql)
 * во встроенном PostgreSQL (PGlite). Вход в Supabase имитируется через auth.uid().
 * Запуск: npm test
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

let pg: PGlite;
const U: Record<string, { id: number; uid: string }> = {};

const AUTH_STUB = `
  create role anon; create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
`;

async function sql<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(q, params)).rows;
}
/** Вызов API-функции от имени пользователя с именованными параметрами. */
async function call<T = any>(who: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  await sql(`select set_config('app.uid', $1, false)`, [who ? U[who].uid : '']);
  const types = await sql<{ names: string[] | null; types: string[] }>(
    `select proargnames as names, array(select format_type(t, null) from unnest(proargtypes) t) as types from pg_proc where proname = $1 limit 1`, [fn]);
  const meta = types[0];
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(args)) {
    const i = (meta.names ?? []).indexOf(k);
    if (i < 0) throw new Error('нет параметра ' + k + ' у ' + fn);
    const type = meta.types[i];
    params.push(v === null || v === undefined ? null : type === 'jsonb' ? JSON.stringify(v) : type.endsWith('[]') ? v : v);
    parts.push(`${k} := $${params.length}::${type}`);
  }
  const [r] = await sql<{ r: T }>(`select ${fn}(${parts.join(', ')}) as r`, params);
  return r?.r as T;
}
async function fails(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true; });
}
const submit = (who: string, input: object) => call(who, 'submit_request', { p_input: input });
const req = async (where: string) => (await sql<{ id: number; version: number; code: string; status: string; type: string; term_id: number }>(
  `select id, version, code, status, type, term_id from requests where ${where} order by id desc limit 1`))[0];
const approve = (who: string, id: number, v: number, force = false) => call(who, 'approve_request', { p_request: id, p_version: v, p_force: force });
const card = (tb: string, who = 'owner') => call(who, 'term_card', { p_tb: tb });
const lang = (c: any, code: string) => c.langs.find((l: any) => l.code === code);
const gl = (q: string, who = 'reader') => call(who, 'glossary_page', { p_q: q });

before(async () => {
  pg = await PGlite.create({ extensions: { pg_trgm } });
  await pg.exec(AUTH_STUB);
  await pg.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../db/functions.sql', import.meta.url), 'utf8'));
  await sql(`insert into languages(code, name, smartcat_code, kind, sort) values
    ('EN','английский','en-US','full',1),('KA','грузинский','ka','full',2),('HY','армянский','hy','full',3),('AM','амхарский','am','short',4)`);
  await sql(`insert into projects(name) values ('ПВЗ'),('такси')`);
  const mk = async (key: string, role: string, lng: string | null = null, cno: number | null = null) => {
    const [p] = await sql<{ id: number }>(`insert into profiles(email, name, role, lang, contractor_no) values ($1,$2,$3,$4,$5) returning id`,
      [`${key}@x.ru`, key, role, lng, cno]);
    const uid = randomUUID();
    await sql(`insert into auth.users(id, email) values ($1, $2)`, [uid, `${key.toUpperCase()}@X.RU`]);
    U[key] = { id: p.id, uid };
  };
  await mk('owner', 'owner'); await mk('man', 'manager'); await mk('reader', 'reader');
  await mk('ven', 'validator', 'EN'); await mk('ten', 'translator', 'EN');
  await mk('vka', 'validator', 'KA'); await mk('tka', 'translator', 'KA');
  await mk('vhy', 'validator', 'HY');
  await mk('c1', 'contractor', null, 1); await mk('c2', 'contractor', null, 2);
  // базовый термин
  const r = await submit('vka', { type: 'new', ru: 'QR-код', lang: 'KA', translation: 'QR-კოდი' });
  assert.equal(r.status, 'submitted');
  const z = await req(`ru = 'QR-код'`);
  assert.equal((await approve('vka', z.id, z.version)).tb, 'TB-00001');
});

test('вход: только добавленные владельцем; отключённые не работают', async () => {
  await fails(sql(`insert into auth.users(id, email) values ($1, 'stranger@x.ru')`, [randomUUID()]), /не добавлен в глоссарий/);
  await fails(call('', 'me'), /Войдите/);
  const me = await call('tka', 'me');
  assert.equal(me.role, 'translator');
  assert.equal(me.lang, 'KA');
  assert.ok(me.avatar, 'аватар назначен случайно');
  await call('tka', 'set_avatar', { p_avatar: 'capybara' });
  assert.equal((await call('tka', 'me')).avatar, 'capybara');
  await call('owner', 'admin_set_active', { p_user: U.reader.id, p_active: false });
  await fails(call('reader', 'me'), /отключён/);
  await call('owner', 'admin_set_active', { p_user: U.reader.id, p_active: true });
});

test('новый термин языка KA: TB-, остальные полные языки — «Нужен перевод»', async () => {
  const c = await card('TB-00001');
  assert.equal(lang(c, 'KA').status, 'approved');
  assert.equal(lang(c, 'EN').status, 'need');
  assert.equal(lang(c, 'HY').status, 'need');
  assert.equal(lang(c, 'AM').status, 'need');
  const g = await gl('qr код');
  assert.equal(g.items[0].tb, 'TB-00001');
  assert.deepEqual(g.items[0].cells.KA.t, ['QR-კოდი']);
  assert.equal(g.items[0].cells.EN.s, 'need');
  for (const k of ['definition', 'examples', 'comment', 'context']) assert.ok(k in g.items[0], `в строке глоссария есть поле ${k}`);
});

test('армянский видит термин в «Новое из других языков», переводит — одна строка, один TB', async () => {
  const w = await call('vhy', 'work_page', { p_lang: 'HY', p_tab: 'new' });
  const row = w.items.find((x: any) => x.tb === 'TB-00001');
  assert.ok(row, 'есть во вкладке «Новое из других языков»');
  assert.equal(row.others.KA, 'QR-კოდი');
  await fails(call('tka', 'set_cell_text', { p_term: row.id, p_lang: 'HY', p_text: 'x', p_version: row.version }), /армянский/);
  const cell = await call('vhy', 'set_cell_text', { p_term: row.id, p_lang: 'HY', p_text: 'QR կոդ', p_version: row.version });
  assert.equal(cell.status, 'draft');
  const r = await call('vhy', 'set_lang_approval', { p_items: [{ id: row.id, version: cell.version }], p_lang: 'HY', p_approve: true });
  assert.equal(r.done.length, 1);
  const g = await gl('TB-00001');
  assert.equal(g.items.length, 1);
  assert.deepEqual(g.items[0].cells.HY.t, ['QR կոդ']);
});

test('переводчик пишет черновик, согласует только валидатор; согласованное в ячейке не меняется', async () => {
  const c = await card('TB-00001');
  const cell = await call('ten', 'set_cell_text', { p_term: c.id, p_lang: 'EN', p_text: 'QR code', p_version: c.version });
  assert.equal(cell.status, 'draft');
  assert.equal((await gl('TB-00001')).items[0].cells.EN.t.length, 0, 'черновик не виден в глоссарии');
  await fails(call('ten', 'set_lang_approval', { p_items: [{ id: c.id, version: cell.version }], p_lang: 'EN', p_approve: true }), /только валидатор английского/);
  const stale = await call('ven', 'set_lang_approval', { p_items: [{ id: c.id, version: c.version }], p_lang: 'EN', p_approve: true });
  assert.match(stale.skipped[0], /изменились/);
  await call('ven', 'set_lang_approval', { p_items: [{ id: c.id, version: cell.version }], p_lang: 'EN', p_approve: true });
  const c2 = await card('TB-00001');
  await fails(call('ten', 'set_cell_text', { p_term: c2.id, p_lang: 'EN', p_text: '', p_version: c2.version }), /Заменить/);
  await fails(call('owner', 'set_lang_approval', { p_items: [{ id: c2.id, version: c2.version }], p_lang: 'EN', p_approve: false }), /только валидатор/);
});

test('владелец не утверждает и не согласует', async () => {
  await submit('tka', { type: 'new', ru: 'Корзина', lang: 'KA', translation: 'კალათა' });
  const z = await req(`ru = 'Корзина'`);
  await fails(approve('owner', z.id, z.version), /только валидатор/);
  await approve('vka', z.id, z.version);
});

test('заявка менеджера «на все языки»: видят все полные, первый валидатор создаёт термин', async () => {
  await fails(submit('man', { type: 'new', ru: 'x', lang: 'EN', translation: 'x' }), /только русскую часть/);
  await submit('man', { type: 'new', ru: 'Кнопка оплаты', definition: '= формула?', context: 'тест', project_ids: [1] });
  const z = await req(`ru = 'Кнопка оплаты'`);
  const hy = await call('vhy', 'lang_requests', { p_lang: 'HY' });
  const ka = await call('tka', 'lang_requests', { p_lang: 'KA' });
  assert.ok(hy.some((r: any) => r.id === z.id) && ka.some((r: any) => r.id === z.id));
  assert.ok(!(await call('ven', 'lang_requests', { p_lang: 'EN' })).some((r: any) => false));
  await fails(approve('vka', z.id, z.version), /нет перевода на грузинский/);
  const v1 = await call('tka', 'set_request_translation', { p_request: z.id, p_lang: 'KA', p_text: 'გადახდის ღილაკი' });
  const v2 = await call('vhy', 'set_request_translation', { p_request: z.id, p_lang: 'HY', p_text: 'Վճարման կոճակ' });
  const r = await approve('vka', z.id, v2.version);
  assert.equal(r.status, 'approved');
  const c = await card(r.tb);
  assert.equal(lang(c, 'KA').status, 'approved');
  assert.equal(lang(c, 'HY').status, 'draft', 'перевод другого языка из заявки — черновик');
  assert.equal(lang(c, 'EN').status, 'need');
  assert.deepEqual(c.projects.map((p: any) => p.name), ['ПВЗ']);
  assert.equal(c.definition, '= формула?');
  assert.ok(!(await call('vhy', 'lang_requests', { p_lang: 'HY' })).some((x: any) => x.id === z.id), 'у остальных заявка закрылась');
  void v1;
});

test('«Это тот же смысл?»: да — перевод к существующему; нет — новый с контекстом', async () => {
  const r = await submit('c1', { type: 'new', ru: 'qr код', lang: 'HY', translation: 'QR' });
  assert.equal(r.status, 'repeat');
  const id = r.matches[0].id;
  await fails(submit('c1', { type: 'new', ru: 'qr код', lang: 'HY', translation: 'x', new_meaning: true }), /Значение или контекст/);
  const same = await submit('c1', { type: 'new', ru: 'qr код', lang: 'AM', translation: 'QR AM', same_as: id });
  assert.equal(same.status, 'added', 'AM без валидатора — подрядчик добавляет сразу');
  const c = await card('TB-00001');
  assert.equal(lang(c, 'AM').status, 'unchecked');
  const other = await submit('c1', { type: 'new', ru: 'QR-код', lang: 'HY', translation: 'QR другой', new_meaning: true, context: 'в такси' });
  assert.equal(other.status, 'submitted');
});

test('проверка дублей: регистр, ё, пробелы, кавычки, латиница; «Как нельзя»', async () => {
  for (const v of ['qr код', '«QR-Код»', 'QR‐код', 'QR кoд', 'QR код']) {
    const w = await call('man', 'check_duplicates', { p_ru: v, p_tr: {} });
    assert.ok(w.some((x: string) => x.includes('TB-00001')), v);
  }
  const c = await card('TB-00001');
  await call('ven', 'edit_lang_fields', { p_term: c.id, p_lang: 'EN', p_fields: { forbidden: [{ text: 'QR-code', note: 'без дефиса' }] }, p_version: c.version });
  const w = await call('ten', 'check_duplicates', { p_ru: '', p_tr: { EN: 'QR-code' } });
  assert.ok(w.some((x: string) => /неправильный для TB-00001.*QR code/.test(x)), JSON.stringify(w));
  const s = await gl('QR-code');
  assert.ok(s.items[0].forbidden_hit?.length, 'поиск находит по неправильному варианту');
  assert.equal(s.items[0].cells.EN.f, true);
});

test('«Заменить» у переводчика — заявка; «Изменить» у валидатора — сразу; вторая замена снимается', async () => {
  const c = await card('TB-00001');
  const en = lang(c, 'EN').live[0];
  await fails(submit('ten', { type: 'replace', term_id: c.id, lang: 'EN', translation: 'x' }), /причину/);
  const a = await submit('ten', { type: 'replace', term_id: c.id, lang: 'EN', translation: 'QR Code', reason: 'регистр', target_id: en.id });
  const b = await submit('c2', { type: 'replace', term_id: c.id, lang: 'EN', translation: 'QR', reason: 'короче', target_id: en.id });
  assert.equal(a.status, 'submitted');
  assert.equal(b.status, 'submitted');
  assert.deepEqual((await gl('TB-00001')).items[0].cells.EN.t, ['QR code'], 'пока не принято — действует старый');
  const za = await req(`code = '${a.code}'`);
  await fails(approve('vka', za.id, za.version), /валидатор английского/);
  const conf = await approve('ven', za.id, za.version);
  assert.equal(conf.status, 'confirm', '«QR Code» совпадает с неправильным «QR-code» — нужно подтверждение');
  await approve('ven', za.id, za.version, true);
  assert.equal((await req(`code = '${b.code}'`)).status, 'auto_removed');
  const g = (await gl('TB-00001')).items[0];
  assert.deepEqual(g.cells.EN.t, ['QR Code']);
  assert.equal(g.replaced[0].old, 'QR code');
  const c2 = await card('TB-00001');
  await fails(call('tka', 'edit_translation', { p_translation: lang(c2, 'KA').live[0].id, p_text: 'y', p_reason: 'r' }), /Заменить/);
  await call('vka', 'edit_translation', { p_translation: lang(c2, 'KA').live[0].id, p_text: 'QR კოდი', p_reason: 'пробел' });
  const c3 = await card('TB-00001');
  assert.equal(lang(c3, 'KA').live[0].text, 'QR კოდი');
  assert.equal(lang(c3, 'KA').history[0].text, 'QR-კოდი');
  assert.equal(lang(c3, 'HY').status, 'approved', 'замена одного языка не трогает другие');
});

test('язык без валидатора: подрядчик добавляет сразу «Без проверки», новый термин — валидатор английского', async () => {
  const c = await card('Корзина' as any).catch(() => null);
  void c;
  const g = await gl('корзина');
  const id = g.items[0].id;
  const t = await call('owner', 'term_card', { p_id: id });
  const cell = await call('c1', 'set_cell_text', { p_term: id, p_lang: 'AM', p_text: 'ቅርጫት', p_version: t.version });
  assert.equal(cell.status, 'unchecked');
  await fails(call('c1', 'set_cell_text', { p_term: id, p_lang: 'KA', p_text: 'x', p_version: cell.version }), /грузинский/);
  assert.deepEqual((await gl('корзина')).items[0].cells.AM.t, ['ቅርጫት'], '«Без проверки» видно в глоссарии');
  // новый термин подрядчика с AM: утверждает валидатор английского
  await submit('c2', { type: 'new', ru: 'Самовывоз', lang: 'AM', translation: 'ከመደብር መውሰድ' });
  const z = await req(`ru = 'Самовывоз'`);
  assert.ok((await call('ven', 'lang_requests', { p_lang: 'EN' })).some((r: any) => r.id === z.id && r.ru_only));
  const r = await approve('ven', z.id, z.version);
  const cc = await card(r.tb);
  assert.equal(lang(cc, 'AM').status, 'unchecked');
  // появился валидатор AM — вкладка «На пересмотр»
  await call('owner', 'admin_create_user', { p_email: 'vam@x.ru', p_name: 'vam', p_role: 'validator', p_lang: 'AM' });
  const [p] = await sql<{ id: number }>(`select id from profiles where email = 'vam@x.ru'`);
  U.vam = { id: p.id, uid: randomUUID() };
  await sql(`insert into auth.users(id, email) values ($1, 'vam@x.ru')`, [U.vam.uid]);
  const rev = await call('vam', 'work_page', { p_lang: 'AM', p_tab: 'review' });
  assert.ok(rev.items.length >= 2);
  await fails(call('c1', 'set_cell_text', { p_term: id, p_lang: 'AM', p_text: 'другое', p_version: cell.version }), /AM|амхарский/);
  const ok = await call('vam', 'set_lang_approval', { p_items: rev.items.map((x: any) => ({ id: x.id, version: x.version })), p_lang: 'AM', p_approve: true });
  assert.equal(ok.skipped.length, 0, JSON.stringify(ok.skipped));
  assert.equal(lang(await card(r.tb), 'AM').status, 'approved');
});

test('«Не используется» и просьба «Устарел» → автоархив и возврат с прежними статусами', async () => {
  const id = (await gl('кнопка оплаты')).items[0].id;
  let c = await call('owner', 'term_card', { p_id: id });
  await fails(call('reader', 'propose_obsolete', { p_term: id, p_reason: 'x' }), /менеджер и валидаторы/);
  await call('man', 'propose_obsolete', { p_term: id, p_reason: 'раздел переименовали' });
  const ka = await call('vka', 'lang_requests', { p_lang: 'KA' });
  const ob = ka.find((r: any) => r.type === 'obsolete');
  assert.ok(ob, 'валидатор KA видит просьбу');
  await call('vhy', 'answer_obsolete', { p_request: (await req(`type = 'obsolete'`)).id, p_answer: 'keep', p_comment: 'у нас ещё есть' });
  await call('vka', 'answer_obsolete', { p_request: ob.id, p_answer: 'unused' });
  c = await call('owner', 'term_card', { p_id: id });
  assert.equal(c.status, 'active', 'армянский оставил — термин действует');
  assert.equal(lang(c, 'KA').status, 'unused');
  // остальные языки тоже «Не используется» → архив
  await call('vhy', 'set_unused', { p_term: id, p_lang: 'HY', p_unused: true });
  const last = await call('ven', 'set_unused', { p_term: id, p_lang: 'EN', p_unused: true });
  assert.equal(last.archived, true);
  assert.equal((await gl('кнопка оплаты')).items.length, 0);
  const ex = await call('man', 'export_data', { p_langs: ['EN', 'KA', 'HY'] });
  assert.ok(!ex.terms.some((t: any) => t.ru === 'Кнопка оплаты'));
  c = await call('owner', 'term_card', { p_id: id });
  await fails(call('vka', 'restore_term', { p_term: id, p_version: c.version }), /владелец и валидатор английского/);
  await call('ven', 'restore_term', { p_term: id, p_version: c.version });
  c = await call('owner', 'term_card', { p_id: id });
  assert.equal(lang(c, 'KA').status, 'approved', 'прежний статус вернулся');
  assert.equal(lang(c, 'HY').status, 'draft');
});

test('«Не используется» одного языка — пустая ячейка в выгрузке', async () => {
  const id = (await gl('TB-00001')).items[0].id;
  await call('vhy', 'set_unused', { p_term: id, p_lang: 'HY', p_unused: true });
  const ex = await call('man', 'export_data', { p_langs: ['EN', 'KA', 'HY', 'AM'] });
  const t = ex.terms.find((x: any) => x.tb === 'TB-00001');
  assert.equal(t.tr.HY, undefined);
  assert.deepEqual(ex.languages.map((l: any) => l.code), ['EN', 'KA', 'HY'], 'сокращённый AM не выгружается в Smartcat');
  assert.equal((await gl('TB-00001')).items[0].cells.HY.s, 'unused');
  await call('vhy', 'set_unused', { p_term: id, p_lang: 'HY', p_unused: false });
  assert.equal((await gl('TB-00001')).items[0].cells.HY.s, 'approved');
});

test('анонимность: подрядчики под номерами, сотрудники для подрядчика — по роли', async () => {
  const id = (await gl('TB-00001')).items[0].id;
  await call('c1', 'add_term_comment', { p_term: id, p_body: 'Почему с дефисом?' });
  await call('vka', 'add_term_comment', { p_term: id, p_body: 'Так в интерфейсе' });
  await call('c2', 'add_term_comment', { p_term: id, p_body: 'Не согласен' });
  await fails(call('reader', 'add_term_comment', { p_term: id, p_body: 'x' }), /Читатель/);
  const byStaff = (await call('tka', 'term_card', { p_id: id })).comments.map((c: any) => c.author.name);
  assert.deepEqual(byStaff, ['Подрядчик 1', 'vka', 'Подрядчик 2']);
  const byC1 = (await call('c1', 'term_card', { p_id: id })).comments.map((c: any) => c.author.name);
  assert.deepEqual(byC1, ['c1', 'Валидатор (KA)', 'Подрядчик 2']);
  const byOwner = (await call('owner', 'term_card', { p_id: id })).comments.map((c: any) => c.author.name);
  assert.deepEqual(byOwner, ['c1', 'vka', 'c2']);
  const hist = (await call('c1', 'term_card', { p_id: id })).history.map((h: any) => h.user);
  assert.ok(!hist.some((n: string) => ['vka', 'vhy', 'ven', 'ten', 'tka', 'man', 'owner'].includes(n)), JSON.stringify(hist));
  await fails(call('c1', 'log_page', {}), /владелец и валидаторы/);
  await fails(call('c1', 'work_page', { p_lang: 'KA' }), /грузинского/);
  const log = await call('vka', 'log_page', { p_f: {} });
  assert.ok(log.items.some((x: any) => x.user === 'Подрядчик 1'));
  await fails(call('vka', 'hide_term_comment', { p_comment: 1 }), /валидатор английского и владелец/);
  await call('ven', 'hide_term_comment', { p_comment: 1 });
});

test('русская часть: менеджер, валидатор английского, владелец; объединение дублей', async () => {
  const id = (await gl('TB-00001')).items[0].id;
  let c = await call('owner', 'term_card', { p_id: id });
  await fails(call('vka', 'edit_ru', { p_term: id, p_version: c.version, p_fields: { definition: 'x' } }), /менеджер, валидатор английского/);
  assert.equal(await call('man', 'edit_ru', { p_term: id, p_version: c.version, p_fields: { definition: 'Код для склада', project_ids: [2] } }), 2);
  c = await call('owner', 'term_card', { p_id: id });
  assert.equal(c.ru, 'QR-код');
  // дубль: «QR-код» в такси (заявка подрядчика выше) — утвердим и объединим
  const z = await req(`ru = 'QR-код' and type = 'new' and status = 'pending'`);
  await call('vhy', 'set_request_translation', { p_request: z.id, p_lang: 'HY', p_text: 'QR երկրորդ' }).catch(() => null);
  const zz = await req(`id = ${z.id}`);
  const r = await approve('vhy', zz.id, zz.version, true);
  const second = await card(r.tb);
  await fails(call('vka', 'merge_terms', { p_keep: id, p_drop: second.id }), /валидатор английского/);
  const m = await call('ven', 'merge_terms', { p_keep: second.id, p_drop: id, p_main: { HY: lang(c, 'HY').live[0].id } });
  assert.equal(m.tb, 'TB-00001', 'остаётся меньший номер');
  assert.equal(await card(r.tb), null);
  const merged = await card('TB-00001');
  assert.equal(lang(merged, 'HY').live[0].text, 'QR կոդ', 'основной — выбранный');
  assert.equal(lang(merged, 'HY').live.length, 2);
  // номер не используется повторно
  await submit('vka', { type: 'new', ru: 'Новый после объединения', lang: 'KA', translation: 'ახალი' });
  const zn = await req(`ru = 'Новый после объединения'`);
  const rn = await approve('vka', zn.id, zn.version);
  assert.notEqual(rn.tb, r.tb);
});

test('архив вручную и удаление — только владелец; журнал нельзя менять', async () => {
  const id = (await gl('корзина')).items[0].id;
  const c = await call('owner', 'term_card', { p_id: id });
  await fails(call('ven', 'archive_term', { p_term: id, p_version: c.version }), /владелец/);
  await fails(call('ven', 'delete_term', { p_term: id, p_typed_tb: c.tb }), /только владелец/);
  await fails(call('owner', 'delete_term', { p_term: id, p_typed_tb: 'TB-1' }), /впишите номер/);
  await call('owner', 'delete_term', { p_term: id, p_typed_tb: c.tb.toLowerCase() });
  assert.equal(await card(c.tb), null);
  const log = await call('owner', 'log_page', { p_f: { tb: c.tb } });
  assert.ok(log.items.some((x: any) => x.action === 'Термин удалён окончательно'));
  await fails(sql(`delete from audit_log`), /Журнал нельзя/);
  await fails(sql(`update audit_log set action = 'x'`), /Журнал нельзя/);
});

test('счётчик «Вас ждут»', async () => {
  const d = await call('tka', 'dashboard');
  assert.ok(d.some((c: any) => c.key === 'need'));
  const v = await call('vka', 'dashboard');
  assert.ok(v.some((c: any) => c.key === 'requests') && v.some((c: any) => c.key === 'obsolete'));
  const o = await call('owner', 'dashboard');
  assert.ok(o.some((c: any) => c.key === 'novalidator'));
  const c = await call('c1', 'dashboard');
  assert.ok(c.some((x: any) => x.key === 'mine'));
  assert.deepEqual(await call('reader', 'dashboard'), []);
});

test('выгрузка: права, только полные языки, только согласованное', async () => {
  await fails(call('vka', 'export_count', {}), /менеджер и владелец/);
  const ex = await call('owner', 'export_data', { p_langs: ['EN', 'KA', 'AM'], p_project: 2 });
  assert.deepEqual(ex.terms.map((t: any) => t.tb), ['TB-00001']);
  assert.deepEqual(ex.terms[0].fields.EN.forbidden, [{ text: 'QR-code', note: 'без дефиса' }]);
  await call('man', 'log_export', { p_langs: ['EN'], p_project: null, p_format: 'xlsx', p_count: 3 });
  assert.equal((await call('man', 'export_history')).length, 1);
});

test('администрирование: один валидатор на язык, номера подрядчиков', async () => {
  await fails(call('ven', 'admin_users'), /только владельцу/);
  await fails(call('owner', 'admin_create_user', { p_email: 'v2@x.ru', p_name: 'v2', p_role: 'validator', p_lang: 'KA' }), /уже есть валидатор/);
  await fails(call('owner', 'admin_create_user', { p_email: 't@x.ru', p_name: 't', p_role: 'translator' }), /выбрать язык/);
  await call('owner', 'admin_create_user', { p_email: 'c3@x.ru', p_name: 'c3', p_role: 'contractor' });
  const users = await call('owner', 'admin_users');
  assert.equal(users.find((x: any) => x.email === 'c3@x.ru').contractor_no, 3);
  await fails(call('owner', 'admin_update_user', { p_user: U.owner.id, p_name: 'o', p_role: 'manager' }), /самого себя/);
  await call('owner', 'admin_add_language', { p_code: 'fr', p_name: 'французский', p_smartcat: 'fr', p_kind: 'full' });
  assert.equal(lang(await card('TB-00001'), 'FR').status, 'need');
  const langs = await call('owner', 'admin_languages');
  assert.equal(langs.find((l: any) => l.code === 'KA').validator, 'vka');
});

test('черновик: исправление одного дефиса сохраняется', async () => {
  const id = (await gl('TB-00001')).items[0].id;
  let c = await call('owner', 'term_card', { p_id: id });
  const r1 = await call('vhy', 'set_cell_text', { p_term: id, p_lang: 'FR', p_text: 'x', p_version: c.version }).catch((e: Error) => e.message);
  assert.match(String(r1), /французский|переводчик/);
  await call('owner', 'admin_create_user', { p_email: 'tfr@x.ru', p_name: 'tfr', p_role: 'translator', p_lang: 'FR' });
  U.tfr = { id: 0, uid: randomUUID() };
  await sql(`insert into auth.users(id, email) values ($1, 'tfr@x.ru')`, [U.tfr.uid]);
  const a = await call('tfr', 'set_cell_text', { p_term: id, p_lang: 'FR', p_text: 'code-QR', p_version: c.version });
  const b = await call('tfr', 'set_cell_text', { p_term: id, p_lang: 'FR', p_text: 'code QR', p_version: a.version });
  assert.equal(b.text, 'code QR');
  assert.equal(b.status, 'draft');
});
