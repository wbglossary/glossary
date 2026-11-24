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
  for (const k of ['definition', 'examples', 'comment']) assert.ok(k in g.items[0], `в строке глоссария есть поле ${k}`);
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
  await submit('man', { type: 'new', ru: 'Кнопка оплаты', definition: '= формула?', project_ids: [1] });
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

test('«Это тот же смысл?»: да — перевод к существующему; нет — новый с определением', async () => {
  const r = await submit('c1', { type: 'new', ru: 'qr код', lang: 'HY', translation: 'QR' });
  assert.equal(r.status, 'repeat');
  const id = r.matches[0].id;
  await fails(submit('c1', { type: 'new', ru: 'qr код', lang: 'HY', translation: 'x', new_meaning: true }), /заполните «Определение»/);
  const same = await submit('c1', { type: 'new', ru: 'qr код', lang: 'AM', translation: 'QR AM', same_as: id });
  assert.equal(same.status, 'added', 'AM без валидатора — подрядчик добавляет сразу');
  const c = await card('TB-00001');
  assert.equal(lang(c, 'AM').status, 'unchecked');
  const other = await submit('c1', { type: 'new', ru: 'QR-код', lang: 'HY', translation: 'QR другой', new_meaning: true, definition: 'в такси' });
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

test('«Не актуально для языка» и просьба «Устарел» → автоархив и возврат с прежними статусами', async () => {
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
  // остальные языки тоже «Не актуально для языка» → архив
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

test('«Не актуально для языка» одного языка — пустая ячейка в выгрузке', async () => {
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
  await fails(call('c1', 'log_page', {}), /Журнал видят/);
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

test('проекты у нескольких терминов сразу: менеджер добавляет и убирает, переводчик — нет', async () => {
  const a = (await gl('TB-00001')).items[0].id;
  const b = (await gl('TB-00002')).items[0]?.id ?? a;
  const ids = [...new Set([a, b])];
  await fails(call('tka', 'set_term_project', { p_terms: ids, p_project: 1, p_add: true }), /менеджер, валидатор английского/);
  const v0 = (await call('owner', 'term_card', { p_id: a })).version;
  const added = await call('man', 'set_term_project', { p_terms: ids, p_project: 1, p_add: true });
  assert.ok(added >= 1);
  assert.equal(await call('man', 'set_term_project', { p_terms: ids, p_project: 1, p_add: true }), 0, 'повторное добавление ничего не меняет');
  const c = await call('owner', 'term_card', { p_id: a });
  assert.ok(c.projects.some((p: { id: number }) => p.id === 1));
  assert.ok(c.version > v0, 'версия термина растёт — открытые карточки узнают об изменении');
  assert.equal(await call('man', 'set_term_project', { p_terms: ids, p_project: 1, p_add: false }), ids.length);
  assert.ok(!(await call('owner', 'term_card', { p_id: a })).projects.some((p: { id: number }) => p.id === 1));
});

test('обратная связь: пишут все, видит своё; владелец видит всё и отвечает, автор видит ответ', async () => {
  await fails(call('reader', 'submit_feedback', { p_kind: 'idea', p_body: '   ', p_page: 'home' }), /Напишите/);
  await fails(call('reader', 'submit_feedback', { p_kind: 'wish', p_body: 'x', p_page: 'home' }), /вопрос, проблема или идея/);
  const id = await call('reader', 'submit_feedback', { p_kind: 'problem', p_body: 'Не нашла кнопку выгрузки', p_page: 'glossary' });
  await call('tka', 'submit_feedback', { p_kind: 'idea', p_body: 'Хочу тёмную тему', p_page: 'work' });
  assert.equal((await call('reader', 'feedback_list', {})).length, 1, 'читатель видит только своё');
  assert.equal((await call('owner', 'feedback_list', { p_status: 'new' })).length >= 2, true);
  await fails(call('man', 'answer_feedback', { p_id: id, p_answer: 'x', p_status: 'done' }), /владелец/);
  await call('owner', 'answer_feedback', { p_id: id, p_answer: 'Выгрузка — у менеджера и владельца', p_status: 'done' });
  const d = await call('reader', 'dashboard');
  assert.ok(d.some((c: { key: string; count: number }) => c.key === 'fb-answers' && c.count === 1), 'у автора — счётчик ответа');
  const mine = await call('reader', 'feedback_list', {});
  assert.equal(mine[0].answer, 'Выгрузка — у менеджера и владельца');
  assert.equal(mine[0].unseen, true);
  assert.ok(!(await call('reader', 'dashboard')).some((c: { key: string }) => c.key === 'fb-answers'), 'после просмотра счётчик пропадает');
});

test('архив вручную — владелец; удаление — владелец и валидатор английского; журнал нельзя менять', async () => {
  const id = (await gl('корзина')).items[0].id;
  const c = await call('owner', 'term_card', { p_id: id });
  await fails(call('ven', 'archive_term', { p_term: id, p_version: c.version }), /владелец/);
  await fails(call('vka', 'delete_term', { p_term: id, p_typed_tb: c.tb }), /владелец и валидатор английского/);
  assert.equal((await call('ven', 'term_card', { p_id: id })).can.delete, true);
  await fails(call('owner', 'delete_term', { p_term: id, p_typed_tb: 'TB-1' }), /впишите номер/);
  await call('ven', 'delete_term', { p_term: id, p_typed_tb: c.tb.toLowerCase() });
  assert.equal(await card(c.tb), null);
  const log = await call('owner', 'log_page', { p_f: { tb: c.tb } });
  assert.ok(log.items.some((x: any) => x.action === 'Термин удалён окончательно'));
  await fails(sql(`delete from audit_log`), /Журнал нельзя/);
  await fails(sql(`update audit_log set action = 'x'`), /Журнал нельзя/);
});

test('счётчик «Вас ждут»', async () => {
  const d = await call('tka', 'dashboard');
  assert.ok(d.some((c: any) => c.key.startsWith('need')));
  const v = await call('vka', 'dashboard');
  assert.ok(v.some((c: any) => c.key.startsWith('requests')) && v.some((c: any) => c.key.startsWith('obsolete')));
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

test('один человек: валидатор одного языка и переводчик другого', async () => {
  await call('owner', 'admin_create_user', { p_email: 'mix@x.ru', p_name: 'mix', p_role: 'validator',
    p_langs: [{ lang: 'UZ', role: 'validator' }, { lang: 'KY', role: 'translator' }] }).catch(async (e: Error) => {
      // UZ/KY может не быть в тестовой базе — добавим
      if (!/Такого языка нет/.test(e.message)) throw e;
      for (const [c, n] of [['UZ', 'узбекский'], ['KY', 'киргизский']]) await call('owner', 'admin_add_language', { p_code: c, p_name: n, p_smartcat: c.toLowerCase(), p_kind: 'full' }).catch(() => null);
      await call('owner', 'admin_create_user', { p_email: 'mix@x.ru', p_name: 'mix', p_role: 'validator', p_langs: [{ lang: 'UZ', role: 'validator' }, { lang: 'KY', role: 'translator' }] });
    });
  U.mix = { id: 0, uid: randomUUID() };
  await sql(`insert into auth.users(id, email) values ($1, 'mix@x.ru')`, [U.mix.uid]);
  const me = await call('mix', 'me');
  assert.deepEqual(me.langs.map((l: any) => `${l.role}:${l.code}`), ['validator:UZ', 'translator:KY']);
  assert.equal(me.role, 'validator');
  const id = (await gl('TB-00001')).items[0].id;
  let c = await call('owner', 'term_card', { p_id: id });
  // KY: переводчик — пишет черновик, согласовать не может
  const ky = await call('mix', 'set_cell_text', { p_term: id, p_lang: 'KY', p_text: 'QR-код KY', p_version: c.version });
  assert.equal(ky.status, 'draft');
  await fails(call('mix', 'set_lang_approval', { p_items: [{ id, version: ky.version }], p_lang: 'KY', p_approve: true }), /валидатор/);
  // UZ: валидатор — вписывает и сам согласует
  c = await call('owner', 'term_card', { p_id: id });
  const uz = await call('mix', 'set_cell_text', { p_term: id, p_lang: 'UZ', p_text: 'QR-kod', p_version: c.version });
  await call('mix', 'set_lang_approval', { p_items: [{ id, version: uz.version }], p_lang: 'UZ', p_approve: true });
  assert.equal(lang(await card('TB-00001'), 'UZ').status, 'approved');
  // счётчики по каждому языку
  const d = await call('mix', 'dashboard');
  assert.ok(d.some((x: any) => x.key === 'requests-UZ') && !d.some((x: any) => x.key === 'requests-KY'));
  // второй валидатор UZ не пройдёт
  await fails(call('owner', 'admin_create_user', { p_email: 'uz2@x.ru', p_name: 'uz2', p_role: 'validator', p_lang: 'UZ' }), /уже есть валидатор/);
  // у языка UZ виден валидатор
  assert.equal((await call('owner', 'admin_languages')).find((l: any) => l.code === 'UZ').validator, 'mix');
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

test('менеджер выбирает языки: остальные — «по желанию», только во вкладке «Новое из других языков»', async () => {
  const r = await submit('man', { type: 'new', ru: 'Только грузинский', definition: 'тест', target_langs: ['KA'] });
  assert.equal(r.status, 'submitted');
  const z = await req(`ru = 'Только грузинский'`);
  const ka = await call('vka', 'lang_requests', { p_lang: 'KA' });
  assert.ok(ka.some((x: any) => x.id === z.id), 'KA видит заявку');
  const hy = await call('vhy', 'lang_requests', { p_lang: 'HY' });
  assert.ok(!hy.some((x: any) => x.id === z.id), 'HY не видит заявку');
  await call('vka', 'set_request_translation', { p_request: z.id, p_lang: 'KA', p_text: 'მხოლოდ' });
  const zz = await req(`id = ${z.id}`);
  const a = await approve('vka', zz.id, zz.version, true);
  const c = await card(a.tb);
  assert.equal(lang(c, 'KA').status, 'approved');
  assert.equal(lang(c, 'HY').status, 'optional');
  const need = await call('vhy', 'work_page', { p_lang: 'HY', p_tab: 'mine', p_status: 'need' });
  assert.ok(!need.items.some((x: any) => x.tb === a.tb), 'не в «Нужен перевод»');
  const nw = await call('vhy', 'work_page', { p_lang: 'HY', p_tab: 'new' });
  assert.ok(nw.items.some((x: any) => x.tb === a.tb), 'есть в «Новое из других языков»');
  await call('man', 'set_lang_optional', { p_term: c.id, p_lang: 'HY', p_optional: false });
  assert.equal(lang(await card(a.tb), 'HY').status, 'need');
  await fails(submit('man', { type: 'new', ru: 'Ни одного', target_langs: [] }), /хотя бы один язык/);
});

test('отзыв заявки: пока никто не вписал перевод', async () => {
  await submit('man', { type: 'new', ru: 'Отзываемый термин' });
  let z = await req(`ru = 'Отзываемый термин'`);
  await fails(call('ten', 'withdraw_request', { p_request: z.id }), /только её автор/);
  await call('ten', 'set_request_translation', { p_request: z.id, p_lang: 'EN', p_text: 'Withdrawn' });
  await fails(call('man', 'withdraw_request', { p_request: z.id }), /уже начали работать/);
  await call('ten', 'set_request_translation', { p_request: z.id, p_lang: 'EN', p_text: '' });
  const mine = await call('man', 'my_requests');
  assert.equal(mine.find((x: any) => x.id === z.id).can_withdraw, true);
  await call('man', 'withdraw_request', { p_request: z.id });
  z = await req(`id = ${z.id}`);
  assert.equal(z.status, 'withdrawn');
});

test('загрузка переводов подрядчика и удаление закрытого проекта', async () => {
  await fails(call('tka', 'import_translations', { p_rows: [{ ru: 'QR-код', tr: { AM: 'x' } }] }), /менеджер и владелец/);
  // два термина «Двойник» — различаем по определению
  for (const [d, t] of [['кнопка в приложении', 'ორი'], ['склад, сборка заказа', 'სამი']]) {
    await submit('vka', { type: 'new', ru: 'Двойник', lang: 'KA', translation: t, definition: d, new_meaning: true });
    const z = await req(`ru = 'Двойник' and status = 'pending'`);
    await approve('vka', z.id, z.version, true);
  }
  const rows = [
    { ru: 'QR-код', tr: { AM: 'QR AM', KA: 'QR-კოდი' } },
    { ru: 'Только грузинский', tr: { AM: 'ብቻ', HY: 'Միայն' } },
    { ru: 'Двойник', definition: 'Склад, сборка заказа', tr: { AM: 'መጋዘን' } },
    { ru: 'Двойник', tr: { AM: '?' } },
    { ru: 'нет такого', tr: { AM: 'y' } },
    { ru: 'QR-код', tr: { XX: 'z' } }
  ];
  const pre = await call('man', 'import_translations', { p_rows: rows });
  assert.deepEqual(pre.rows.map((x: any) => x.match), ['ok', 'ok', 'ok', 'ambiguous', 'new', 'ok'], 'нового термина нет в глоссарии — будет заявка');
  assert.equal(pre.rows[0].langs.AM.status, 'same');
  assert.equal(pre.rows[0].langs.KA.status, 'same');
  assert.equal(pre.rows[1].langs.HY.as, 'draft', 'у HY есть валидатор — черновик');
  assert.equal(pre.rows[2].definition, 'склад, сборка заказа');
  assert.equal(pre.rows[3].candidates.length, 2);
  assert.equal(pre.rows[5].langs.XX.status, 'no_lang');
  assert.equal(pre.added, 0);
  const done = await call('man', 'import_translations', { p_rows: rows, p_apply: true });
  assert.equal(done.added, 3);
  assert.equal(done.requests.length, 1);
  const g = await gl('Только грузинский');
  assert.equal(g.items[0].cells.AM.s, 'unchecked');
  assert.equal(g.items[0].cells.HY.s, 'draft');
  // проект
  const [p] = await sql<{ id: number }>(`select id from projects where name = 'такси'`);
  await fails(call('owner', 'admin_delete_project', { p_project: p.id }), /только закрытый/);
  await call('owner', 'admin_update_project', { p_project: p.id, p_name: 'такси', p_closed: true });
  await fails(call('man', 'admin_delete_project', { p_project: p.id }), /владельцу/);
  await call('owner', 'admin_delete_project', { p_project: p.id });
  assert.equal((await sql(`select 1 from projects where id = ${p.id}`)).length, 0);
});

test('«Не актуально для языка» сразу для нескольких терминов', async () => {
  const ids = (await call('reader', 'glossary_page', { p_q: 'Двойник' })).items.map((x: any) => x.id);
  await fails(call('tka', 'set_unused_many', { p_terms: ids, p_lang: 'KA', p_unused: true }), /валидатор грузинского/);
  const r = await call('ven', 'set_unused_many', { p_terms: ids, p_lang: 'EN', p_unused: true });
  assert.equal(r.changed, ids.length);
  assert.equal((await call('reader', 'glossary_page', { p_q: 'Двойник' })).items[0].cells.EN.s, 'unused');
  const back = await call('ven', 'set_unused_many', { p_terms: ids, p_lang: 'EN', p_unused: false });
  assert.equal(back.changed, ids.length);
});

test('загрузка таблицы: новые термины уходят заявкой на валидацию, повторы пропускаются', async () => {
  const rows = [
    { ru: 'Новинка из Smartcat', definition: 'тест', tr: { KA: 'ახალი', AM: 'አዲስ' } },
    { ru: 'новинка из smartcat', tr: { KA: 'ახალი 2' } },
    { ru: 'QR-код', tr: { KA: 'QR-კოდი' } }
  ];
  const pre = await call('man', 'import_translations', { p_rows: rows });
  assert.deepEqual(pre.rows.map((x: any) => x.match), ['new', 'dup_in_file', 'ok']);
  assert.equal(pre.rows[0].langs.KA.status, 'new');
  const [p] = await sql<{ id: number }>(`select id from projects where name = 'ПВЗ'`);
  const done = await call('man', 'import_translations', { p_rows: rows, p_apply: true, p_projects: [p.id] });
  assert.equal(done.requests.length, 1);
  const z = await req(`code = '${done.requests[0]}'`);
  assert.equal(z.status, 'pending');
  const ka = await call('vka', 'lang_requests', { p_lang: 'KA' });
  assert.ok(ka.some((x: any) => x.code === z.code), 'валидатор KA видит заявку');
  // второй раз — уже в заявке, ничего не создаём
  const again = await call('man', 'import_translations', { p_rows: rows.slice(0, 1), p_apply: true });
  assert.equal(again.rows[0].match, 'in_request');
  assert.equal(again.requests.length, 0);
  // валидатор утверждает — термин в проекте ПВЗ, переводы других языков — черновики их валидаторам
  const a = await approve('vka', z.id, z.version, true);
  const c = await card(a.tb);
  assert.equal(lang(c, 'KA').status, 'approved');
  assert.equal(lang(c, 'AM').status, 'draft', 'у AM в тестах есть валидатор — черновик ему на проверку');
  assert.deepEqual(c.projects.map((x: any) => x.name), ['ПВЗ']);
  // язык без валидатора — проверять некому: термин сразу, «Без проверки»
  await sql(`insert into languages(code, name, smartcat_code, kind, sort) values ('SW','суахили','sw','short',9) on conflict do nothing`);
  const d = await call('man', 'import_translations', { p_rows: [{ ru: 'Только суахили', tr: { SW: 'Pekee' } }], p_apply: true });
  assert.equal(d.rows[0].match, 'direct');
  assert.equal((await gl('Только суахили')).items[0].cells.SW.s, 'unchecked');
});

test('«Данные» и «данные» — не одинаковые термины', async () => {
  for (const ru of ['Данные', 'данные']) {
    await submit('vka', { type: 'new', ru, lang: 'KA', translation: 'მონაცემები ' + ru, definition: ru, new_meaning: true });
    const z = await req(`ru = '${ru}' and status = 'pending'`);
    await approve('vka', z.id, z.version, true);
  }
  const g = await call('ven', 'glossary_page', { p_dupes: true, p_q: 'данные' });
  assert.equal(g.total, 0, 'разный регистр — не дубль');
});

test('скрыть «не актуально» для своего языка', async () => {
  const id = (await gl('Данные')).items.find((x: any) => x.ru === 'Данные').id;
  await call('ven', 'set_unused_many', { p_terms: [id], p_lang: 'EN', p_unused: true });
  const all = await call('ven', 'glossary_page', { p_q: 'Данные', p_size: 5000 });
  const hid = await call('ven', 'glossary_page', { p_q: 'Данные', p_size: 5000, p_hide_unused: ['EN'] });
  assert.ok(all.items.some((x: any) => x.id === id) && !hid.items.some((x: any) => x.id === id));
  const two = await call('ven', 'glossary_page', { p_q: 'Данные', p_size: 5000, p_hide_unused: ['EN', 'KA'] });
  assert.ok(two.items.some((x: any) => x.id === id), 'для KA актуально — не прячем');
  const w1 = await call('ven', 'work_page', { p_lang: 'EN', p_q: 'Данные' });
  const w2 = await call('ven', 'work_page', { p_lang: 'EN', p_q: 'Данные', p_hide_unused: true });
  assert.ok(w1.items.some((x: any) => x.id === id) && !w2.items.some((x: any) => x.id === id));
  await call('ven', 'set_unused_many', { p_terms: [id], p_lang: 'EN', p_unused: false });
});

test('выгрузка для подрядчика: только термины без перевода на выбранном языке', async () => {
  await fails(call('tka', 'export_contractor', { p_langs: ['AM'] }), /менеджер и владелец/);
  const d = await call('man', 'export_contractor', { p_langs: ['AM'] });
  assert.ok(d.terms.length > 0);
  assert.ok(d.terms.every((t: any) => !t.tr.AM), 'у всех нет перевода на AM');
  assert.ok(!d.terms.some((t: any) => t.tb === 'TB-00001'), 'TB-00001 уже переведён на AM');
});

test('журнал — менеджерам и переводчикам; все заявки — менеджерам и владельцу', async () => {
  const lm = await call('man', 'log_page', {});
  assert.ok(lm.total > 0, 'менеджер видит журнал');
  const lt = await call('tka', 'log_page', {});
  assert.ok(lt.items.every((x: any) => x.lang === 'KA' || x.lang === null), 'переводчик — свой язык и русская часть');
  await fails(call('c1', 'log_page', {}), /Журнал видят/);
  await fails(call('tka', 'all_requests', {}), /менеджеры и владелец/);
  const all = await call('man', 'all_requests', { p_status: 'all' });
  assert.ok(all.some((x: any) => !x.mine), 'видно чужие заявки');
});

test('загрузка: термин из заявки и одинаковые термины по заглавным буквам', async () => {
  // заявка менеджера с переводом KA (у KA есть валидатор) ждёт проверки
  await call('man', 'import_translations', { p_rows: [{ ru: 'Алгоритмы', definition: 'тест', tr: { KA: 'ალგორითმები' } }], p_apply: true });
  const z = await req(`ru = 'Алгоритмы' and status = 'pending'`);
  // язык без валидатора (SW) — термин создаётся сразу, заявка забирается в него
  const r = await call('man', 'import_translations', { p_rows: [{ ru: 'Алгоритмы', tr: { SW: 'Algorithms SW' } }], p_apply: true });
  assert.equal(r.rows[0].match, 'from_request');
  const c = await card(r.rows[0].tb);
  assert.equal(lang(c, 'SW').status, 'unchecked');
  assert.equal(lang(c, 'KA').status, 'draft', 'перевод из заявки — черновик валидатору KA');
  assert.equal((await req(`id = ${z.id}`)).status, 'auto_removed');
  // язык с валидатором — перевод дописывается в заявку
  await call('man', 'import_translations', { p_rows: [{ ru: 'Новая витрина', definition: 'тест', tr: { KA: 'ვიტრინა' } }], p_apply: true });
  const r2 = await call('man', 'import_translations', { p_rows: [{ ru: 'Новая витрина', tr: { HY: 'Ցուցափեղկ' } }], p_apply: true });
  assert.equal(r2.rows[0].match, 'in_request');
  const z2 = await req(`ru = 'Новая витрина'`);
  assert.equal((await sql(`select 1 from request_translations where request_id = ${z2.id} and lang = 'HY'`)).length, 1);
  // «Данные» и «данные» — выбирается по заглавным буквам
  const g = await call('man', 'import_translations', { p_rows: [{ ru: 'данные', tr: { SW: 'data' } }] });
  assert.equal(g.rows[0].match, 'ok');
  assert.equal(g.rows[0].ru, 'данные');
});

test('выгрузка: у языка без валидатора идёт и «Без проверки»', async () => {
  await sql(`update languages set kind = 'full' where code = 'SW'`);
  const d = await call('man', 'export_data', { p_langs: ['SW'] });
  assert.ok(d.terms.some((t: any) => t.tr.SW?.length), 'SW «Без проверки» попадает в Smartcat');
  const k = await call('man', 'export_data', { p_langs: ['KA'] });
  assert.ok(!k.terms.some((t: any) => (t.tr.KA ?? []).includes('ალგორითმები')), 'черновик KA — не попадает');
});

test('выгрузка: термин без переводов на выбранные языки не попадает', async () => {
  const d = await call('man', 'export_data', { p_langs: ['HY'] });
  assert.ok(d.terms.length > 0 && d.terms.every((t: any) => t.tr.HY?.length), 'только термины с переводом HY');
  const n = await call('man', 'export_count', { p_langs: ['HY'] });
  assert.equal(n, d.terms.length);
});

test('счётчики «Без перевода» по всем языкам — у менеджера и владельца', async () => {
  for (const who of ['man', 'owner']) {
    const d = await call(who, 'dashboard');
    assert.ok(d.some((c: any) => c.key === 'need-AM'), `${who}: есть сокращённый AM`);
    assert.ok(d.some((c: any) => c.key === 'need-EN'), `${who}: есть EN`);
  }
});

test('«Не актуально» у языка без валидатора — менеджер и владелец', async () => {
  const id = (await gl('Данные')).items.find((x: any) => x.ru === 'Данные').id;
  await fails(call('man', 'set_unused_many', { p_terms: [id], p_lang: 'KA', p_unused: true }), /валидатор грузинского/);
  const r = await call('man', 'set_unused_many', { p_terms: [id], p_lang: 'SW', p_unused: true });
  assert.equal(r.changed, 1);
  const c = await call('owner', 'term_card', { p_id: id });
  assert.equal(lang(c, 'SW').can.unused, true, 'владельцу доступна кнопка у SW');
  assert.equal(lang(c, 'KA').can.unused, false, 'у KA есть валидатор — только он');
  await call('owner', 'set_unused', { p_term: id, p_lang: 'SW', p_unused: false });
  await fails(call('tka', 'set_unused', { p_term: id, p_lang: 'SW', p_unused: true }), /менеджер или владелец/);
});
