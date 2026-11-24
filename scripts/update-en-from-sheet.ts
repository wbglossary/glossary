/**
 * Обновление английского и русской части из проверенной таблицы (RU, EN, Комментарий EN, Определение, Примеры).
 * npx tsx scripts/update-en-from-sheet.ts payload.json           — проба с откатом
 * npx tsx scripts/update-en-from-sheet.ts payload.json --apply   — записать
 * payload: { update: [{tb, rename?, ru, en[], comment, definition, examples}], new: [{ru, en[], comment, definition, examples}] }
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const [file, flag] = process.argv.slice(2);
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const FN = `
create or replace function pg_temp.upd(p jsonb) returns jsonb language plpgsql as $f$
declare e jsonb; t terms; v_cur text[]; v_new text[]; v_first int; v_id int; i int; v text;
  n_en int := 0; n_def int := 0; n_ex int := 0; n_com int := 0; n_ren int := 0; n_new int := 0; v_base int; L constant text := 'Обновлено из таблицы EN';
begin
  select id into v_base from projects where name = 'Базовый';
  for e in select * from jsonb_array_elements(p->'update') loop
    select * into t from terms where tb = e->>'tb' for update;
    if not found then raise exception 'нет термина %', e->>'tb'; end if;
    if e->>'rename' is not null and t.ru <> e->>'rename' then
      insert into audit_log(user_label, action, tb, before, after) values (L, 'Изменён русский термин', t.tb, t.ru, e->>'rename');
      update terms set ru = e->>'rename' where id = t.id; n_ren := n_ren + 1;
    end if;
    if coalesce(e->>'definition', '') is distinct from t.definition then
      insert into audit_log(user_label, action, tb, before, after) values (L, 'Изменено поле «Определение» (рус.)', t.tb, t.definition, e->>'definition');
      update terms set definition = coalesce(e->>'definition', '') where id = t.id; n_def := n_def + 1;
    end if;
    if coalesce(e->>'examples', '') is distinct from t.examples then
      insert into audit_log(user_label, action, tb, before, after) values (L, 'Изменено поле «Примеры» (рус.)', t.tb, t.examples, e->>'examples');
      update terms set examples = coalesce(e->>'examples', '') where id = t.id; n_ex := n_ex + 1;
    end if;
    -- английский: если отличается — новый согласованный, старый уходит в историю
    v_cur := array(select x.text from translations x where x.term_id = t.id and x.lang = 'EN' and x.status <> 'obsolete' order by x.sort, x.id);
    v_new := array(select jsonb_array_elements_text(e->'en'));
    if cardinality(v_new) > 0 and array(select norm_term(x) from unnest(v_cur) x) is distinct from array(select norm_term(x) from unnest(v_new) x) then
      select x.id into v_first from translations x where x.term_id = t.id and x.lang = 'EN' and x.status <> 'obsolete' order by x.sort, x.id limit 1;
      update translations set sort = sort + 100 where term_id = t.id and lang = 'EN' and status <> 'obsolete';
      i := 1; v_id := null;
      foreach v in array v_new loop
        insert into translations(term_id, lang, text, sort, status, approved_at) values (t.id, 'EN', v, i, 'approved', now()) returning id into v;
        if i = 1 then v_id := v::int; end if; i := i + 1;
      end loop;
      update translations set status = 'obsolete', obsolete_at = now(), replaced_by = v_id
       where term_id = t.id and lang = 'EN' and status <> 'obsolete' and sort > 100;
      insert into audit_log(user_label, action, tb, lang, before, after) values (L, 'Замена перевода', t.tb, 'EN', array_to_string(v_cur, '; '), array_to_string(v_new, '; '));
      insert into term_langs(term_id, lang, unused) values (t.id, 'EN', false) on conflict (term_id, lang) do update set unused = false;
      n_en := n_en + 1;
    end if;
    if coalesce(e->>'comment', '') <> '' and coalesce((select comment from term_langs where term_id = t.id and lang = 'EN'), '') <> e->>'comment' then
      insert into term_langs(term_id, lang, comment) values (t.id, 'EN', e->>'comment') on conflict (term_id, lang) do update set comment = excluded.comment;
      insert into audit_log(user_label, action, tb, lang, after) values (L, 'Изменены поля языка', t.tb, 'EN', json_build_object('comment', e->>'comment')::text);
      n_com := n_com + 1;
    end if;
    update terms set version = version + 1, updated_at = now() where id = t.id;
  end loop;
  for e in select * from jsonb_array_elements(p->'new') loop
    insert into terms(tb, ru, definition, examples) values ('TB-' || lpad(nextval('tb_seq')::text, 5, '0'), e->>'ru', coalesce(e->>'definition', ''), coalesce(e->>'examples', ''))
    returning * into t;
    insert into term_projects values (t.id, v_base);
    i := 1;
    for v in select jsonb_array_elements_text(e->'en') loop
      insert into translations(term_id, lang, text, sort, status, approved_at) values (t.id, 'EN', v, i, 'approved', now()); i := i + 1;
    end loop;
    if coalesce(e->>'comment', '') <> '' then insert into term_langs(term_id, lang, comment) values (t.id, 'EN', e->>'comment'); end if;
    insert into audit_log(user_label, action, tb, after) values (L, 'Добавлен термин', t.tb, t.ru);
    n_new := n_new + 1;
  end loop;
  return jsonb_build_object('en_replaced', n_en, 'definitions', n_def, 'examples', n_ex, 'en_comments', n_com, 'renamed', n_ren, 'new_terms', n_new,
    'new_tb', (select string_agg(tb || ' ' || ru, '; ' order by tb) from terms where created_at > now() - interval '1 minute'));
end $f$;`;
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(FN);
    const [r] = await tx`select pg_temp.upd(${readFileSync(file, 'utf8')}::text::jsonb) r`;
    console.log(JSON.stringify(r.r, null, 1));
    if (flag !== '--apply') throw new Error('ROLLBACK');
  });
  console.log('ЗАПИСАНО.');
} catch (e) {
  if ((e as Error).message === 'ROLLBACK') console.log('Проба: ничего не записано (откат).');
  else { console.error('Ошибка:', (e as Error).message); process.exitCode = 1; }
}
await sql.end();
