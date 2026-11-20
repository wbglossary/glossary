/**
 * Загрузка готового глоссария (выгрузки Smartcat) в живую базу одной транзакцией.
 * npx tsx scripts/load-smartcat.ts payload.json            — проба с откатом, только отчёт
 * npx tsx scripts/load-smartcat.ts payload.json --apply    — записать
 * payload: [{ru, definition, examples, comment, projects[], tr: {EN: [...]}, lc: {EN: "..."}}]
 * Все переводы — «Согласовано». Перед записью тестовый TB-01540 удаляется, номера начинаются с TB-00001.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const [file, flag] = process.argv.slice(2);
const apply = flag === '--apply';
const payload = readFileSync(file, 'utf8');
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const FN = `
create or replace function pg_temp.load_glossary(p jsonb) returns jsonb language plpgsql as $f$
declare e jsonb; v_id int; l text; v text; i int; n_terms int := 0; n_tr int := 0; n_lc int := 0; n_pr int := 0; v_first text; v_last text; v_tb text;
begin
  if exists (select 1 from terms where tb <> 'TB-01540') then raise exception 'В глоссарии уже есть термины — загрузка рассчитана на пустой глоссарий'; end if;
  -- тестовый термин и его заявка
  delete from request_translations where request_id in (select id from requests where term_id in (select id from terms where tb = 'TB-01540'));
  delete from request_comments where request_id in (select id from requests where term_id in (select id from terms where tb = 'TB-01540'));
  delete from requests where term_id in (select id from terms where tb = 'TB-01540');
  delete from terms where tb = 'TB-01540';
  delete from retired_tb;
  perform setval('tb_seq', 1, false);
  for e in select * from jsonb_array_elements(p) loop
    v_tb := 'TB-' || lpad(nextval('tb_seq')::text, 5, '0');
    insert into terms(tb, ru, definition, examples, comment) values (v_tb, e->>'ru', coalesce(e->>'definition', ''), coalesce(e->>'examples', ''), coalesce(e->>'comment', ''))
      returning id into v_id;
    n_terms := n_terms + 1; v_first := coalesce(v_first, v_tb); v_last := v_tb;
    insert into term_projects select v_id, pr.id from projects pr where pr.name in (select jsonb_array_elements_text(coalesce(e->'projects', '[]')));
    get diagnostics i = row_count; n_pr := n_pr + i;
    for l in select jsonb_object_keys(coalesce(e->'tr', '{}')) loop
      i := 1;
      for v in select jsonb_array_elements_text(e->'tr'->l) loop
        insert into translations(term_id, lang, text, sort, status, approved_at) values (v_id, l, v, i, 'approved', now());
        i := i + 1; n_tr := n_tr + 1;
      end loop;
    end loop;
    for l in select jsonb_object_keys(coalesce(e->'lc', '{}')) loop
      insert into term_langs(term_id, lang, comment) values (v_id, l, e->'lc'->>l);
      n_lc := n_lc + 1;
    end loop;
  end loop;
  insert into audit_log(user_label, action, details)
  values ('Загрузка из Smartcat', 'Загружен глоссарий', format('Master glossary + Marketing glossary: терминов %s (%s–%s), переводов %s', n_terms, v_first, v_last, n_tr));
  return jsonb_build_object('terms', n_terms, 'first', v_first, 'last', v_last, 'translations', n_tr, 'lang_comments', n_lc, 'term_projects', n_pr,
    'by_lang', (select jsonb_object_agg(lang, c) from (select lang, count(*) c from translations group by lang order by lang) z),
    'marketing', (select count(*) from term_projects tp join projects pr on pr.id = tp.project_id where pr.name = 'Маркетинг'),
    'same_ru', (select count(*) from (select ru_norm from terms group by ru_norm having count(*) > 1) d));
end $f$;`;

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(FN);
    const [r] = await tx`select pg_temp.load_glossary(${payload}::text::jsonb) r`;
    console.log(JSON.stringify(r.r, null, 1));
    if (!apply) throw new Error('ROLLBACK');
  });
  console.log(apply ? 'ЗАПИСАНО.' : '');
} catch (e) {
  if ((e as Error).message === 'ROLLBACK') console.log('Проба: ничего не записано (откат).');
  else { console.error('Ошибка:', (e as Error).message); process.exitCode = 1; }
}
await sql.end();
