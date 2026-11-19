-- Обновление 20.11.2026: в таблице глоссария можно показать определение, примеры и комментарий.
-- Выполнить один раз в Supabase → SQL Editor. Данные не меняются.

create or replace function glossary_page(p_q text default null, p_project int default null, p_lang text default null,
  p_mode text default 'any', p_page int default 1, p_size int default 100, p_dupes boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_total int; v_items jsonb; v_size int := least(greatest(p_size, 10), 500);
begin
  with base as (
    select t.* from terms t
     where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))
       and (p_mode = 'any' or p_lang is null or
            (p_mode = 'has') = exists (select 1 from translations x where x.term_id = t.id and x.lang = p_lang and x.status in ('approved','unchecked')))
       and (not p_dupes or exists (select 1 from terms d where d.status = 'active' and d.ru_norm = t.ru_norm and d.id <> t.id))
       and search_match(t, p_q)
  ), pg as (select * from base order by lower(ru), tb limit v_size offset (greatest(p_page, 1) - 1) * v_size)
  select (select count(*) from base), coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'tb', pg.tb, 'ru', pg.ru, 'context', pg.context, 'version', pg.version,
      'definition', pg.definition, 'examples', pg.examples, 'comment', pg.comment,
      'projects', coalesce((select jsonb_agg(pr.name order by pr.name) from term_projects tp join projects pr on pr.id = tp.project_id where tp.term_id = pg.id), '[]'),
      'cells', lang_cells(pg.id),
      'replaced', coalesce((select jsonb_agg(jsonb_build_object('lang', o.lang, 'old', o.text, 'new', n.text, 'at', o.obsolete_at) order by o.obsolete_at)
               from translations o join translations n on n.id = o.replaced_by where o.term_id = pg.id and o.status = 'obsolete'), '[]'),
      'obsolete_request', (select jsonb_build_object('code', r.code, 'reason', r.reason) from requests r
               where r.term_id = pg.id and r.type = 'obsolete' and r.status = 'pending' limit 1),
      'forbidden_hit', case when norm_term(p_q) <> '' then (select jsonb_agg(jsonb_build_object('lang', tl.lang, 'text', f->>'text', 'good', live_text(pg.id, tl.lang)))
               from term_langs tl, jsonb_array_elements(tl.forbidden) f where tl.term_id = pg.id and norm_term(f->>'text') like '%' || norm_term(p_q) || '%') end
    ) order by lower(pg.ru), pg.tb), '[]')
  into v_total, v_items from pg;
  return jsonb_build_object('items', v_items, 'total', v_total, 'page', greatest(p_page, 1), 'pages', greatest(1, ceil(v_total::numeric / v_size)));
end $$;
