-- Обновление 24.11.2026 (7): выгрузка — у языков без валидатора и «Без проверки».
begin;
-- Правила глоссария внутри базы (ТЗ v3.6). Сайт — статичная страница; все проверки прав,
-- атомарные замены, журнал, анонимность и защита от одновременных правок — здесь.
-- Браузер вызывает только функции из раздела «API». Применяется после schema.sql, можно повторно.

-- =====================================================================
-- Служебное
-- =====================================================================

create or replace function app_error(msg text) returns void language plpgsql as $$
begin
  raise exception using message = msg, errcode = 'P0001';
end $$;

create or replace function conflict_error() returns void language plpgsql as $$
begin
  raise exception using message = 'Данные уже изменились, обновите страницу.', errcode = 'P0001';
end $$;

create or replace function split_variants(t text) returns text[] language plpgsql immutable as $$
declare part text; outv text[] := '{}'; seen text[] := '{}'; k text;
begin
  foreach part in array string_to_array(coalesce(t, ''), ';') loop
    part := btrim(part);
    if part = '' then continue; end if;
    k := norm_term(part);
    if k = any(seen) then continue; end if;
    seen := seen || k;
    outv := outv || part;
  end loop;
  return outv;
end $$;

create or replace function lang_name(p_code text) returns text language sql stable as $$
  select coalesce((select l.name from languages l where l.code = p_code), p_code)
$$;

-- Родительный падеж названия языка: «валидатор английского»
create or replace function lang_gen(p_code text) returns text language sql stable as $$
  select case when n ~ '(ий|ый)$' then regexp_replace(n, '(ий|ый)$', 'ого') else n end
  from (select lang_name(p_code) as n) x
$$;

create or replace function role_label(p_role text) returns text language sql immutable as $$
  select case p_role when 'owner' then 'Владелец' when 'validator' then 'Валидатор' when 'manager' then 'Менеджер'
    when 'translator' then 'Переводчик' when 'contractor' then 'Подрядчик' when 'reader' then 'Читатель' else p_role end
$$;

create or replace function req_type_label(p_type text) returns text language sql immutable as $$
  select case p_type when 'new' then 'Новый термин' when 'translation' then 'Перевод к термину' when 'variant' then 'Дополнительный вариант'
    when 'replace' then 'Замена' when 'obsolete' then 'Просьба «Устарел»' else p_type end
$$;

create or replace function req_status_label(p_status text) returns text language sql immutable as $$
  select case p_status when 'pending' then 'На рассмотрении' when 'approved' then 'Утверждена' when 'rejected' then 'Отклонена'
    when 'auto_removed' then 'Снята автоматически' when 'closed' then 'Закрыта' when 'withdrawn' then 'Отозвана автором' else p_status end
$$;

-- Текущий пользователь. При первом входе профиль находится по почте и запоминает user_id.
create or replace function app_profile() returns profiles
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); u profiles; v_email text;
begin
  if v_uid is null then perform app_error('Войдите в систему.'); end if;
  select * into u from profiles where user_id = v_uid;
  if not found then
    select email into v_email from auth.users where id = v_uid;
    update profiles set user_id = v_uid where lower(email) = lower(v_email) and user_id is null returning * into u;
  end if;
  if u.id is null or not u.active then
    perform app_error('Ваш доступ не настроен или отключён. Обратитесь к владельцу глоссария.');
  end if;
  return u;
end $$;

-- ---------- Права ----------
create or replace function is_owner(u profiles) returns boolean language sql immutable as $$ select u.role = 'owner' $$;
-- Языки человека с ролью на каждом (profile_langs). Переводчик и валидатор могут работать на нескольких языках.
create or replace function is_validator_of(u profiles, p_lang text) returns boolean language sql stable as $$
  select u.role in ('translator','validator') and exists (select 1 from profile_langs pl where pl.profile_id = u.id and pl.lang = p_lang and pl.role = 'validator')
$$;
create or replace function works_lang(u profiles, p_lang text) returns boolean language sql stable as $$
  select u.role in ('translator','validator') and exists (select 1 from profile_langs pl where pl.profile_id = u.id and pl.lang = p_lang)
$$;
create or replace function is_en_validator(u profiles) returns boolean language sql stable as $$ select is_validator_of(u, 'EN') $$;
-- языки, где человек валидатор / где работает (по порядку языков)
create or replace function validator_langs(u profiles) returns text[] language sql stable as $$
  select coalesce(array(select pl.lang from profile_langs pl join languages l on l.code = pl.lang
    where pl.profile_id = u.id and pl.role = 'validator' and u.role in ('translator','validator') order by case when pl.lang = 'EN' then 0 else 1 end, l.sort), '{}')
$$;
create or replace function work_langs(u profiles) returns text[] language sql stable as $$
  select coalesce(array(select pl.lang from profile_langs pl join languages l on l.code = pl.lang
    where pl.profile_id = u.id and u.role in ('translator','validator') order by (pl.role = 'validator') desc, case when pl.lang = 'EN' then 0 else 1 end, l.sort), '{}')
$$;
create or replace function lang_has_validator(p_lang text) returns boolean language sql stable as $$
  select exists (select 1 from profile_langs pl join profiles v on v.id = pl.profile_id where pl.lang = p_lang and pl.role = 'validator' and v.active)
$$;
create or replace function contractor_direct(u profiles, p_lang text) returns boolean language sql stable as $$
  select u.role = 'contractor' and not lang_has_validator(p_lang)
$$;
create or replace function can_edit_ru(u profiles) returns boolean language sql stable as $$
  select u.role in ('owner','manager') or is_en_validator(u)
$$;
create or replace function can_export(u profiles) returns boolean language sql immutable as $$ select u.role in ('manager','owner') $$;
create or replace function propose_langs(u profiles) returns text[] language sql stable as $$
  select case when u.role in ('translator','validator') then work_langs(u)
              when u.role = 'contractor' then array(select l.code from languages l where l.active order by l.sort)
              else '{}'::text[] end
$$;

-- Как показать автора тому, кто смотрит: анонимность подрядчиков и сотрудников.
create or replace function display_name(viewer profiles, p_author int) returns text language sql stable as $$
  select case
    when p_author is null then 'Система'
    when a.id is null then 'Удалённый пользователь'
    when viewer.role = 'owner' or a.id = viewer.id then a.name
    when a.role = 'contractor' then 'Подрядчик ' || coalesce(a.contractor_no::text, '')
    when viewer.role = 'contractor' then role_label(a.role) || coalesce(' (' || a.lang || ')', '')
    else a.name end
  from (select 1) x left join profiles a on a.id = p_author
$$;
create or replace function author_json(viewer profiles, p_author int) returns jsonb language sql stable as $$
  select jsonb_build_object('name', display_name(viewer, p_author), 'avatar', (select a.avatar from profiles a where a.id = p_author))
$$;

create or replace function log_event(u profiles, p_action text, p_tb text default null, p_req text default null, p_lang text default null,
  p_before text default null, p_after text default null, p_details text default null) returns void
language sql as $$
  insert into audit_log(user_id, user_label, action, tb, request_code, lang, before, after, details)
  values (u.id, coalesce(u.name, 'Система'), p_action, p_tb, p_req, p_lang, p_before, p_after, p_details)
$$;

create or replace function bump_term(p_term int, p_by int, p_expected int default null) returns int language plpgsql as $$
declare v int;
begin
  update terms set version = version + 1, updated_at = now(), updated_by = p_by
   where id = p_term and (p_expected is null or version = p_expected) returning version into v;
  if v is null then perform conflict_error(); end if;
  return v;
end $$;

create or replace function ensure_term_lang(p_term int, p_lang text) returns void language sql as $$
  insert into term_langs(term_id, lang) values (p_term, p_lang) on conflict do nothing
$$;

-- Статус языка у термина: need / optional (перевод по желанию) / draft / unchecked / approved / unused
create or replace function lang_status(p_term int, p_lang text) returns text language sql stable as $$
  select case
    when t.status = 'archived' then 'unused'
    when coalesce(tl.unused, false) then 'unused'
    when not exists (select 1 from translations x where x.term_id = p_term and x.lang = p_lang and x.status <> 'obsolete')
      then case when coalesce(tl.optional, false) then 'optional' else 'need' end
    when tl.draft is not null or exists (select 1 from translations x where x.term_id = p_term and x.lang = p_lang and x.status = 'draft') then 'draft'
    when exists (select 1 from translations x where x.term_id = p_term and x.lang = p_lang and x.status = 'unchecked') then 'unchecked'
    else 'approved' end
  from terms t left join term_langs tl on tl.term_id = t.id and tl.lang = p_lang
  where t.id = p_term
$$;

create or replace function add_translation(p_term int, p_lang text, p_text text, p_status text, p_by int, p_sort int default null) returns translations
language plpgsql as $$
declare t translations; v_sort int := p_sort;
begin
  if v_sort is null then
    select coalesce(max(x.sort), 0) + 1 into v_sort from translations x where x.term_id = p_term and x.lang = p_lang and x.status <> 'obsolete';
  end if;
  perform ensure_term_lang(p_term, p_lang);
  insert into translations(term_id, lang, text, sort, status, created_by, approved_at, approved_by)
  values (p_term, p_lang, p_text, v_sort, p_status, p_by,
          case when p_status = 'approved' then now() end, case when p_status = 'approved' then p_by end)
  returning * into t;
  return t;
end $$;

create or replace function live_text(p_term int, p_lang text) returns text language sql stable as $$
  select coalesce(string_agg(x.text, '; ' order by x.sort, x.id), '') from translations x
   where x.term_id = p_term and x.lang = p_lang and x.status <> 'obsolete'
$$;

-- Языковые поля из json (комментарий лингвиста, «как нельзя»)
create or replace function clean_forbidden(j jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('text', btrim(e->>'text'), 'note', btrim(coalesce(e->>'note', ''))))
                  filter (where btrim(coalesce(e->>'text', '')) <> ''), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) e
$$;

create or replace function apply_lang_fields(p_term int, p_lang text, f jsonb) returns void language plpgsql as $$
begin
  perform ensure_term_lang(p_term, p_lang);
  update term_langs set
    comment    = case when f ? 'comment' then btrim(coalesce(f->>'comment', '')) else comment end,
    forbidden  = case when f ? 'forbidden' then clean_forbidden(f->'forbidden') else forbidden end
  where term_id = p_term and lang = p_lang;
end $$;

-- Предупреждения о возможных дублях и о вариантах из «Как нельзя» (не запрет)
-- Одинаковые русские термины — с учётом заглавных букв: «Данные» и «данные» — разные термины
create or replace function ru_case_key(t text) returns text language sql immutable parallel safe as $$
  select regexp_replace(replace(replace(coalesce(t, ''), 'ё', 'е'), 'Ё', 'Е'), '[[:space:]]+', '', 'g')
$$;

create or replace function duplicate_warnings(p_ru text, p_tr jsonb, p_excl_term int default null, p_excl_req int default null)
returns text[] language plpgsql stable as $$
declare outv text[] := '{}'; v_key text := norm_term(p_ru); r record; l text; v text;
begin
  if v_key <> '' then
    for r in select t.tb, t.ru, t.definition, t.status from terms t where t.ru_norm = v_key and (p_excl_term is null or t.id <> p_excl_term) order by t.tb loop
      outv := outv || ('Русский термин уже есть: ' || r.tb || ' «' || r.ru || '»' ||
        case when r.definition <> '' then ' (' || left(r.definition, 80) || ')' else '' end || case when r.status = 'archived' then ' — в архиве' else '' end);
    end loop;
    for r in select q.code, q.ru from requests q where q.status = 'pending' and q.type = 'new' and norm_term(q.ru) = v_key
               and (p_excl_req is null or q.id <> p_excl_req) loop
      outv := outv || ('Такой термин уже предложен в заявке ' || r.code || ' «' || r.ru || '»');
    end loop;
  end if;
  for l in select jsonb_object_keys(coalesce(p_tr, '{}'::jsonb)) loop
    foreach v in array split_variants(p_tr->>l) loop
      for r in select distinct t.tb, t.ru from translations x join terms t on t.id = x.term_id
                where x.lang = l and x.status <> 'obsolete' and x.text_norm = norm_term(v)
                  and (p_excl_term is null or t.id <> p_excl_term) and t.ru_norm <> coalesce(nullif(v_key, ''), chr(1))
                order by t.tb loop
        outv := outv || ('Перевод ' || l || ' «' || v || '» уже используется у другого термина: ' || r.tb || ' «' || r.ru || '»');
      end loop;
      for r in select t.tb, f->>'text' as bad, live_text(t.id, l) as good from term_langs tl join terms t on t.id = tl.term_id,
                      jsonb_array_elements(tl.forbidden) f
                where tl.lang = l and norm_term(f->>'text') = norm_term(v) loop
        outv := outv || ('Вариант «' || r.bad || '» помечен как неправильный для ' || r.tb ||
          case when r.good <> '' then '. Правильно: «' || r.good || '»' else '' end);
      end loop;
    end loop;
  end loop;
  return array(select distinct x from unnest(outv) x);
end $$;

-- Языки, которые должны быть «Не актуально для языка», чтобы термин ушёл в архив:
-- все активные полные языки и сокращённые, где у термина есть перевод.
create or replace function relevant_langs(p_term int) returns setof text language sql stable as $$
  select l.code from languages l where l.active and (l.kind = 'full'
    or exists (select 1 from translations x where x.term_id = p_term and x.lang = l.code and x.status <> 'obsolete'))
$$;

create or replace function check_auto_archive(u profiles, p_term int) returns boolean language plpgsql as $$
declare t terms; r record;
begin
  select * into t from terms where id = p_term;
  if t.status <> 'active' then return false; end if;
  if exists (select 1 from relevant_langs(p_term) l
              where not exists (select 1 from term_langs tl where tl.term_id = p_term and tl.lang = l and tl.unused)) then
    return false;
  end if;
  update terms set status = 'archived', archive_reason = 'all_unused' where id = p_term;
  perform bump_term(p_term, u.id);
  perform log_event(u, 'Термин ушёл в архив: все языки «Не актуально для языка»', t.tb, null, null, 'Действует', 'В архиве', t.ru);
  for r in select id, code from requests where term_id = p_term and type = 'obsolete' and status = 'pending' loop
    update requests set status = 'closed', decided_at = now(), version = version + 1 where id = r.id;
  end loop;
  return true;
end $$;

-- Видит ли валидатор/переводчик языка эту заявку
create or replace function request_for_lang(r requests, p_lang text) returns boolean language sql stable as $$
  select case
    when r.type = 'new' and r.lang is null then coalesce((select l.active and (case when r.target_langs is null then l.kind = 'full' else l.code = any(r.target_langs) end)
                                                           from languages l where l.code = p_lang), false)
    when r.type = 'new' and p_lang = 'EN' and not lang_has_validator(r.lang) then true
    when r.type = 'obsolete' then exists (select 1 from translations x where x.term_id = r.term_id and x.lang = p_lang and x.status <> 'obsolete')
      and not exists (select 1 from term_langs tl where tl.term_id = r.term_id and tl.lang = p_lang and tl.unused)
      and not exists (select 1 from request_answers a where a.request_id = r.id and a.lang = p_lang)
    else coalesce(r.lang = p_lang, false) end
$$;

-- язык валидатора, к которому относится заявка (у человека может быть несколько языков)
create or replace function validator_lang_for(u profiles, r requests) returns text language sql stable as $$
  select x from unnest(validator_langs(u)) x where request_for_lang(r, x) limit 1
$$;

-- Остальные заявки на замену того же перевода снимаются автоматически
create or replace function auto_remove_replacements(u profiles, p_term int, p_lang text, p_old int, p_except int) returns void language plpgsql as $$
declare o record;
begin
  for o in select q.id, q.code, q.translation from requests q
            where q.status = 'pending' and q.type = 'replace' and q.term_id = p_term and q.lang = p_lang
              and (p_except is null or q.id <> p_except)
              and (q.target_translation_id is null or q.target_translation_id = p_old)
            for update loop
    update requests set status = 'auto_removed', decided_by = u.id, decided_at = now(), version = version + 1 where id = o.id;
    perform log_event(u, 'Заявка снята автоматически', (select tb from terms where id = p_term), o.code, p_lang, o.translation, null, 'Перевод уже заменили');
  end loop;
end $$;

-- =====================================================================
-- API: пользователь
-- =====================================================================

create or replace function me() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  update profiles set last_seen = now() where id = u.id and (last_seen is null or last_seen < now() - interval '5 minutes');
  if u.avatar is null then
    update profiles set avatar = (array['cat','dog','fox','panda','bunny','raccoon','owl','frog','hamster','penguin','bear','corgi','hedgehog','capybara','duckling','tiger','squirrel','boar'])[1 + floor(random() * 18)::int]
     where id = u.id returning * into u;
  end if;
  return jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'role', u.role, 'lang', u.lang, 'avatar', u.avatar,
    'langs', coalesce((select jsonb_agg(jsonb_build_object('code', pl.lang, 'role', pl.role) order by (pl.role = 'validator') desc, case when pl.lang = 'EN' then 0 else 1 end, l.sort)
              from profile_langs pl join languages l on l.code = pl.lang where pl.profile_id = u.id and u.role in ('translator','validator')), '[]'),
    'contractor_no', u.contractor_no, 'prefs', u.prefs, 'is_en_validator', is_en_validator(u),
    'languages', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name, 'smartcat', l.smartcat_code, 'kind', l.kind,
                    'active', l.active, 'has_validator', lang_has_validator(l.code)) order by case when l.code = 'EN' then 0 else 1 end, l.sort, l.code), '[]') from languages l),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'closed', p.closed) order by p.name), '[]') from projects p));
end $$;

create or replace function set_prefs(p_prefs jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  update profiles set prefs = coalesce(p_prefs, '{}') where id = u.id;
end $$;

create or replace function set_avatar(p_avatar text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if p_avatar not in ('cat','dog','fox','panda','bunny','raccoon','owl','frog','hamster','penguin','bear','corgi','hedgehog','capybara','duckling','tiger','squirrel','boar') then
    perform app_error('Такого аватара нет.');
  end if;
  update profiles set avatar = p_avatar where id = u.id;
end $$;

-- Счётчик «Вас ждут» на главной
create or replace function dashboard() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); cards jsonb := '[]'; n int; l record;
begin
  -- по каждому языку человека; если языков несколько — в подписи код языка
  for l in select pl.lang, pl.role, lg.kind, count(*) over () as many from profile_langs pl join languages lg on lg.code = pl.lang
            where pl.profile_id = u.id and u.role in ('translator','validator')
            order by (pl.role = 'validator') desc, case when pl.lang = 'EN' then 0 else 1 end, lg.sort loop
    declare sfx text := case when l.many > 1 then ' · ' || l.lang else '' end; q text := 'lang=' || l.lang || '&';
    begin
      if l.kind = 'full' then
        select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, l.lang) = 'need';
        cards := cards || jsonb_build_object('key', 'need-' || l.lang, 'label', 'Нужен перевод' || sfx, 'count', n, 'link', 'work?' || q || 'tab=mine&status=need');
      end if;
      select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, l.lang) = 'draft';
      cards := cards || jsonb_build_object('key', 'draft-' || l.lang, 'label', case when l.role = 'validator' then 'Черновики на согласование' else 'Мои черновики ждут валидатора' end || sfx,
        'count', n, 'link', 'work?' || q || 'tab=mine&status=draft');
      if l.role = 'validator' then
        select count(*) into n from requests r where r.status = 'pending' and r.type <> 'obsolete' and request_for_lang(r, l.lang);
        cards := cards || jsonb_build_object('key', 'requests-' || l.lang, 'label', 'Заявки моего языка' || sfx, 'count', n, 'link', 'work?' || q || 'tab=requests');
        select count(*) into n from requests r where r.status = 'pending' and r.type = 'obsolete' and request_for_lang(r, l.lang);
        cards := cards || jsonb_build_object('key', 'obsolete-' || l.lang, 'label', 'Просьбы «Устарел»' || sfx, 'count', n, 'link', 'work?' || q || 'tab=requests');
        select count(*) into n from translations x join terms t on t.id = x.term_id where t.status = 'active' and x.lang = l.lang and x.status = 'unchecked';
        if n > 0 then cards := cards || jsonb_build_object('key', 'review-' || l.lang, 'label', 'На пересмотр' || sfx, 'count', n, 'link', 'work?' || q || 'tab=review'); end if;
      end if;
    end;
  end loop;
  if is_en_validator(u) then
    select count(*) into n from (select ru_case_key(ru) from terms where status = 'active' group by ru_case_key(ru) having count(*) > 1) d;
    cards := cards || jsonb_build_object('key', 'dupes', 'label', 'Одинаковые русские термины', 'count', n, 'link', 'glossary?dupes=1');
  end if;
  if u.role in ('manager','contractor','translator','validator') then
    select count(*) into n from requests r where r.author_id = u.id and r.status = 'pending';
    cards := cards || jsonb_build_object('key', 'mine', 'label', 'Мои заявки на рассмотрении', 'count', n, 'link', 'my-requests');
  end if;
  if u.role = 'contractor' then
    select count(*) into n from term_comments c where not c.hidden and c.author_id <> u.id
      and c.created_at > coalesce((u.prefs->>'seen_comments')::timestamptz, 'epoch'::timestamptz)
      and exists (select 1 from term_comments m where m.term_id = c.term_id and m.author_id = u.id);
    cards := cards || jsonb_build_object('key', 'answers', 'label', 'Ответы на мои комментарии', 'count', n, 'link', 'my-requests');
    for l in select code, name from languages where active and not lang_has_validator(code) order by sort loop
      select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, l.code) = 'need';
      cards := cards || jsonb_build_object('key', 'direct-' || l.code, 'label', 'Без перевода на ' || l.name || ' — можно вписать сразу', 'count', n, 'link', 'work?lang=' || l.code);
    end loop;
  end if;
  if u.role = 'manager' then
    for l in select code, name from languages where active and kind = 'full' order by case when code = 'EN' then 0 else 1 end, sort loop
      select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, l.code) = 'need';
      cards := cards || jsonb_build_object('key', 'need-' || l.code, 'label', 'Без перевода: ' || l.name, 'count', n, 'link', 'glossary?lang=' || l.code || '&mode=missing');
    end loop;
  end if;
  if u.role = 'owner' then
    select count(*) into n from languages lg where lg.active and not lang_has_validator(lg.code);
    cards := cards || jsonb_build_object('key', 'novalidator', 'label', 'Языки без валидатора', 'count', n, 'link', 'admin?tab=langs');
    select count(*) into n from translations x join terms t on t.id = x.term_id where t.status = 'active' and x.status = 'unchecked';
    cards := cards || jsonb_build_object('key', 'unchecked', 'label', 'Переводы «Без проверки»', 'count', n, 'link', 'admin?tab=langs');
    select count(*) into n from requests r where r.status = 'pending';
    cards := cards || jsonb_build_object('key', 'allrequests', 'label', 'Заявок на рассмотрении', 'count', n, 'link', 'log');
    select count(*) into n from feedback f where f.status = 'new';
    cards := cards || jsonb_build_object('key', 'feedback', 'label', 'Новые обращения в обратной связи', 'count', n, 'link', 'feedback');
  end if;
  -- ответы на обращения показываем, только когда они есть
  select count(*) into n from feedback f where f.author_id = u.id and not f.answer_seen;
  if n > 0 then cards := cards || jsonb_build_object('key', 'fb-answers', 'label', 'Ответы на ваши обращения', 'count', n, 'link', 'feedback'); end if;
  return cards;
end $$;

-- =====================================================================
-- API: обратная связь о сайте (вопросы, проблемы, идеи). Читает и отвечает владелец.
-- =====================================================================

create or replace function feedback_kind_label(k text) returns text language sql immutable as $$
  select case k when 'question' then 'Вопрос' when 'problem' then 'Проблема' else 'Идея' end
$$;

create or replace function submit_feedback(p_kind text, p_body text, p_page text default '') returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v text := btrim(coalesce(p_body, '')); v_id int;
begin
  if p_kind not in ('question','problem','idea') then perform app_error('Выберите: вопрос, проблема или идея.'); end if;
  if v = '' then perform app_error('Напишите, что случилось или что хотите предложить.'); end if;
  if length(v) > 5000 then perform app_error('Слишком длинно — до 5000 знаков. Разбейте на несколько сообщений.'); end if;
  insert into feedback(author_id, kind, body, page) values (u.id, p_kind, v, left(coalesce(p_page, ''), 200)) returning id into v_id;
  return v_id;
end $$;

create or replace function feedback_list(p_status text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'kind_label', feedback_kind_label(f.kind), 'body', f.body, 'page', f.page, 'status', f.status,
      'answer', f.answer, 'answered_at', f.answered_at, 'created_at', f.created_at, 'mine', f.author_id = u.id,
      'author', author_json(u, f.author_id), 'answered_by', case when f.answered_by is not null then display_name(u, f.answered_by) end,
      'unseen', f.author_id = u.id and not f.answer_seen)
    order by f.created_at desc), '[]')
  into v
  from feedback f
  where (is_owner(u) or f.author_id = u.id) and (p_status is null or f.status = p_status);
  -- автор открыл список — новые ответы прочитаны
  update feedback set answer_seen = true where author_id = u.id and not answer_seen;
  return v;
end $$;

create or replace function answer_feedback(p_id int, p_answer text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); f feedback; v text := btrim(coalesce(p_answer, ''));
begin
  if not is_owner(u) then perform app_error('Отвечать на обращения может владелец.'); end if;
  if p_status not in ('new','in_progress','done') then perform app_error('Неизвестный статус.'); end if;
  select * into f from feedback where id = p_id for update;
  if not found then perform app_error('Обращение не найдено.'); end if;
  update feedback set status = p_status, answer = v,
    answered_by = case when v <> f.answer then u.id else answered_by end,
    answered_at = case when v <> f.answer then now() else answered_at end,
    answer_seen = case when v <> f.answer and v <> '' and f.author_id <> u.id then false else answer_seen end
  where id = f.id;
end $$;

-- =====================================================================
-- API: поиск, глоссарий, карточка
-- =====================================================================

create or replace function search_match(t terms, q text) returns boolean language sql stable as $$
  select q is null or norm_term(q) = '' or t.ru_norm like '%' || norm_term(q) || '%' or upper(t.tb) like '%' || upper(btrim(q)) || '%'
      or exists (select 1 from translations x where x.term_id = t.id and x.status <> 'obsolete' and x.text_norm like '%' || norm_term(q) || '%')
      or exists (select 1 from term_langs tl, jsonb_array_elements(tl.forbidden) f where tl.term_id = t.id and norm_term(f->>'text') like '%' || norm_term(q) || '%')
$$;

-- Порядок результатов поиска: точное совпадение выше, чем «начинается с», и выше, чем «содержит»
create or replace function search_rank(t terms, q text) returns int language sql stable as $$
  select case
    when q is null or norm_term(q) = '' then 9
    when upper(t.tb) = upper(btrim(q)) or t.ru_norm = norm_term(q)
      or exists (select 1 from unnest(string_to_array(t.ru, '/')) p where norm_term(p) = norm_term(q)) then 0
    when exists (select 1 from translations x where x.term_id = t.id and x.status <> 'obsolete' and x.text_norm = norm_term(q)) then 1
    when t.ru_norm like norm_term(q) || '%'
      or exists (select 1 from unnest(string_to_array(t.ru, '/')) p where norm_term(p) like norm_term(q) || '%') then 2
    when exists (select 1 from translations x where x.term_id = t.id and x.status <> 'obsolete' and x.text_norm like norm_term(q) || '%') then 3
    when t.ru_norm like '%' || norm_term(q) || '%' then 4
    else 5 end
$$;

-- Ячейки языков для строки таблицы: {"KA": {"t": [...], "s": "approved", "f": true}, ...}
create or replace function lang_cells(p_term int) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(l.code, jsonb_build_object(
      't', coalesce((select jsonb_agg(x.text order by x.sort, x.id) from translations x
                      where x.term_id = p_term and x.lang = l.code and x.status in ('approved','unchecked')), '[]'),
      's', lang_status(p_term, l.code),
      'f', coalesce((select jsonb_array_length(tl.forbidden) > 0 from term_langs tl where tl.term_id = p_term and tl.lang = l.code), false),
      'c', coalesce((select tl.comment from term_langs tl where tl.term_id = p_term and tl.lang = l.code), ''))), '{}')
  from languages l where l.active
$$;

drop function if exists glossary_page(text, integer, text, text, integer, integer, boolean);
-- p_hide_unused: скрыть термины, которые «не актуально» для всех этих языков (свои языки человека или показанные столбцы)
create or replace function glossary_page(p_q text default null, p_project int default null, p_lang text default null,
  p_mode text default 'any', p_page int default 1, p_size int default 100, p_dupes boolean default false, p_hide_unused text[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_total int; v_items jsonb; v_size int := least(greatest(p_size, 10), 5000);
begin
  with base as (
    select t.*, search_rank(t, p_q) as rnk from terms t
     where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))
       and (p_mode = 'any' or p_lang is null or
            (p_mode = 'has') = exists (select 1 from translations x where x.term_id = t.id and x.lang = p_lang and x.status in ('approved','unchecked')))
       and (cardinality(coalesce(p_hide_unused, '{}')) = 0
            -- скрываем, только если термин «не актуально» для всех этих языков
            or exists (select 1 from unnest(p_hide_unused) hl
                        where not coalesce((select tl.unused from term_langs tl where tl.term_id = t.id and tl.lang = hl), false)))
       and (not p_dupes or exists (select 1 from terms d where d.status = 'active' and d.ru_norm = t.ru_norm and ru_case_key(d.ru) = ru_case_key(t.ru) and d.id <> t.id))
       and search_match(t, p_q)
  ), pg as (select * from base order by rnk, lower(ru), tb limit v_size offset (greatest(p_page, 1) - 1) * v_size)
  select (select count(*) from base), coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'tb', pg.tb, 'ru', pg.ru, 'version', pg.version,
      'definition', pg.definition, 'examples', pg.examples, 'comment', pg.comment,
      'projects', coalesce((select jsonb_agg(pr.name order by pr.name) from term_projects tp join projects pr on pr.id = tp.project_id where tp.term_id = pg.id), '[]'),
      'cells', lang_cells(pg.id),
      'replaced', coalesce((select jsonb_agg(jsonb_build_object('lang', o.lang, 'old', o.text, 'new', n.text, 'at', o.obsolete_at) order by o.obsolete_at)
               from translations o join translations n on n.id = o.replaced_by where o.term_id = pg.id and o.status = 'obsolete'), '[]'),
      'obsolete_request', (select jsonb_build_object('code', r.code, 'reason', r.reason) from requests r
               where r.term_id = pg.id and r.type = 'obsolete' and r.status = 'pending' limit 1),
      'forbidden_hit', case when norm_term(p_q) <> '' then (select jsonb_agg(jsonb_build_object('lang', tl.lang, 'text', f->>'text', 'good', live_text(pg.id, tl.lang)))
               from term_langs tl, jsonb_array_elements(tl.forbidden) f where tl.term_id = pg.id and norm_term(f->>'text') like '%' || norm_term(p_q) || '%') end
    ) order by pg.rnk, lower(pg.ru), pg.tb), '[]')
  into v_total, v_items from pg;
  return jsonb_build_object('items', v_items, 'total', v_total, 'page', greatest(p_page, 1), 'pages', greatest(1, ceil(v_total::numeric / v_size)));
end $$;

create or replace function recent_terms(p_limit int default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'tb', t.tb, 'ru', t.ru, 'definition', t.definition, 'created_at', t.created_at, 'cells', lang_cells(t.id))
     order by t.created_at desc) from (select * from terms where status = 'active' order by created_at desc, id desc limit least(p_limit, 50)) t), '[]');
end $$;

-- Карточка термина: всё, что нужно для показа, и какие действия доступны этому пользователю
create or replace function term_card(p_id int default null, p_tb text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms;
begin
  if p_id is not null then select * into t from terms where id = p_id;
  else select * into t from terms where tb = upper(btrim(p_tb)); end if;
  if not found then return null; end if;
  if t.status = 'archived' and u.role not in ('owner','validator') then return null; end if;
  return jsonb_build_object(
    'id', t.id, 'tb', t.tb, 'ru', t.ru, 'definition', t.definition, 'examples', t.examples, 'comment', t.comment,
    'status', t.status, 'archive_reason', t.archive_reason, 'version', t.version,
    'created_at', t.created_at, 'created_by', display_name(u, t.created_by), 'updated_at', t.updated_at, 'updated_by', display_name(u, t.updated_by),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name) order by pr.name) from term_projects tp join projects pr on pr.id = tp.project_id where tp.term_id = t.id), '[]'),
    'can', jsonb_build_object(
      'edit_ru', can_edit_ru(u) and t.status = 'active',
      'merge', is_en_validator(u) and t.status = 'active',
      'propose_obsolete', u.role in ('manager','validator') and t.status = 'active',
      'archive', is_owner(u) and t.status = 'active',
      'restore', (is_owner(u) or is_en_validator(u)) and t.status = 'archived',
      'delete', is_owner(u) or is_en_validator(u),
      'comment', u.role <> 'reader',
      'hide_comment', is_owner(u) or is_en_validator(u)),
    'langs', (select jsonb_agg(jsonb_build_object(
        'code', l.code, 'name', l.name, 'kind', l.kind, 'has_validator', lang_has_validator(l.code),
        'status', lang_status(t.id, l.code),
        'comment', coalesce(tl.comment, ''), 'optional', coalesce(tl.optional, false),
        'forbidden', coalesce(tl.forbidden, '[]'), 'draft', tl.draft, 'unused', coalesce(tl.unused, false),
        'live', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'text', x.text, 'status', x.status, 'sort', x.sort) order by x.sort, x.id)
                 from translations x where x.term_id = t.id and x.lang = l.code and x.status <> 'obsolete'), '[]'),
        'history', coalesce((select jsonb_agg(jsonb_build_object('text', o.text, 'replaced_by', n.text, 'at', o.obsolete_at) order by o.obsolete_at desc)
                 from translations o left join translations n on n.id = o.replaced_by where o.term_id = t.id and o.lang = l.code and o.status = 'obsolete'), '[]'),
        'can', jsonb_build_object(
          'type', t.status = 'active' and (works_lang(u, l.code) or contractor_direct(u, l.code)),
          'approve', t.status = 'active' and is_validator_of(u, l.code),
          'edit', t.status = 'active' and (is_validator_of(u, l.code) or contractor_direct(u, l.code)),
          'request', t.status = 'active' and u.role in ('contractor','translator') and l.code = any(propose_langs(u)) and not contractor_direct(u, l.code),
          'unused', t.status = 'active' and is_validator_of(u, l.code),
          'optional', t.status = 'active' and (can_edit_ru(u) or is_validator_of(u, l.code)),
          'fields', t.status = 'active' and (works_lang(u, l.code) or is_en_validator(u) or contractor_direct(u, l.code)))
      ) order by case when l.code = 'EN' then 0 else 1 end, l.sort, l.code)
      from languages l left join term_langs tl on tl.term_id = t.id and tl.lang = l.code where l.active),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'type', req_type_label(r.type), 'lang', r.lang,
                 'translation', r.translation, 'reason', r.reason, 'author', author_json(u, r.author_id)) order by r.created_at)
               from requests r where r.term_id = t.id and r.status = 'pending' and r.type <> 'obsolete'
                 and (u.role not in ('contractor','reader') or r.author_id = u.id)), '[]'),
    'obsolete_request', (select jsonb_build_object('id', r.id, 'code', r.code, 'reason', r.reason, 'author', author_json(u, r.author_id),
                 'can_close', r.author_id = u.id, 'can_answer', validator_lang_for(u, r) is not null,
                 'answers', coalesce((select jsonb_agg(jsonb_build_object('lang', a.lang, 'answer', a.answer, 'comment', a.comment, 'author', author_json(u, a.author_id)))
                   from request_answers a where a.request_id = r.id), '[]'))
               from requests r where r.term_id = t.id and r.type = 'obsolete' and r.status = 'pending' limit 1),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'author', author_json(u, c.author_id), 'body', c.body, 'at', c.created_at, 'mine', c.author_id = u.id)
                 order by c.created_at) from term_comments c where c.term_id = t.id and not c.hidden), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'user', display_name(u, a.user_id), 'action', a.action, 'lang', a.lang,
                 'before', a.before, 'after', a.after, 'details', a.details) order by a.at desc, a.id desc)
               from (select * from audit_log a where a.tb = t.tb
                       or a.request_code in (select code from requests where requests.term_id = t.id)
                     order by at desc, id desc limit 300) a), '[]'));
end $$;

-- =====================================================================
-- API: заявки
-- =====================================================================

create or replace function similar_terms(p_ru text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_key text := norm_term(p_ru);
begin
  if length(v_key) < 2 then return '[]'; end if;
  return coalesce((select jsonb_agg(x) from (
    select t.id, t.tb, t.ru, t.definition, t.status, (t.ru_norm = v_key) as exact from terms t
     where t.ru_norm = v_key or t.ru_norm like '%' || v_key || '%' or (length(v_key) >= 4 and t.ru_norm % v_key)
     order by (t.ru_norm = v_key) desc, similarity(t.ru_norm, v_key) desc, t.ru limit 8) x), '[]');
end $$;

create or replace function check_duplicates(p_ru text, p_tr jsonb, p_term int default null) returns text[]
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  return duplicate_warnings(p_ru, p_tr, p_term, null);
end $$;

-- Подача. Типы: new (новый термин), translation (перевод к термину), variant, replace.
-- Свой язык (переводчик/валидатор) и подрядчик на языке без валидатора — сразу, без заявки
-- (кроме замены у переводчика: её принимает валидатор).
create or replace function submit_request(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u profiles := app_profile();
  v_type text := p_input->>'type';
  v_lang text := nullif(upper(btrim(coalesce(p_input->>'lang', ''))), '');
  v_tr text := btrim(coalesce(p_input->>'translation', ''));
  v_reason text := btrim(coalesce(p_input->>'reason', ''));
  v_ru text; v_one text; v_term int; v_target int; t terms; v_matches jsonb; v_warn text[]; v_code text; v_req int;
  v_projects int[]; v_fields jsonb := coalesce(p_input->'lang_fields', '{}'); v_old translations; v_new translations; v_status text;
  v_direct boolean; v_targets text[];
begin
  if u.role = 'reader' then perform app_error('Читатель не может предлагать термины.'); end if;
  if v_lang is not null then
    if not v_lang = any(propose_langs(u)) then
      if u.role in ('manager','owner') then perform app_error('Менеджер предлагает только русскую часть, переводы добавят переводчики.'); end if;
      perform app_error('Перевод на ' || lang_name(v_lang) || ' может предложить только переводчик или валидатор ' || lang_gen(v_lang) || '.');
    end if;
    if not exists (select 1 from languages l where l.code = v_lang and l.active) then perform app_error('Этот язык выключен.'); end if;
  else
    v_tr := '';
  end if;
  v_projects := array(select p.id from projects p where not p.closed and p.id = any(
    coalesce(array(select (x)::int from jsonb_array_elements_text(coalesce(p_input->'project_ids', '[]')) x), '{}')));

  if v_type = 'new' then
    v_ru := btrim(coalesce(p_input->>'ru', ''));
    if v_ru = '' then perform app_error('Впишите русский термин.'); end if;
    select jsonb_agg(jsonb_build_object('id', x.id, 'tb', x.tb, 'ru', x.ru, 'definition', x.definition) order by x.tb) into v_matches
      from terms x where x.ru_norm = norm_term(v_ru) and x.status = 'active';
    if v_matches is not null then
      if nullif(p_input->>'same_as', '') is not null then
        -- «Это тот же смысл» — значит, это перевод к существующему термину
        if v_lang is null or v_tr = '' then
          perform app_error('Такой термин уже есть. Чтобы добавить к нему перевод, выберите язык и впишите перевод.');
        end if;
        return submit_request(p_input || jsonb_build_object('type', 'translation', 'term_id', p_input->>'same_as'));
      end if;
      if coalesce((p_input->>'new_meaning')::boolean, false) is not true then
        return jsonb_build_object('status', 'repeat', 'matches', v_matches);
      end if;
      if btrim(coalesce(p_input->>'definition', '')) = '' then
        perform app_error('Это другой смысл того же слова — заполните «Определение», чтобы их различать.');
      end if;
    end if;
    v_warn := duplicate_warnings(v_ru, case when v_lang is not null and v_tr <> '' then jsonb_build_object(v_lang, v_tr) else '{}'::jsonb end, null, null);
    v_code := 'Z-' || lpad(nextval('req_seq')::text, 5, '0');
    -- менеджер выбирает языки, на которые нужен перевод; остальные получат «по желанию»
    if v_lang is null and p_input ? 'target_langs' and jsonb_typeof(p_input->'target_langs') = 'array' then
      v_targets := array(select l.code from languages l where l.active and l.code in (select jsonb_array_elements_text(p_input->'target_langs')));
      if cardinality(v_targets) = 0 then perform app_error('Отметьте хотя бы один язык перевода.'); end if;
    end if;
    insert into requests(code, type, ru, definition, examples, comment, project_ids, lang, translation, lang_fields, warnings, author_id, target_langs)
    values (v_code, 'new', v_ru, btrim(coalesce(p_input->>'definition', '')), btrim(coalesce(p_input->>'examples', '')),
            btrim(coalesce(p_input->>'comment', '')), v_projects, v_lang, v_tr, v_fields, v_warn, u.id, v_targets)
    returning id into v_req;
    if v_lang is not null and v_tr <> '' then
      insert into request_translations(request_id, lang, text, author_id) values (v_req, v_lang, v_tr, u.id);
    end if;
    perform log_event(u, 'Подана заявка', null, v_code, v_lang, null, nullif(v_tr, ''), 'Новый термин «' || v_ru || '»');
    return jsonb_build_object('status', 'submitted', 'code', v_code, 'type', req_type_label('new'), 'warnings', to_jsonb(v_warn));
  end if;

  if v_type not in ('translation','variant','replace') then perform app_error('Неизвестный тип заявки.'); end if;
  v_term := nullif(p_input->>'term_id', '')::int;
  select * into t from terms where id = v_term for update;
  if not found then perform app_error('Выберите термин.'); end if;
  if t.status <> 'active' then perform app_error('Этот термин в архиве.'); end if;
  if v_lang is null then perform app_error('Выберите язык перевода.'); end if;
  if v_tr = '' then perform app_error('Впишите перевод.'); end if;
  if v_type in ('variant','replace') and v_reason = '' then perform app_error('Укажите причину.'); end if;
  if v_type = 'translation' and exists (select 1 from translations x where x.term_id = t.id and x.lang = v_lang and x.status <> 'obsolete') then
    perform app_error('У термина уже есть перевод на ' || lang_name(v_lang) || '. Чтобы его поменять, нажмите «Заменить» рядом с переводом.');
  end if;
  if v_type = 'replace' then
    select x.id into v_target from translations x where x.term_id = t.id and x.lang = v_lang and x.status <> 'obsolete'
       and (nullif(p_input->>'target_id', '') is null or x.id = (p_input->>'target_id')::int) order by x.sort, x.id limit 1;
    if v_target is null then perform app_error('Перевод, который вы хотите заменить, уже изменился. Обновите страницу.'); end if;
  end if;

  v_direct := (works_lang(u, v_lang) or contractor_direct(u, v_lang)) and not (v_type = 'replace' and u.role = 'translator');
  if v_direct then
    v_status := case when contractor_direct(u, v_lang) then 'unchecked' when is_validator_of(u, v_lang) then 'approved' else 'draft' end;
    if v_type = 'replace' then
      select * into v_old from translations where id = v_target;
      v_new := add_translation(t.id, v_lang, (split_variants(v_tr))[1], v_status, u.id, v_old.sort);
      update translations set status = 'obsolete', obsolete_at = now(), replaced_by = v_new.id where id = v_old.id;
      perform log_event(u, 'Замена перевода', t.tb, null, v_lang, v_old.text, v_new.text, 'Причина: ' || v_reason);
      perform auto_remove_replacements(u, t.id, v_lang, v_old.id, null);
      perform bump_term(t.id, u.id);
      return jsonb_build_object('status', 'added', 'message', 'Перевод заменён.');
    end if;
    foreach v_one in array split_variants(v_tr) loop
      perform add_translation(t.id, v_lang, v_one, v_status, u.id);
    end loop;
    if v_fields <> '{}'::jsonb then perform apply_lang_fields(t.id, v_lang, v_fields); end if;
    perform log_event(u, case when v_type = 'variant' then 'Добавлен вариант перевода' else 'Добавлен перевод' end, t.tb, null, v_lang, null, v_tr,
      case v_status when 'draft' then 'Черновик' when 'unchecked' then 'Без проверки' else 'Согласовано' end ||
      case when v_reason <> '' then '; причина: ' || v_reason else '' end);
    perform bump_term(t.id, u.id);
    return jsonb_build_object('status', 'added', 'message',
      case v_status when 'draft' then 'Перевод сохранён как черновик — его согласует валидатор.'
                    when 'unchecked' then 'Перевод добавлен со статусом «Без проверки».' else 'Перевод добавлен и согласован.' end);
  end if;

  v_warn := duplicate_warnings('', jsonb_build_object(v_lang, v_tr), t.id, null);
  v_code := 'Z-' || lpad(nextval('req_seq')::text, 5, '0');
  insert into requests(code, type, term_id, target_translation_id, ru, lang, translation, lang_fields, reason, warnings, author_id)
  values (v_code, v_type, t.id, v_target, t.ru, v_lang, v_tr, v_fields, v_reason, v_warn, u.id);
  perform log_event(u, 'Подана заявка', t.tb, v_code, v_lang, null, v_tr, req_type_label(v_type) || ' «' || t.ru || '»');
  return jsonb_build_object('status', 'submitted', 'code', v_code, 'type', req_type_label(v_type), 'warnings', to_jsonb(v_warn));
end $$;

-- Переводчик или валидатор языка вписывает перевод в заявку на новый термин
create or replace function set_request_translation(p_request int, p_lang text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests; v text := btrim(coalesce(p_text, ''));
begin
  select * into r from requests where id = p_request for update;
  if not found or r.status <> 'pending' then perform app_error('Заявка уже рассмотрена или не найдена. Обновите страницу.'); end if;
  if r.type <> 'new' then perform app_error('Перевод вписывается только в заявку на новый термин.'); end if;
  if not works_lang(u, p_lang) then perform app_error('Вписать перевод на ' || lang_name(p_lang) || ' может переводчик или валидатор ' || lang_gen(p_lang) || '.'); end if;
  if not request_for_lang(r, p_lang) then perform app_error('Эта заявка не для вашего языка.'); end if;
  if v = '' then
    delete from request_translations where request_id = r.id and lang = p_lang;
  else
    insert into request_translations(request_id, lang, text, author_id) values (r.id, p_lang, v, u.id)
    on conflict (request_id, lang) do update set text = excluded.text, author_id = excluded.author_id, updated_at = now();
  end if;
  update requests set version = version + 1 where id = r.id returning * into r;
  perform log_event(u, 'Вписан перевод в заявку', null, r.code, p_lang, null, nullif(v, ''));
  return jsonb_build_object('version', r.version);
end $$;

create or replace function edit_request(p_request int, p_input jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  select * into r from requests where id = p_request for update;
  if not found then perform app_error('Заявка не найдена.'); end if;
  if r.author_id <> u.id then perform app_error('Исправлять заявку может только её автор.'); end if;
  if r.status <> 'pending' then perform app_error('Заявку уже рассмотрели — исправить нельзя.'); end if;
  update requests set
    ru = case when r.type = 'new' and coalesce(btrim(p_input->>'ru'), '') <> '' then btrim(p_input->>'ru') else ru end,
    definition = coalesce(btrim(p_input->>'definition'), definition), examples = coalesce(btrim(p_input->>'examples'), examples),
    comment = coalesce(btrim(p_input->>'comment'), comment),
    translation = coalesce(btrim(p_input->>'translation'), translation), reason = coalesce(btrim(p_input->>'reason'), reason),
    version = version + 1
  where id = r.id;
  if r.type = 'new' and r.lang is not null and p_input ? 'translation' then
    insert into request_translations(request_id, lang, text, author_id) values (r.id, r.lang, btrim(p_input->>'translation'), u.id)
    on conflict (request_id, lang) do update set text = excluded.text, updated_at = now();
  end if;
  perform log_event(u, 'Заявка исправлена автором', null, r.code);
end $$;

-- Утверждение заявки валидатором. Если есть возможные дубли и p_force=false — вернёт их на подтверждение.
create or replace function approve_request(p_request int, p_version int, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u profiles := app_profile(); r requests; t terms; v_warn text[]; v_tb text; v_term int; v text; i int; rt record;
  v_tr text; v_status text; v_old translations; v_new translations; v_ru_only boolean := false; v_chk jsonb; v_l text;
begin
  select * into r from requests where id = p_request for update;
  if not found then perform app_error('Заявка не найдена. Обновите страницу.'); end if;
  if r.status <> 'pending' then perform app_error('Заявка ' || r.code || ': решение уже принято.'); end if;
  if r.version <> p_version then perform conflict_error(); end if;
  if u.role <> 'validator' then perform app_error('Утверждать заявки может только валидатор языка.'); end if;
  if r.type = 'obsolete' then perform app_error('На просьбу «Устарел» отвечают «Не актуально для языка» или «Оставить».'); end if;

  if r.type = 'new' then
    v_l := validator_lang_for(u, r);
    if v_l is null then
      perform app_error('Эту заявку утверждает валидатор ' || coalesce(lang_gen(r.lang), 'другого языка') || '.');
    end if;
    -- Язык заявки без валидатора: русскую часть утверждает валидатор английского, перевод — «Без проверки»
    v_ru_only := r.lang is not null and r.lang <> v_l and not lang_has_validator(r.lang) and is_en_validator(u);
    select text into v_tr from request_translations where request_id = r.id and lang = v_l;
    if not v_ru_only and coalesce(v_tr, '') = '' then
      perform app_error('Заявка ' || r.code || ': нет перевода на ' || lang_name(v_l) || '. Впишите перевод, затем утвердите.');
    end if;
    select coalesce(jsonb_object_agg(x.lang, x.text), '{}'::jsonb) into v_chk from request_translations x where x.request_id = r.id;
    v_warn := duplicate_warnings(r.ru, v_chk, null, r.id);
    if array_length(v_warn, 1) > 0 and not p_force then
      return jsonb_build_object('status', 'confirm', 'code', r.code, 'warnings', to_jsonb(v_warn));
    end if;
    v_tb := 'TB-' || lpad(nextval('tb_seq')::text, 5, '0');
    insert into terms(tb, ru, definition, examples, comment, created_by, updated_by)
    values (v_tb, r.ru, r.definition, r.examples, r.comment, u.id, u.id) returning id into v_term;
    if r.target_langs is not null then
      insert into term_langs(term_id, lang, optional)
      select v_term, l.code, true from languages l where not l.code = any(r.target_langs)
      on conflict (term_id, lang) do update set optional = true;
    end if;
    insert into term_projects select v_term, p.id from projects p where p.id = any(r.project_ids);
    for rt in select * from request_translations x where x.request_id = r.id loop
      v_status := case when rt.lang = v_l then 'approved' when not lang_has_validator(rt.lang) then 'unchecked' else 'draft' end;
      i := 1;
      foreach v in array split_variants(rt.text) loop
        perform add_translation(v_term, rt.lang, v, v_status, rt.author_id, i);
        i := i + 1;
      end loop;
      if v_status = 'approved' then update translations set approved_by = u.id where term_id = v_term and lang = rt.lang; end if;
    end loop;
    if r.lang is not null and r.lang_fields <> '{}'::jsonb then perform apply_lang_fields(v_term, r.lang, r.lang_fields); end if;
    update requests set status = 'approved', term_id = v_term, decided_by = u.id, decided_at = now(), version = version + 1 where id = r.id;
    perform log_event(u, 'Заявка утверждена — создан термин', v_tb, r.code, v_l, null, v_tr,
      '«' || r.ru || '»' || case when array_length(v_warn, 1) > 0 then '; дубли проверены: ' || array_to_string(v_warn, ' | ') else '' end);
    return jsonb_build_object('status', 'approved', 'code', r.code, 'tb', v_tb, 'message', r.code || ' → ' || v_tb || ' «' || r.ru || '»');
  end if;

  -- перевод / вариант / замена
  if not is_validator_of(u, r.lang) then
    perform app_error('Решение по этой заявке принимает валидатор ' || lang_gen(r.lang) || '.');
  end if;
  select * into t from terms where id = r.term_id for update;
  if not found then perform app_error('Заявка ' || r.code || ': термин был удалён.'); end if;
  if t.status <> 'active' then perform app_error('Термин ' || t.tb || ' в архиве.'); end if;
  v_tr := btrim(r.translation);
  v_warn := duplicate_warnings('', jsonb_build_object(r.lang, v_tr), t.id, null);
  if array_length(v_warn, 1) > 0 and not p_force then
    return jsonb_build_object('status', 'confirm', 'code', r.code, 'warnings', to_jsonb(v_warn));
  end if;
  if r.type in ('translation','variant') then
    if r.type = 'translation' and exists (select 1 from translations x where x.term_id = t.id and x.lang = r.lang and x.status <> 'obsolete') then
      perform app_error('У термина уже появился перевод на ' || lang_name(r.lang) || '. Отклоните заявку или предложите замену.');
    end if;
    foreach v in array split_variants(v_tr) loop perform add_translation(t.id, r.lang, v, 'approved', u.id); end loop;
    if r.lang_fields <> '{}'::jsonb then perform apply_lang_fields(t.id, r.lang, r.lang_fields); end if;
    perform log_event(u, case when r.type = 'variant' then 'Добавлен вариант перевода' else 'Добавлен перевод' end, t.tb, r.code, r.lang, null, v_tr,
      case when r.reason <> '' then 'Причина: ' || r.reason end);
  else
    select * into v_old from translations x where x.id = r.target_translation_id and x.status <> 'obsolete';
    if v_old.id is null then
      select * into v_old from translations x where x.term_id = t.id and x.lang = r.lang and x.status <> 'obsolete' order by x.sort, x.id limit 1;
    end if;
    v_new := add_translation(t.id, r.lang, (split_variants(v_tr))[1], 'approved', u.id, coalesce(v_old.sort, 1));
    if v_old.id is not null then
      update translations set status = 'obsolete', obsolete_at = now(), replaced_by = v_new.id where id = v_old.id;
    end if;
    perform log_event(u, 'Замена перевода', t.tb, r.code, r.lang, coalesce(v_old.text, ''), v_new.text, 'Причина: ' || r.reason);
    perform auto_remove_replacements(u, t.id, r.lang, v_old.id, r.id);
  end if;
  perform bump_term(t.id, u.id);
  update requests set status = 'approved', decided_by = u.id, decided_at = now(), version = version + 1 where id = r.id;
  perform log_event(u, 'Заявка утверждена', t.tb, r.code, r.lang, null, v_tr, req_type_label(r.type));
  return jsonb_build_object('status', 'approved', 'code', r.code, 'tb', t.tb,
    'message', r.code || ' → ' || lower(req_type_label(r.type)) || ' ' || r.lang || ' для ' || t.tb || ' «' || t.ru || '»');
end $$;

create or replace function reject_request(p_request int, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  select * into r from requests where id = p_request for update;
  if not found then perform app_error('Заявка не найдена. Обновите страницу.'); end if;
  if r.status <> 'pending' then perform app_error('Заявка ' || r.code || ': решение уже принято.'); end if;
  if r.version <> p_version then perform conflict_error(); end if;
  if r.type = 'obsolete' then perform app_error('Просьбу «Устарел» закрывает её автор.'); end if;
  if validator_lang_for(u, r) is null then
    perform app_error('Отклонить эту заявку может только валидатор ' || coalesce(lang_gen(r.lang), 'языка') || '.');
  end if;
  update requests set status = 'rejected', decided_by = u.id, decided_at = now(), version = version + 1 where id = r.id;
  perform log_event(u, 'Заявка отклонена', (select tb from terms where id = r.term_id), r.code, r.lang, null, null, req_type_label(r.type) || ' «' || r.ru || '»');
end $$;

create or replace function request_json(viewer profiles, r requests) returns jsonb language sql stable as $$
  select jsonb_build_object('id', r.id, 'code', r.code, 'type', r.type, 'type_label', req_type_label(r.type), 'status', r.status,
    'status_label', req_status_label(r.status), 'ru', r.ru, 'definition', r.definition, 'examples', r.examples,
    'comment', r.comment, 'target_langs', to_jsonb(r.target_langs),
    'can_withdraw', r.author_id = viewer.id and r.status = 'pending'
      and not exists (select 1 from request_translations rt where rt.request_id = r.id and rt.author_id is distinct from r.author_id)
      and not exists (select 1 from request_answers a where a.request_id = r.id), 'lang', r.lang, 'translation', r.translation, 'lang_fields', r.lang_fields, 'reason', r.reason, 'warnings', to_jsonb(r.warnings),
    'author', author_json(viewer, r.author_id), 'mine', r.author_id = viewer.id, 'created_at', r.created_at,
    'decided_by', case when r.decided_by is not null then display_name(viewer, r.decided_by) end, 'decided_at', r.decided_at, 'version', r.version, 'term_id', r.term_id,
    'tb', (select tb from terms where id = r.term_id),
    'target_text', (select text from translations where id = r.target_translation_id),
    'projects', coalesce((select jsonb_agg(name order by name) from projects where id = any(r.project_ids)), '[]'),
    'translations', coalesce((select jsonb_object_agg(rt.lang, rt.text) from request_translations rt where rt.request_id = r.id), '{}'),
    'comments', (select count(*) from request_comments c where c.request_id = r.id))
$$;

-- Заявки и просьбы для «Рабочей области» языка
create or replace function lang_requests(p_lang text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if not (works_lang(u, p_lang) or is_owner(u)) then perform app_error('Заявки языка видят его переводчик и валидатор.'); end if;
  return coalesce((select jsonb_agg(request_json(u, r) || jsonb_build_object(
      'can_approve', is_validator_of(u, p_lang) and r.type <> 'obsolete',
      'can_answer', is_validator_of(u, p_lang) and r.type = 'obsolete',
      'ru_only', r.type = 'new' and r.lang is not null and r.lang <> p_lang and not lang_has_validator(r.lang) and p_lang = 'EN')
    order by r.created_at) from requests r where r.status = 'pending' and request_for_lang(r, p_lang)), '[]');
end $$;

create or replace function my_requests() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  update profiles set prefs = prefs || jsonb_build_object('seen_comments', now()) where id = u.id;
  return coalesce((select jsonb_agg(request_json(u, r) order by r.created_at desc)
    from (select * from requests where author_id = u.id order by created_at desc limit 500) r), '[]');
end $$;

create or replace function can_see_request(u profiles, r requests) returns boolean language sql stable as $$
  select is_owner(u) or u.role = 'manager' or r.author_id = u.id or exists (select 1 from unnest(work_langs(u)) x where request_for_lang(r, x))
$$;

-- Все заявки (для менеджеров и владельца). p_status: pending | done | all
create or replace function all_requests(p_status text default 'pending', p_q text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if u.role not in ('owner','manager') then perform app_error('Все заявки видят менеджеры и владелец.'); end if;
  return coalesce((select jsonb_agg(request_json(u, r) order by r.created_at desc) from (
    select * from requests r
     where case p_status when 'pending' then r.status = 'pending' when 'done' then r.status <> 'pending' else true end
       and (p_q is null or btrim(p_q) = '' or norm_term(r.ru) like '%' || norm_term(p_q) || '%' or upper(r.code) like '%' || upper(btrim(p_q)) || '%')
     order by r.created_at desc limit 2000) r), '[]');
end $$;

create or replace function add_request_comment(p_request int, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  if btrim(coalesce(p_body, '')) = '' then perform app_error('Комментарий пустой.'); end if;
  select * into r from requests where id = p_request;
  if not found or not can_see_request(u, r) then perform app_error('Комментировать эту заявку могут её автор, переводчики и валидатор языка.'); end if;
  insert into request_comments(request_id, author_id, body) values (r.id, u.id, btrim(p_body));
  perform log_event(u, 'Комментарий к заявке', null, r.code, r.lang, null, btrim(p_body));
end $$;

create or replace function list_request_comments(p_request int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  select * into r from requests where id = p_request;
  if not found or not can_see_request(u, r) then perform app_error('Нет доступа к этой заявке.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'author', author_json(u, c.author_id), 'body', c.body, 'at', c.created_at) order by c.created_at)
    from request_comments c where c.request_id = r.id), '[]');
end $$;

-- =====================================================================
-- API: работа с переводами своего языка
-- =====================================================================

create or replace function can_type(u profiles, p_lang text) returns boolean language sql stable as $$
  select works_lang(u, p_lang) or contractor_direct(u, p_lang)
$$;

-- Ввод в ячейку. Переводчик и валидатор — черновик; подрядчик на языке без валидатора — «Без проверки».
-- Согласованный перевод в ячейке изменить нельзя (для этого «Изменить» или «Заменить»).
create or replace function set_cell_text(p_term int, p_lang text, p_text text, p_version int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u profiles := app_profile(); t terms; v_items text[] := split_variants(p_text); v_keys text[]; x translations;
  v_changed boolean := false; v text; v_existing text[]; v_ids int[]; v_sorts int[]; i int;
  v_status text;
begin
  if not can_type(u, p_lang) then
    perform app_error('Переводить на ' || lang_name(p_lang) || ' может только переводчик или валидатор ' || lang_gen(p_lang) || '.');
  end if;
  v_status := case when contractor_direct(u, p_lang) then 'unchecked' else 'draft' end;
  select * into t from terms where id = p_term for update;
  if not found then perform app_error('Термин не найден — возможно, его удалили. Обновите страницу.'); end if;
  if t.status <> 'active' then perform app_error('Термин в архиве.'); end if;
  if exists (select 1 from term_langs tl where tl.term_id = t.id and tl.lang = p_lang and tl.unused) then
    perform app_error('Язык помечен «Не актуально для языка». Сначала верните его в работу.');
  end if;
  if t.version <> p_version then
    if live_text(t.id, p_lang) = array_to_string(v_items, '; ') then
      return jsonb_build_object('text', live_text(t.id, p_lang), 'status', lang_status(t.id, p_lang), 'version', t.version, 'warnings', '[]'::jsonb);
    end if;
    perform conflict_error();
  end if;
  v_keys := array(select norm_term(y) from unnest(v_items) y);
  select * into x from translations y where y.term_id = t.id and y.lang = p_lang and y.status = 'approved' and not (norm_term(y.text) = any(v_keys)) limit 1;
  if x.id is not null then
    perform app_error('Согласованный перевод «' || x.text || '» нельзя изменить в ячейке. ' ||
      case when is_validator_of(u, p_lang) then 'Нажмите «Изменить» рядом с переводом.' else 'Нажмите «Заменить» рядом с переводом.' end);
  end if;
  for x in select * from translations y where y.term_id = t.id and y.lang = p_lang and y.status in ('draft','unchecked')
             and not (y.text = any(v_items)) and not (y.status = 'unchecked' and norm_term(y.text) = any(v_keys) and not contractor_direct(u, p_lang)) loop
    if x.status = 'unchecked' and not contractor_direct(u, p_lang) and not is_validator_of(u, p_lang) then
      perform app_error('Перевод «Без проверки» «' || x.text || '» может изменить только валидатор языка.');
    end if;
    if x.status = 'draft' then delete from translations where id = x.id;
    else update translations set status = 'obsolete', obsolete_at = now() where id = x.id; end if;
    perform log_event(u, 'Перевод убран', t.tb, null, p_lang, x.text, null);
    v_changed := true;
  end loop;
  v_existing := array(select y.text from translations y where y.term_id = t.id and y.lang = p_lang and y.status <> 'obsolete');
  foreach v in array v_items loop
    if v = any(v_existing) then continue; end if;
    -- такой же (с точностью до пробелов и дефисов) согласованный перевод уже есть — не дублируем
    if exists (select 1 from translations y where y.term_id = t.id and y.lang = p_lang and y.status in ('approved','unchecked')
                and norm_term(y.text) = norm_term(v)) then continue; end if;
    perform add_translation(t.id, p_lang, v, v_status, u.id);
    perform log_event(u, case when v_status = 'unchecked' then 'Вписан перевод (без проверки)' else 'Вписан перевод (черновик)' end, t.tb, null, p_lang, null, v);
    v_changed := true;
  end loop;
  v_ids := array(select y.id from translations y where y.term_id = t.id and y.lang = p_lang and y.status <> 'obsolete' order by coalesce(array_position(v_items, y.text), array_position(v_keys, norm_term(y.text))));
  v_sorts := array(select y.sort from translations y where y.term_id = t.id and y.lang = p_lang and y.status <> 'obsolete' order by y.sort);
  for i in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    update translations set sort = v_sorts[i] where id = v_ids[i] and sort <> v_sorts[i];
    if found then v_changed := true; end if;
  end loop;
  if v_changed then perform bump_term(t.id, u.id); end if;
  select * into t from terms where id = t.id;
  return jsonb_build_object('text', live_text(t.id, p_lang), 'status', lang_status(t.id, p_lang), 'version', t.version,
    'warnings', to_jsonb(duplicate_warnings('', jsonb_build_object(p_lang, array_to_string(v_items, ';')), t.id, null)));
end $$;

-- Согласовать (черновики и «Без проверки») или снять согласование. p_items: [{"id":1,"version":3}]
create or replace function set_lang_approval(p_items jsonb, p_lang text, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); it jsonb; t terms; v_done text[] := '{}'; v_skip text[] := '{}'; v_txt text; n int; tl term_langs;
begin
  if not is_validator_of(u, p_lang) then
    perform app_error(case when p_approve then 'Согласовать ' else 'Снять согласование ' end || lang_name(p_lang) || ' может только валидатор ' || lang_gen(p_lang) || '.');
  end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    begin
      select * into t from terms where id = (it->>'id')::int for update;
      if not found then perform app_error('Термин не найден.'); end if;
      if t.status <> 'active' then perform app_error(t.tb || ': термин в архиве.'); end if;
      if t.version <> (it->>'version')::int then perform app_error(t.tb || ': данные уже изменились, обновите страницу.'); end if;
      select * into tl from term_langs where term_id = t.id and lang = p_lang;
      if p_approve then
        select string_agg(x.text, '; ' order by x.sort, x.id), count(*) into v_txt, n from translations x
         where x.term_id = t.id and x.lang = p_lang and x.status in ('draft','unchecked');
        if n = 0 and tl.draft is null then perform app_error(t.tb || ': нечего согласовывать.'); end if;
        if not exists (select 1 from translations x where x.term_id = t.id and x.lang = p_lang and x.status <> 'obsolete') then
          perform app_error(t.tb || ': нет перевода.');
        end if;
        update translations x set status = 'approved', approved_at = now(), approved_by = u.id
         where x.term_id = t.id and x.lang = p_lang and x.status in ('draft','unchecked');
        if tl.draft is not null then
          perform apply_lang_fields(t.id, p_lang, tl.draft);
          update term_langs set draft = null where term_id = t.id and lang = p_lang;
        end if;
      else
        select string_agg(x.text, '; ' order by x.sort, x.id), count(*) into v_txt, n from translations x
         where x.term_id = t.id and x.lang = p_lang and x.status = 'approved';
        if n = 0 then perform app_error(t.tb || ': нет согласованного перевода.'); end if;
        update translations x set status = 'draft', approved_at = null, approved_by = null
         where x.term_id = t.id and x.lang = p_lang and x.status = 'approved';
      end if;
      perform log_event(u, case when p_approve then 'Перевод согласован' else 'Согласование снято' end, t.tb, null, p_lang,
        case when p_approve then 'Черновик' else 'Согласовано' end, case when p_approve then 'Согласовано' else 'Черновик' end, v_txt);
      perform bump_term(t.id, u.id);
      v_done := v_done || (t.tb || ': ' || coalesce(v_txt, 'поля языка'));
    exception when others then
      v_skip := v_skip || sqlerrm;
    end;
  end loop;
  return jsonb_build_object('done', to_jsonb(v_done), 'skipped', to_jsonb(v_skip));
end $$;

-- «Изменить»: валидатор языка (или подрядчик на языке без валидатора) меняет перевод сразу. Прежний — в истории.
create or replace function edit_translation(p_translation int, p_text text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); x translations; t terms; v_new translations; v text := (split_variants(p_text))[1];
begin
  select * into x from translations where id = p_translation for update;
  if not found or x.status = 'obsolete' then perform app_error('Перевод уже изменился. Обновите страницу.'); end if;
  if not (is_validator_of(u, x.lang) or (contractor_direct(u, x.lang) and x.status = 'unchecked')) then
    perform app_error('Изменить перевод на ' || lang_name(x.lang) || ' сразу может только валидатор ' || lang_gen(x.lang) || '. Нажмите «Заменить».');
  end if;
  if coalesce(v, '') = '' then perform app_error('Впишите новый перевод.'); end if;
  if btrim(coalesce(p_reason, '')) = '' then perform app_error('Укажите причину.'); end if;
  if v = x.text then perform app_error('Новый перевод такой же, как прежний.'); end if;
  select * into t from terms where id = x.term_id for update;
  v_new := add_translation(t.id, x.lang, v, case when is_validator_of(u, x.lang) then 'approved' else 'unchecked' end, u.id, x.sort);
  update translations set status = 'obsolete', obsolete_at = now(), replaced_by = v_new.id where id = x.id;
  perform log_event(u, 'Замена перевода', t.tb, null, x.lang, x.text, v, 'Причина: ' || btrim(p_reason));
  perform auto_remove_replacements(u, t.id, x.lang, x.id, null);
  perform bump_term(t.id, u.id);
  return jsonb_build_object('text', live_text(t.id, x.lang), 'status', lang_status(t.id, x.lang));
end $$;

-- Языковые поля (комментарий лингвиста, «Как нельзя»). Переводчик — черновиком;
-- валидатор языка, валидатор английского, подрядчик на языке без валидатора — сразу.
create or replace function edit_lang_fields(p_term int, p_lang text, p_fields jsonb, p_version int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms; tl term_langs; v_f jsonb;
begin
  select * into t from terms where id = p_term for update;
  if not found or t.status <> 'active' then perform app_error('Термин не найден или в архиве.'); end if;
  if t.version <> p_version then perform conflict_error(); end if;
  v_f := jsonb_build_object('comment', btrim(coalesce(p_fields->>'comment', '')), 'forbidden', clean_forbidden(p_fields->'forbidden'));
  perform ensure_term_lang(t.id, p_lang);
  select * into tl from term_langs where term_id = t.id and lang = p_lang;
  if is_validator_of(u, p_lang) or is_en_validator(u) or contractor_direct(u, p_lang) then
    perform apply_lang_fields(t.id, p_lang, v_f);
    perform log_event(u, 'Изменены поля языка', t.tb, null, p_lang,
      jsonb_build_object('comment', tl.comment, 'forbidden', tl.forbidden)::text, v_f::text);
  elsif works_lang(u, p_lang) then
    update term_langs set draft = v_f where term_id = t.id and lang = p_lang;
    perform log_event(u, 'Поля языка — черновик', t.tb, null, p_lang, null, v_f::text);
  else
    perform app_error('Поля ' || lang_gen(p_lang) || ' меняют переводчик и валидатор этого языка.');
  end if;
  return jsonb_build_object('version', bump_term(t.id, u.id));
end $$;

-- «Не актуально для языка» / «Вернуть в работу». Когда все нужные языки «Не актуально для языка» — термин уходит в архив.
create or replace function set_unused(p_term int, p_lang text, p_unused boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms; v_archived boolean := false; r record;
begin
  if not is_validator_of(u, p_lang) then perform app_error('Пометить ' || lang_name(p_lang) || ' может только валидатор ' || lang_gen(p_lang) || '.'); end if;
  select * into t from terms where id = p_term for update;
  if not found or t.status <> 'active' then perform app_error('Термин не найден или в архиве.'); end if;
  perform ensure_term_lang(t.id, p_lang);
  update term_langs set unused = p_unused where term_id = t.id and lang = p_lang;
  perform log_event(u, case when p_unused then 'Язык: «Не актуально для языка»' else 'Язык возвращён в работу' end, t.tb, null, p_lang);
  perform bump_term(t.id, u.id);
  if p_unused then
    for r in select id from requests where term_id = t.id and type = 'obsolete' and status = 'pending' loop
      insert into request_answers(request_id, lang, answer, author_id) values (r.id, p_lang, 'unused', u.id)
      on conflict (request_id, lang) do update set answer = 'unused', author_id = u.id, at = now();
    end loop;
    v_archived := check_auto_archive(u, t.id);
  end if;
  return jsonb_build_object('archived', v_archived);
end $$;


-- Автор отзывает заявку, пока по ней никто ничего не сделал (не вписал перевод, не ответил, не решил)
create or replace function withdraw_request(p_request int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  select * into r from requests where id = p_request for update;
  if not found then perform app_error('Заявка не найдена.'); end if;
  if r.author_id <> u.id then perform app_error('Отозвать заявку может только её автор.'); end if;
  if r.status <> 'pending' then perform app_error('Заявку уже рассмотрели — отозвать нельзя.'); end if;
  if exists (select 1 from request_translations rt where rt.request_id = r.id and rt.author_id is distinct from r.author_id)
     or exists (select 1 from request_answers a where a.request_id = r.id) then
    perform app_error('По заявке уже начали работать (вписали перевод или ответили) — отозвать нельзя. Напишите комментарий в заявке.');
  end if;
  update requests set status = 'withdrawn', decided_by = u.id, decided_at = now(), version = version + 1 where id = r.id;
  perform log_event(u, 'Заявка отозвана автором', (select tb from terms where id = r.term_id), r.code, r.lang, null, null, req_type_label(r.type) || ' «' || r.ru || '»');
end $$;

-- «Перевод по желанию» / «Нужен перевод» для языка термина
create or replace function set_lang_optional(p_term int, p_lang text, p_optional boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms;
begin
  if not (can_edit_ru(u) or is_validator_of(u, p_lang)) then
    perform app_error('Менять это могут менеджер, владелец и валидатор языка.');
  end if;
  select * into t from terms where id = p_term for update;
  if not found or t.status <> 'active' then perform app_error('Термин не найден или в архиве.'); end if;
  perform ensure_term_lang(t.id, p_lang);
  update term_langs set optional = p_optional where term_id = t.id and lang = p_lang;
  perform log_event(u, case when p_optional then 'Язык: перевод по желанию' else 'Язык: нужен перевод' end, t.tb, null, p_lang);
  perform bump_term(t.id, u.id);
end $$;

-- То же для нескольких терминов сразу (галочки в Рабочей области)
create or replace function set_unused_many(p_terms int[], p_lang text, p_unused boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_id int; n int := 0; a int := 0; r jsonb;
begin
  if not is_validator_of(u, p_lang) then perform app_error('Пометить ' || lang_name(p_lang) || ' может только валидатор ' || lang_gen(p_lang) || '.'); end if;
  foreach v_id in array coalesce(p_terms, '{}') loop
    if not exists (select 1 from terms where id = v_id and status = 'active') then continue; end if;
    if coalesce((select tl.unused from term_langs tl where tl.term_id = v_id and tl.lang = p_lang), false) = p_unused then continue; end if;
    r := set_unused(v_id, p_lang, p_unused);
    n := n + 1;
    if coalesce((r->>'archived')::boolean, false) then a := a + 1; end if;
  end loop;
  return jsonb_build_object('changed', n, 'archived', a);
end $$;

-- =====================================================================
-- API: просьба «Устарел»
-- =====================================================================

create or replace function propose_obsolete(p_term int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms; v_code text; v_archived boolean := false; v_l text;
begin
  if u.role not in ('manager','validator') then perform app_error('Предложить «Устарел» могут менеджер и валидаторы.'); end if;
  if btrim(coalesce(p_reason, '')) = '' then perform app_error('Напишите, почему термин устарел.'); end if;
  select * into t from terms where id = p_term;
  if not found or t.status <> 'active' then perform app_error('Термин не найден или уже в архиве.'); end if;
  if exists (select 1 from requests where term_id = t.id and type = 'obsolete' and status = 'pending') then
    perform app_error('Просьба «Устарел» по этому термину уже открыта.');
  end if;
  v_code := 'Z-' || lpad(nextval('req_seq')::text, 5, '0');
  insert into requests(code, type, term_id, ru, reason, author_id) values (v_code, 'obsolete', t.id, t.ru, btrim(p_reason), u.id);
  perform log_event(u, 'Предложено: термин устарел', t.tb, v_code, null, null, null, btrim(p_reason));
  -- язык самого предложившего валидатора сразу помечается «Не актуально для языка»
  for v_l in select x from unnest(validator_langs(u)) x loop
    if exists (select 1 from translations x where x.term_id = t.id and x.lang = v_l and x.status <> 'obsolete') then
      v_archived := (set_unused(t.id, v_l, true)->>'archived')::boolean;
    end if;
  end loop;
  return jsonb_build_object('code', v_code, 'archived', v_archived);
end $$;

create or replace function answer_obsolete(p_request int, p_answer text, p_comment text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests; v_l text;
begin
  select * into r from requests where id = p_request;
  if not found or r.type <> 'obsolete' or r.status <> 'pending' then perform app_error('Просьба уже закрыта. Обновите страницу.'); end if;
  v_l := validator_lang_for(u, r);
  if v_l is null then perform app_error('Отвечают на просьбу валидаторы языков, у которых есть перевод этого термина.'); end if;
  if p_answer = 'unused' then
    return set_unused(r.term_id, v_l, true);
  elsif p_answer = 'keep' then
    insert into request_answers(request_id, lang, answer, comment, author_id) values (r.id, v_l, 'keep', btrim(coalesce(p_comment, '')), u.id)
    on conflict (request_id, lang) do update set answer = 'keep', comment = excluded.comment, author_id = u.id, at = now();
    perform log_event(u, 'Ответ на «Устарел»: оставить', (select tb from terms where id = r.term_id), r.code, v_l, null, null, nullif(btrim(coalesce(p_comment, '')), ''));
    return jsonb_build_object('archived', false);
  end if;
  perform app_error('Неизвестный ответ.');
end $$;

create or replace function close_obsolete(p_request int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); r requests;
begin
  select * into r from requests where id = p_request for update;
  if not found or r.type <> 'obsolete' or r.status <> 'pending' then perform app_error('Просьба уже закрыта.'); end if;
  if r.author_id <> u.id then perform app_error('Закрыть просьбу может её автор.'); end if;
  update requests set status = 'closed', decided_by = u.id, decided_at = now(), version = version + 1 where id = r.id;
  perform log_event(u, 'Просьба «Устарел» закрыта автором', (select tb from terms where id = r.term_id), r.code);
end $$;

-- =====================================================================
-- API: русская часть, архив, удаление, объединение, комментарии
-- =====================================================================

create or replace function edit_ru(p_term int, p_version int, p_fields jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms; n int := 0; k text; lbl text; v_new text; v_old text; v_before int[]; v_want int[];
begin
  if not can_edit_ru(u) then perform app_error('Русскую часть меняют менеджер, валидатор английского и владелец.'); end if;
  select * into t from terms where id = p_term for update;
  if not found then perform app_error('Термин не найден.'); end if;
  if t.version <> p_version then perform conflict_error(); end if;
  foreach k in array array['definition','examples','comment'] loop
    if not p_fields ? k then continue; end if;
    v_new := btrim(coalesce(p_fields->>k, ''));
    v_old := case k when 'definition' then t.definition when 'examples' then t.examples else t.comment end;
    if v_new = v_old then continue; end if;
    lbl := case k when 'definition' then 'Определение' when 'examples' then 'Примеры' else 'Комментарий' end;
    execute format('update terms set %I = $1 where id = $2', k) using v_new, t.id;
    perform log_event(u, 'Изменено поле «' || lbl || '» (рус.)', t.tb, null, null, v_old, v_new);
    n := n + 1;
  end loop;
  if p_fields ? 'project_ids' then
    v_before := array(select tp.project_id from term_projects tp where tp.term_id = t.id order by 1);
    v_want := array(select p.id from projects p where p.id = any(coalesce(array(select (x)::int from jsonb_array_elements_text(p_fields->'project_ids') x), '{}'))
                      and (not p.closed or p.id = any(v_before)) order by 1);
    if v_want is distinct from v_before then
      delete from term_projects where term_id = t.id;
      insert into term_projects select t.id, x from unnest(v_want) x;
      perform log_event(u, 'Изменено поле «Проекты»', t.tb, null, null,
        (select string_agg(name, ', ' order by name) from projects where id = any(v_before)),
        (select string_agg(name, ', ' order by name) from projects where id = any(v_want)));
      n := n + 1;
    end if;
  end if;
  if n > 0 then perform bump_term(t.id, u.id); end if;
  return n;
end $$;

-- Добавить выбранные термины в проект или убрать из проекта (менеджер, валидатор английского, владелец)
create or replace function set_term_project(p_terms int[], p_project int, p_add boolean) returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); pr projects; t record; n int := 0;
begin
  if not can_edit_ru(u) then perform app_error('Проекты терминов меняют менеджер, валидатор английского и владелец.'); end if;
  select * into pr from projects where id = p_project;
  if not found then perform app_error('Проект не найден.'); end if;
  if p_add and pr.closed then perform app_error('Проект «' || pr.name || '» закрыт — в него нельзя добавлять термины.'); end if;
  if coalesce(array_length(p_terms, 1), 0) = 0 then perform app_error('Отметьте термины.'); end if;
  if array_length(p_terms, 1) > 500 then perform app_error('За один раз — не больше 500 терминов.'); end if;
  for t in select x.id, x.tb from terms x where x.id = any(p_terms) order by x.tb for update loop
    if p_add then
      insert into term_projects(term_id, project_id) values (t.id, pr.id) on conflict do nothing;
    else
      delete from term_projects where term_id = t.id and project_id = pr.id;
    end if;
    if found then
      perform log_event(u, case when p_add then 'Добавлен в проект' else 'Убран из проекта' end, t.tb, null, null, null, pr.name);
      perform bump_term(t.id, u.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function archive_term(p_term int, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms;
begin
  if not is_owner(u) then perform app_error('Отправить термин в архив вручную может владелец. Остальные — через «Не актуально для языка» или просьбу «Устарел».'); end if;
  select * into t from terms where id = p_term for update;
  if not found then perform app_error('Термин не найден.'); end if;
  if t.version <> p_version then perform conflict_error(); end if;
  if t.status <> 'active' then perform app_error('Термин уже в архиве.'); end if;
  update terms set status = 'archived', archive_reason = 'manual' where id = t.id;
  perform bump_term(t.id, u.id);
  perform log_event(u, 'Термин отправлен в архив', t.tb, null, null, 'Действует', 'В архиве', t.ru);
end $$;

create or replace function restore_term(p_term int, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms;
begin
  if not (is_owner(u) or is_en_validator(u)) then perform app_error('Вернуть из архива могут владелец и валидатор английского.'); end if;
  select * into t from terms where id = p_term for update;
  if not found then perform app_error('Термин не найден.'); end if;
  if t.version <> p_version then perform conflict_error(); end if;
  if t.status <> 'archived' then perform app_error('Термин не в архиве.'); end if;
  -- ушёл в архив из-за «Не актуально для языка» — языки возвращаются в прежние статусы
  if t.archive_reason = 'all_unused' then update term_langs set unused = false where term_id = t.id; end if;
  update terms set status = 'active', archive_reason = null where id = t.id;
  perform bump_term(t.id, u.id);
  perform log_event(u, 'Термин возвращён из архива', t.tb, null, null, 'В архиве', 'Действует', t.ru);
end $$;

create or replace function delete_term(p_term int, p_typed_tb text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms; v_trs text;
begin
  if not (is_owner(u) or is_en_validator(u)) then perform app_error('Окончательно удалить термин могут владелец и валидатор английского.'); end if;
  select * into t from terms where id = p_term for update;
  if not found then perform app_error('Термин не найден.'); end if;
  if upper(btrim(coalesce(p_typed_tb, ''))) <> t.tb then perform app_error('Чтобы удалить, впишите номер ' || t.tb || '.'); end if;
  select string_agg(lang || ': ' || text, '; ' order by lang, sort) into v_trs from translations where term_id = t.id and status <> 'obsolete';
  update translations set replaced_by = null where term_id = t.id;
  insert into retired_tb(tb) values (t.tb) on conflict do nothing;
  delete from terms where id = t.id;
  perform log_event(u, 'Термин удалён окончательно', t.tb, null, null, t.ru, null, v_trs);
end $$;

-- Объединение дублей: остаётся меньший номер, второй выводится из оборота.
-- p_main: {"KA": <id перевода, который станет основным>} — для языков, где переводы есть у обоих.
create or replace function merge_terms(p_keep int, p_drop int, p_main jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); a terms; b terms; k terms; d terms; l text; v_main int; i int; x record; tlk term_langs; tld term_langs;
begin
  if not is_en_validator(u) then perform app_error('Объединять дубли может валидатор английского.'); end if;
  if p_keep = p_drop then perform app_error('Выберите два разных термина.'); end if;
  select * into a from terms where id = p_keep for update;
  select * into b from terms where id = p_drop for update;
  if a.id is null or b.id is null then perform app_error('Термин не найден.'); end if;
  if a.status <> 'active' or b.status <> 'active' then perform app_error('Объединять можно только действующие термины.'); end if;
  if a.tb < b.tb then k := a; d := b; else k := b; d := a; end if;   -- остаётся меньший номер
  for l in select distinct y.lang from translations y where y.term_id = d.id and y.status <> 'obsolete' loop
    update translations set term_id = k.id, sort = sort + 1000 where term_id = d.id and lang = l and status <> 'obsolete';
    v_main := nullif(coalesce(p_main, '{}'::jsonb)->>l, '')::int;
    i := 1;
    for x in select y.id from translations y where y.term_id = k.id and y.lang = l and y.status <> 'obsolete'
              order by (y.id = v_main) desc, y.sort, y.id loop
      update translations set sort = i where id = x.id;
      i := i + 1;
    end loop;
  end loop;
  update translations set term_id = k.id where term_id = d.id;   -- история (устаревшие)
  for tld in select * from term_langs where term_id = d.id loop
    perform ensure_term_lang(k.id, tld.lang);
    select * into tlk from term_langs where term_id = k.id and lang = tld.lang;
    update term_langs set
      comment = case when tlk.comment = '' then tld.comment when tld.comment = '' or tld.comment = tlk.comment then tlk.comment else tlk.comment || E'\n' || tld.comment end,
      optional = tlk.optional and tld.optional,
      forbidden = tlk.forbidden || tld.forbidden,
      unused = tlk.unused and tld.unused
    where term_id = k.id and lang = tld.lang;
  end loop;
  insert into term_projects select k.id, tp.project_id from term_projects tp where tp.term_id = d.id on conflict do nothing;
  update term_comments set term_id = k.id where term_id = d.id;
  update requests set term_id = k.id where term_id = d.id;
  insert into retired_tb(tb, merged_into) values (d.tb, k.tb) on conflict do nothing;
  delete from terms where id = d.id;
  perform bump_term(k.id, u.id);
  perform log_event(u, 'Объединение дублей', k.tb, null, null, d.tb || ' «' || d.ru || '»', k.tb || ' «' || k.ru || '»', d.tb || ' выведен из оборота');
  perform log_event(u, 'Объединён с ' || k.tb, d.tb, null, null, null, null, 'Номер выведен из оборота');
  return jsonb_build_object('tb', k.tb, 'retired', d.tb, 'id', k.id);
end $$;

create or replace function add_term_comment(p_term int, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); t terms;
begin
  if u.role = 'reader' then perform app_error('Читатель не может комментировать.'); end if;
  if btrim(coalesce(p_body, '')) = '' then perform app_error('Комментарий пустой.'); end if;
  select * into t from terms where id = p_term;
  if not found then perform app_error('Термин не найден.'); end if;
  insert into term_comments(term_id, author_id, body) values (t.id, u.id, btrim(p_body));
  perform log_event(u, 'Комментарий к термину', t.tb, null, null, null, btrim(p_body));
end $$;

create or replace function hide_term_comment(p_comment int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); c term_comments;
begin
  if not (is_owner(u) or is_en_validator(u)) then perform app_error('Скрывать комментарии могут валидатор английского и владелец.'); end if;
  update term_comments set hidden = true where id = p_comment returning * into c;
  if c.id is null then perform app_error('Комментарий не найден.'); end if;
  perform log_event(u, 'Комментарий скрыт', (select tb from terms where id = c.term_id), null, null, c.body);
end $$;

-- =====================================================================
-- API: «Рабочая область» языка
-- =====================================================================

-- p_tab: mine | new | review. p_status (для mine): all | need | draft | unchecked | approved | unused
drop function if exists work_page(text, text, text, integer, text, integer, integer);
create or replace function work_page(p_lang text, p_tab text default 'mine', p_status text default 'all', p_project int default null,
  p_q text default null, p_page int default 1, p_size int default 100, p_hide_unused boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_total int; v_items jsonb; v_size int := least(greatest(p_size, 10), 5000); v_counts jsonb;
begin
  if not (works_lang(u, p_lang) or is_owner(u) or contractor_direct(u, p_lang)) then
    perform app_error('Рабочая область ' || lang_gen(p_lang) || ' доступна переводчику и валидатору этого языка.');
  end if;
  with base as (
    select t.*, lang_status(t.id, p_lang) as st from terms t
     where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))
       and search_match(t, p_q)
  ), sel as (
    select * from base b where
      case p_tab
        when 'new' then b.st in ('need','optional') and exists (select 1 from translations x where x.term_id = b.id and x.lang <> p_lang and x.status = 'approved')
        when 'review' then exists (select 1 from translations x where x.term_id = b.id and x.lang = p_lang and x.status = 'unchecked')
        else (p_status = 'all' and not (p_hide_unused and b.st = 'unused')) or b.st = p_status end
  ), pg as (
    select * from sel order by case when p_tab = 'new' then -extract(epoch from created_at) else 0 end, lower(ru), tb
    limit v_size offset (greatest(p_page, 1) - 1) * v_size
  )
  select (select count(*) from sel), coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'tb', pg.tb, 'ru', pg.ru, 'definition', pg.definition, 'examples', pg.examples, 'comment', pg.comment, 'version', pg.version, 'status', pg.st,
      'lang_comment', coalesce((select tl.comment from term_langs tl where tl.term_id = pg.id and tl.lang = p_lang), ''),
      'created_at', pg.created_at,
      'projects', coalesce((select jsonb_agg(pr.name order by pr.name) from term_projects tp join projects pr on pr.id = tp.project_id where tp.term_id = pg.id), '[]'),
      'text', live_text(pg.id, p_lang),
      'live', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'text', x.text, 'status', x.status) order by x.sort, x.id)
                from translations x where x.term_id = pg.id and x.lang = p_lang and x.status <> 'obsolete'), '[]'),
      'forbidden', coalesce((select tl.forbidden from term_langs tl where tl.term_id = pg.id and tl.lang = p_lang), '[]'),
      'others', coalesce((select jsonb_object_agg(z.lang, z.txt) from (select x.lang, string_agg(x.text, '; ' order by x.sort, x.id) txt
                from translations x where x.term_id = pg.id and x.lang <> p_lang and x.status in ('approved','unchecked') group by x.lang) z), '{}')
    ) order by case when p_tab = 'new' then -extract(epoch from pg.created_at) else 0 end, lower(pg.ru), pg.tb), '[]')
  into v_total, v_items from pg;
  select jsonb_build_object(
    'need', count(*) filter (where lang_status(t.id, p_lang) = 'need'),
    'draft', count(*) filter (where lang_status(t.id, p_lang) = 'draft'),
    'review', count(*) filter (where exists (select 1 from translations x where x.term_id = t.id and x.lang = p_lang and x.status = 'unchecked')))
  into v_counts from terms t where t.status = 'active';
  return jsonb_build_object('items', v_items, 'total', v_total, 'page', greatest(p_page, 1), 'pages', greatest(1, ceil(v_total::numeric / v_size)),
    'counts', v_counts, 'kind', (select kind from languages where code = p_lang),
    'can', jsonb_build_object('type', can_type(u, p_lang), 'approve', is_validator_of(u, p_lang),
      'unchecked', contractor_direct(u, p_lang)));
end $$;

-- =====================================================================
-- API: архив, журнал
-- =====================================================================

create or replace function archive_lists(p_q text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if u.role not in ('owner','validator') then perform app_error('Архив видят владелец и валидаторы.'); end if;
  return jsonb_build_object(
    'can_restore', is_owner(u) or is_en_validator(u), 'can_delete', is_owner(u) or is_en_validator(u),
    'terms', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'tb', t.tb, 'ru', t.ru, 'definition', t.definition, 'version', t.version,
        'reason', case t.archive_reason when 'all_unused' then 'все языки «Не актуально для языка»' else 'вручную' end,
        'updated_at', t.updated_at, 'updated_by', display_name(u, t.updated_by), 'cells', lang_cells(t.id)) order by lower(t.ru))
      from (select * from terms t where t.status = 'archived' and search_match(t, p_q) order by lower(ru) limit 1000) t), '[]'),
    'rejected', coalesce((select jsonb_agg(request_json(u, r) order by r.decided_at desc) from
        (select * from requests r where r.status = 'rejected' and (p_q is null or norm_term(r.ru) like '%' || norm_term(p_q) || '%')
          order by decided_at desc limit 1000) r), '[]'));
end $$;

create or replace function log_page(p_f jsonb default '{}', p_page int default 1, p_size int default 100) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_total int; v_items jsonb; v_all boolean;
begin
  if u.role not in ('owner','manager','validator','translator') then perform app_error('Журнал видят владелец, менеджеры, валидаторы и переводчики.'); end if;
  v_all := is_owner(u) or is_en_validator(u) or u.role = 'manager';
  with base as (
    select * from audit_log a
     where (v_all or a.lang = any(work_langs(u)) or (a.lang is null and a.tb is not null))
       and (nullif(p_f->>'from', '') is null or a.at >= (p_f->>'from')::date)
       and (nullif(p_f->>'to', '') is null or a.at < (p_f->>'to')::date + 1)
       and (nullif(p_f->>'user_id', '') is null or a.user_id = (p_f->>'user_id')::int)
       and (nullif(p_f->>'tb', '') is null or upper(coalesce(a.tb, '') || ' ' || coalesce(a.request_code, '')) like '%' || upper(btrim(p_f->>'tb')) || '%')
       and (nullif(p_f->>'action', '') is null or a.action = p_f->>'action')
       and (nullif(p_f->>'lang', '') is null or a.lang = p_f->>'lang')
  ), pg as (select * from base order by at desc, id desc limit p_size offset (greatest(p_page, 1) - 1) * p_size)
  select (select count(*) from base), coalesce(jsonb_agg(jsonb_build_object('id', pg.id, 'at', pg.at, 'user', display_name(u, pg.user_id),
      'action', pg.action, 'tb', pg.tb, 'request_code', pg.request_code, 'lang', pg.lang, 'before', pg.before, 'after', pg.after, 'details', pg.details)
    order by pg.at desc, pg.id desc), '[]') into v_total, v_items from pg;
  return jsonb_build_object('items', v_items, 'total', v_total, 'page', greatest(p_page, 1), 'pages', greatest(1, ceil(v_total::numeric / p_size)),
    'actions', (select coalesce(jsonb_agg(distinct action), '[]') from audit_log),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', display_name(u, id)) order by name), '[]') from profiles));
end $$;

-- =====================================================================
-- API: выгрузка (файл собирается в браузере). В Smartcat — только полные языки.
-- =====================================================================

create or replace function export_data(p_langs text[], p_project int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_langs text[];
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  v_langs := array(select l.code from languages l where l.code = any(p_langs) and l.kind = 'full' and l.active);
  return jsonb_build_object(
    'ru_code', (select value from settings where key = 'ru_smartcat_code'),
    'languages', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'smartcat', l.smartcat_code) order by case when l.code = 'EN' then 0 else 1 end, l.sort, l.code), '[]')
                    from languages l where l.code = any(v_langs)),
    'terms', coalesce((select jsonb_agg(jsonb_build_object('tb', t.tb, 'ru', t.ru, 'definition', t.definition, 'examples', t.examples,
        'comment', t.comment, 'created_at', t.created_at, 'updated_at', t.updated_at,
        'tr', coalesce((select jsonb_object_agg(z.lang, z.list) from (select x.lang, jsonb_agg(x.text order by x.sort, x.id) list
                 from translations x left join term_langs tl on tl.term_id = x.term_id and tl.lang = x.lang
                where x.term_id = t.id and x.lang = any(v_langs) and not coalesce(tl.unused, false)
                  -- согласованные; у языков без валидатора проверять некому — берём и «Без проверки»
                  and (x.status = 'approved' or (x.status = 'unchecked' and not lang_has_validator(x.lang)))
                group by x.lang) z), '{}'),
        'fields', coalesce((select jsonb_object_agg(tl.lang, jsonb_build_object('comment', tl.comment, 'forbidden', tl.forbidden))
                 from term_langs tl where tl.term_id = t.id and tl.lang = any(v_langs) and not tl.unused), '{}'))
        order by lower(t.ru), t.tb)
      from terms t where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))), '[]'));
end $$;

-- Таблица для просмотра — все языки, со статусами
create or replace function export_view(p_project int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  return jsonb_build_object(
    'languages', (select jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind) order by case when l.code = 'EN' then 0 else 1 end, l.sort) from languages l where l.active),
    'terms', coalesce((select jsonb_agg(jsonb_build_object('tb', t.tb, 'ru', t.ru, 'definition', t.definition,
        'projects', coalesce((select string_agg(pr.name, ', ' order by pr.name) from term_projects tp join projects pr on pr.id = tp.project_id where tp.term_id = t.id), ''),
        'cells', lang_cells(t.id)) order by lower(t.ru), t.tb)
      from terms t where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))), '[]'));
end $$;

-- Для подрядчиков: термины, где на выбранных языках ещё нет перевода (и язык не «не актуально»).
-- Уже готовые переводы других выбранных языков тоже отдаём — для справки.
create or replace function export_contractor(p_langs text[], p_project int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_langs text[];
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  v_langs := array(select l.code from languages l where l.code = any(p_langs) and l.active order by l.sort);
  if cardinality(v_langs) = 0 then perform app_error('Выберите хотя бы один язык.'); end if;
  return jsonb_build_object(
    'languages', (select jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name) order by l.sort) from languages l where l.code = any(v_langs)),
    'terms', coalesce((select jsonb_agg(jsonb_build_object('tb', t.tb, 'ru', t.ru, 'definition', t.definition, 'examples', t.examples,
        'tr', coalesce((select jsonb_object_agg(z.lang, z.txt) from (select x.lang, string_agg(x.text, '; ' order by x.sort, x.id) txt
                 from translations x where x.term_id = t.id and x.lang = any(v_langs) and x.status <> 'obsolete' group by x.lang) z), '{}'))
        order by lower(t.ru), t.tb)
      from terms t where t.status = 'active'
       and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project))
       and exists (select 1 from unnest(v_langs) l where lang_status(t.id, l) in ('need','optional'))), '[]'));
end $$;

create or replace function export_count(p_project int default null) returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  return (select count(*) from terms t where t.status = 'active'
    and (p_project is null or exists (select 1 from term_projects tp where tp.term_id = t.id and tp.project_id = p_project)));
end $$;

create or replace function log_export(p_langs text[], p_project int, p_format text, p_count int) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_name text;
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  v_name := coalesce((select name from projects where id = p_project), 'Все проекты');
  insert into exports(user_id, langs, project, format, count) values (u.id, p_langs, v_name, p_format, p_count);
  perform log_event(u, 'Выгрузка', null, null, null, null, null, v_name || '; ' || p_format || '; языки: ' || array_to_string(p_langs, ', ') || '; терминов: ' || p_count);
end $$;

create or replace function export_history() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if not can_export(u) then perform app_error('Выгружать глоссарий могут менеджер и владелец.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'user', display_name(u, e.user_id), 'langs', to_jsonb(e.langs),
    'project', e.project, 'format', e.format, 'count', e.count) order by e.at desc) from (select * from exports order by at desc limit 100) e), '[]');
end $$;

-- =====================================================================
-- API: администрирование (владелец)
-- =====================================================================

create or replace function require_owner(u profiles) returns void language plpgsql as $$
begin
  if not is_owner(u) then perform app_error('Раздел «Администрирование» доступен только владельцу.'); end if;
end $$;

create or replace function check_role_lang(p_role text, p_lang text) returns text language plpgsql stable as $$
begin
  if p_role not in ('owner','validator','manager','translator','contractor','reader') then perform app_error('Неизвестная роль.'); end if;
  if p_role in ('translator','validator') then
    if coalesce(p_lang, '') = '' then perform app_error('Переводчику и валидатору нужно выбрать язык.'); end if;
    if not exists (select 1 from languages where code = upper(p_lang)) then perform app_error('Такого языка нет.'); end if;
    return upper(p_lang);
  end if;
  return null;
end $$;

create or replace function admin_users() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  perform require_owner(u);
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name, 'role', p.role, 'role_label', role_label(p.role),
      'lang', p.lang, 'langs', coalesce((select jsonb_agg(jsonb_build_object('code', pl.lang, 'role', pl.role) order by (pl.role = 'validator') desc, pl.lang)
                                         from profile_langs pl where pl.profile_id = p.id), '[]'),
      'contractor_no', p.contractor_no, 'avatar', p.avatar, 'active', p.active, 'last_seen', p.last_seen, 'joined', p.user_id is not null)
      order by p.active desc, p.role, p.name) from profiles p), '[]');
end $$;

-- Языки переводчика/валидатора: [{"lang": "UZ", "role": "validator"}, {"lang": "KY", "role": "translator"}].
-- Записывает profile_langs и сводку в profiles (role — «валидатор», если хоть где-то валидатор; lang — основной язык).
create or replace function set_profile_langs(p_id int, p_langs jsonb) returns text language plpgsql as $$
declare x jsonb; v_lang text; v_role text; v_main text; v_sum text; v_seen text[] := '{}'; v_desc text := '';
begin
  if p_langs is null or jsonb_typeof(p_langs) <> 'array' or jsonb_array_length(p_langs) = 0 then
    perform app_error('Переводчику и валидатору нужно выбрать хотя бы один язык.');
  end if;
  delete from profile_langs where profile_id = p_id;
  for x in select * from jsonb_array_elements(p_langs) loop
    v_lang := upper(btrim(coalesce(x->>'lang', '')));
    v_role := coalesce(x->>'role', 'translator');
    if v_lang = '' then perform app_error('Переводчику и валидатору нужно выбрать язык.'); end if;
    if v_role not in ('translator','validator') then perform app_error('Роль на языке: переводчик или валидатор.'); end if;
    if not exists (select 1 from languages where code = v_lang) then perform app_error('Такого языка нет: ' || v_lang || '.'); end if;
    if v_lang = any(v_seen) then perform app_error('Язык ' || v_lang || ' указан дважды.'); end if;
    if v_role = 'validator' and exists (select 1 from profile_langs pl join profiles p on p.id = pl.profile_id
                                         where pl.lang = v_lang and pl.role = 'validator' and p.active and pl.profile_id <> p_id) then
      perform app_error('У языка ' || lang_name(v_lang) || ' уже есть валидатор.');
    end if;
    insert into profile_langs(profile_id, lang, role) values (p_id, v_lang, v_role);
    v_seen := v_seen || v_lang;
    v_desc := v_desc || case when v_desc = '' then '' else ', ' end || case when v_role = 'validator' then 'валидатор ' else 'переводчик ' end || v_lang;
  end loop;
  select pl.lang into v_main from profile_langs pl join languages l on l.code = pl.lang where pl.profile_id = p_id
   order by (pl.role = 'validator') desc, case when pl.lang = 'EN' then 0 else 1 end, l.sort limit 1;
  v_sum := case when exists (select 1 from profile_langs where profile_id = p_id and role = 'validator') then 'validator' else 'translator' end;
  update profiles set role = v_sum, lang = v_main where id = p_id;
  return v_desc;
end $$;

create or replace function admin_create_user(p_email text, p_name text, p_role text, p_lang text default null, p_langs jsonb default null) returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_email text := lower(btrim(coalesce(p_email, ''))); v_id int; v_desc text := '';
begin
  perform require_owner(u);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform app_error('Проверьте адрес почты.'); end if;
  if p_role not in ('owner','validator','manager','translator','contractor','reader') then perform app_error('Неизвестная роль.'); end if;
  if exists (select 1 from profiles where lower(email) = v_email) then perform app_error('Человек с такой почтой уже есть.'); end if;
  if p_role in ('translator','validator') then
    -- временно ставим язык, чтобы выполнить правило «у переводчика есть язык»; дальше — set_profile_langs
    insert into profiles(email, name, role, lang) values (v_email, coalesce(nullif(btrim(p_name), ''), v_email), 'translator',
      (select code from languages order by sort limit 1)) returning id into v_id;
    v_desc := set_profile_langs(v_id, coalesce(p_langs, jsonb_build_array(jsonb_build_object('lang', p_lang, 'role', p_role))));
  else
    insert into profiles(email, name, role, lang, contractor_no)
    values (v_email, coalesce(nullif(btrim(p_name), ''), v_email), p_role, null,
            case when p_role = 'contractor' then (select coalesce(max(contractor_no), 0) + 1 from profiles) end)
    returning id into v_id;
  end if;
  perform log_event(u, 'Добавлен пользователь', null, null, null, null,
    coalesce(nullif(btrim(p_name), ''), v_email) || ' <' || v_email || '>, ' || case when v_desc <> '' then v_desc else role_label(p_role) end);
  return v_id;
end $$;

create or replace function admin_update_user(p_user int, p_name text, p_role text, p_lang text default null, p_langs jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); o profiles; v_before text; v_desc text := '';
begin
  perform require_owner(u);
  select * into o from profiles where id = p_user;
  if not found then perform app_error('Пользователь не найден.'); end if;
  if o.id = u.id and p_role <> 'owner' then perform app_error('Нельзя снять роль владельца с самого себя.'); end if;
  if p_role not in ('owner','validator','manager','translator','contractor','reader') then perform app_error('Неизвестная роль.'); end if;
  v_before := o.name || ', ' || coalesce((select string_agg(case when role = 'validator' then 'валидатор ' else 'переводчик ' end || lang, ', ' order by lang)
                                            from profile_langs where profile_id = o.id), role_label(o.role));
  update profiles set name = coalesce(nullif(btrim(p_name), ''), o.name) where id = o.id;
  if p_role in ('translator','validator') then
    if o.role not in ('translator','validator') then update profiles set role = 'translator', lang = (select code from languages order by sort limit 1) where id = o.id; end if;
    v_desc := set_profile_langs(o.id, coalesce(p_langs, jsonb_build_array(jsonb_build_object('lang', p_lang, 'role', p_role))));
  else
    delete from profile_langs where profile_id = o.id;
    update profiles set role = p_role, lang = null,
      contractor_no = case when p_role = 'contractor' then coalesce(o.contractor_no, (select coalesce(max(contractor_no), 0) + 1 from profiles)) else o.contractor_no end
    where id = o.id;
  end if;
  perform log_event(u, 'Изменён пользователь', null, null, null, v_before,
    coalesce(nullif(btrim(p_name), ''), o.name) || ', ' || case when v_desc <> '' then v_desc else role_label(p_role) end, o.email);
end $$;

create or replace function admin_set_active(p_user int, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); o profiles;
begin
  perform require_owner(u);
  if p_user = u.id then perform app_error('Нельзя отключить самого себя.'); end if;
  select * into o from profiles where id = p_user;
  if not found then perform app_error('Пользователь не найден.'); end if;
  if p_active and exists (select 1 from profile_langs mine join profile_langs other on other.lang = mine.lang and other.role = 'validator' and other.profile_id <> mine.profile_id
                          join profiles v on v.id = other.profile_id and v.active
                          where mine.profile_id = o.id and mine.role = 'validator') then
    perform app_error('У одного из языков этого человека уже есть другой валидатор. Сначала поменяйте языки.');
  end if;
  update profiles set active = p_active where id = o.id;
  perform log_event(u, case when p_active then 'Пользователь включён' else 'Пользователь отключён' end, null, null, null, null, null, o.name || ' <' || o.email || '>');
end $$;

create or replace function admin_languages() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  perform require_owner(u);
  return coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name, 'smartcat', l.smartcat_code, 'kind', l.kind, 'active', l.active,
      'validator', (select v.name from profile_langs pl join profiles v on v.id = pl.profile_id where pl.lang = l.code and pl.role = 'validator' and v.active limit 1),
      'unchecked', (select count(*) from translations x join terms t on t.id = x.term_id where t.status = 'active' and x.lang = l.code and x.status = 'unchecked'))
    order by case when l.code = 'EN' then 0 else 1 end, l.sort, l.code) from languages l), '[]');
end $$;

create or replace function admin_add_language(p_code text, p_name text, p_smartcat text, p_kind text default 'full') returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform require_owner(u);
  if v_code !~ '^[A-Z]{2,8}$' then perform app_error('Код языка — латинские буквы, например FR.'); end if;
  if btrim(coalesce(p_name, '')) = '' then perform app_error('Впишите название языка.'); end if;
  if btrim(coalesce(p_smartcat, '')) = '' then perform app_error('Впишите код языка в Smartcat, например fr.'); end if;
  if p_kind not in ('full','short') then perform app_error('Тип языка: полный или сокращённый.'); end if;
  if exists (select 1 from languages where code = v_code) then perform app_error('Такой язык уже есть.'); end if;
  insert into languages(code, name, smartcat_code, kind, sort) values (v_code, btrim(p_name), btrim(p_smartcat), p_kind, (select coalesce(max(sort), 0) + 1 from languages));
  perform log_event(u, 'Добавлен язык', null, null, v_code, null, btrim(p_name) || ' (' || btrim(p_smartcat) || ', ' || case when p_kind = 'full' then 'полный' else 'сокращённый' end || ')');
end $$;

create or replace function admin_update_language(p_code text, p_name text, p_smartcat text, p_kind text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); o languages;
begin
  perform require_owner(u);
  select * into o from languages where code = p_code;
  if not found then perform app_error('Язык не найден.'); end if;
  if p_kind not in ('full','short') then perform app_error('Тип языка: полный или сокращённый.'); end if;
  update languages set name = coalesce(nullif(btrim(p_name), ''), o.name), smartcat_code = coalesce(nullif(btrim(p_smartcat), ''), o.smartcat_code),
    kind = p_kind, active = p_active where code = o.code;
  perform log_event(u, 'Изменён язык', null, null, o.code, o.name || ' (' || o.smartcat_code || ', ' || o.kind || ', ' || case when o.active then 'вкл' else 'выкл' end || ')',
    coalesce(nullif(btrim(p_name), ''), o.name) || ' (' || coalesce(nullif(btrim(p_smartcat), ''), o.smartcat_code) || ', ' || p_kind || ', ' || case when p_active then 'вкл' else 'выкл' end || ')');
end $$;

create or replace function admin_add_project(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); v text := btrim(coalesce(p_name, ''));
begin
  perform require_owner(u);
  if v = '' then perform app_error('Впишите название проекта.'); end if;
  if exists (select 1 from projects where lower(name) = lower(v)) then perform app_error('Такой проект уже есть.'); end if;
  insert into projects(name) values (v);
  perform log_event(u, 'Добавлен проект', null, null, null, null, v);
end $$;

create or replace function admin_update_project(p_project int, p_name text, p_closed boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); o projects; v text;
begin
  perform require_owner(u);
  select * into o from projects where id = p_project;
  if not found then perform app_error('Проект не найден.'); end if;
  v := coalesce(nullif(btrim(p_name), ''), o.name);
  if exists (select 1 from projects where lower(name) = lower(v) and id <> o.id) then perform app_error('Проект с таким названием уже есть.'); end if;
  update projects set name = v, closed = p_closed where id = o.id;
  perform log_event(u, case when o.closed <> p_closed then case when p_closed then 'Проект закрыт' else 'Проект открыт' end else 'Проект переименован' end,
    null, null, null, o.name, v);
end $$;

-- Владелец удаляет закрытый проект. Термины остаются, у них просто пропадает этот проект.
create or replace function admin_delete_project(p_project int) returns int
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); o projects; n int;
begin
  perform require_owner(u);
  select * into o from projects where id = p_project for update;
  if not found then perform app_error('Проект не найден.'); end if;
  if not o.closed then perform app_error('Удалить можно только закрытый проект. Сначала закройте его.'); end if;
  delete from term_projects where project_id = o.id;
  get diagnostics n = row_count;
  update requests set project_ids = array_remove(project_ids, o.id) where o.id = any(project_ids);
  delete from projects where id = o.id;
  perform log_event(u, 'Проект удалён', null, null, null, o.name, null, 'Убран у терминов: ' || n);
  return n;
end $$;

-- =====================================================================
-- API: загрузка готовых переводов от подрядчиков — одна таблица, сколько угодно языков.
-- p_rows: [{"tb": "", "ru": "Корзина", "definition": "...", "tr": {"KY": "...", "AM": "..."}}]
-- Термин ищется по номеру TB (если есть), иначе по русскому термину; если русских терминов
-- несколько — по определению. Язык без валидатора и сокращённый — «Без проверки»,
-- язык с валидатором — «Черновик» (его согласует валидатор). Уже существующие переводы не трогаем.
-- Сначала p_apply=false — показать, что с чем совпало; потом p_apply=true — записать.
-- =====================================================================
drop function if exists import_translations(text, jsonb, boolean);

-- Какой из терминов с одинаковым русским подходит по определению (null — не понять)
create or replace function pick_by_definition(p_ids int[], p_def text) returns int language sql stable as $$
  with c as (
    select t.id, case
        when norm_term(t.definition) = norm_term(p_def) then 1.0
        when norm_term(t.definition) <> '' and (norm_term(t.definition) like '%' || norm_term(p_def) || '%'
             or norm_term(p_def) like '%' || norm_term(t.definition) || '%') then 0.9
        else similarity(norm_term(t.definition), norm_term(p_def)) end as s
    from terms t where t.id = any(p_ids)
  ), r as (select id, s, row_number() over (order by s desc) n, lead(s) over (order by s desc) nx from c)
  select id from r where n = 1 and s >= 0.3 and (nx is null or s - nx >= 0.1)
$$;

drop function if exists import_translations(jsonb, boolean);
drop function if exists import_translations(jsonb, boolean, integer);
create or replace function import_translations(p_rows jsonb, p_apply boolean default false, p_projects int[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); e jsonb; i int := 0; v_tb text; v_ru text; v_def text; v_term int; v_ids int[];
  v_match text; v_lang text; v_text text; v_cur text; v_st text; v_lst jsonb; outv jsonb := '[]'; v_add int := 0;
  v text; k int; v_status text; t terms; v_cands jsonb; v_key text; v_seen text[] := '{}'; v_req text; v_new jsonb;
  v_code text; v_rid int; v_reqs jsonb := '[]'; v_warn text[]; v_proj int[] := '{}'; v_rq requests;
begin
  if u.role not in ('manager','owner') then perform app_error('Загружать переводы могут менеджер и владелец.'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform app_error('В таблице нет строк.'); end if;
  if jsonb_array_length(p_rows) > 5000 then perform app_error('Слишком много строк за раз (больше 5000). Разделите таблицу.'); end if;
  if cardinality(coalesce(p_projects, '{}')) > 0 then
    v_proj := array(select id from projects where id = any(p_projects) and not closed order by id);
    if cardinality(v_proj) <> cardinality(array(select distinct x from unnest(p_projects) x)) then perform app_error('Какой-то проект не найден или закрыт.'); end if;
  end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; v_term := null; v_cands := null; v_req := null;
    v_tb := upper(btrim(coalesce(e->>'tb', ''))); v_ru := btrim(coalesce(e->>'ru', '')); v_def := btrim(coalesce(e->>'definition', ''));
    v_key := norm_term(v_ru);
    if v_tb ~ '^TB-\d+$' then select id into v_term from terms where tb = v_tb and status = 'active'; end if;
    if v_term is null and v_ru <> '' then
      v_ids := array(select id from terms where ru_norm = v_key and status = 'active' order by tb);
      if cardinality(v_ids) = 1 then v_term := v_ids[1];
      elsif cardinality(v_ids) > 1 then
        -- «Данные» и «данные»: сначала точное совпадение с заглавными буквами, потом — по определению
        if (select count(*) from terms where id = any(v_ids) and ru_case_key(ru) = ru_case_key(v_ru)) = 1 then
          select id into v_term from terms where id = any(v_ids) and ru_case_key(ru) = ru_case_key(v_ru);
        end if;
        if v_term is null and v_def <> '' then v_term := pick_by_definition(v_ids, v_def); end if;
        if v_term is null then
          select jsonb_agg(jsonb_build_object('tb', tb, 'definition', definition) order by tb) into v_cands from terms where id = any(v_ids);
        end if;
      end if;
    end if;
    -- термина нет: может, он уже ждёт в заявке или встречался выше в этом же файле
    if v_term is null and v_cands is null and v_key <> '' then
      select q.code into v_req from requests q where q.status = 'pending' and q.type = 'new' and norm_term(q.ru) = v_key order by q.id limit 1;
    end if;
    v_match := case when v_term is not null then 'ok' when v_cands is not null then 'ambiguous'
                    when v_key = '' then 'not_found'
                    when v_req is not null then 'in_request'
                    when v_key = any(v_seen) then 'dup_in_file'
                    else 'new' end;
    v_lst := '{}'; v_new := '{}';
    for v_lang, v_text in select key, btrim(value) from jsonb_each_text(coalesce(e->'tr', '{}')) loop
      v_lang := upper(v_lang);
      if v_text = '' then continue; end if;
      v_status := case when lang_has_validator(v_lang) and coalesce((select kind from languages where code = v_lang), 'full') = 'full' then 'draft' else 'unchecked' end;
      if not exists (select 1 from languages l where l.code = v_lang and l.active) then v_st := 'no_lang';
      elsif v_match = 'new' then v_st := 'new'; v_new := v_new || jsonb_build_object(v_lang, v_text);
      elsif v_match = 'in_request' then
        -- термин ждёт в заявке: решаем после цикла — создать термин из заявки или дописать перевод в неё
        select rt.text into v_cur from request_translations rt join requests q on q.id = rt.request_id where q.code = v_req and rt.lang = v_lang;
        v_st := case when v_cur is null then 'to_request' when norm_term(v_cur) = norm_term(v_text) then 'same' else 'differs' end;
        if v_st = 'to_request' then v_new := v_new || jsonb_build_object(v_lang, v_text); end if;
      elsif v_term is null then v_st := 'skip';
      else
        select string_agg(x.text, '; ' order by x.sort, x.id) into v_cur from translations x
         where x.term_id = v_term and x.lang = v_lang and x.status <> 'obsolete';
        if v_cur is null then v_st := 'add';
        elsif exists (select 1 from translations x where x.term_id = v_term and x.lang = v_lang and x.status <> 'obsolete' and x.text_norm = norm_term(v_text))
          then v_st := 'same';
        else v_st := 'differs'; end if;
      end if;
      if p_apply and v_st = 'add' then
        select * into t from terms where id = v_term for update;
        k := 1;
        foreach v in array split_variants(v_text) loop
          perform add_translation(t.id, v_lang, v, v_status, u.id, k); k := k + 1;
        end loop;
        perform log_event(u, 'Загружен перевод', t.tb, null, v_lang, null, v_text, case when v_status = 'draft' then 'Черновик' else 'Без проверки' end);
        perform bump_term(t.id, u.id);
        v_add := v_add + 1;
      end if;
      v_lst := v_lst || jsonb_build_object(v_lang, jsonb_build_object('text', v_text, 'current', case when v_term is not null then v_cur end,
        'status', v_st, 'as', case when v_st = 'new' then 'request' else v_status end));
      v_cur := null;
    end loop;
    if v_match = 'new' and v_new = '{}'::jsonb then v_match := 'no_translations'; end if;
    -- Термин ждёт в заявке. Если ни у одного языка из файла нет валидатора (перевод уже принят подрядчиком) —
    -- создаём термин сразу и забираем в него заявку: её переводы становятся черновиками для своих валидаторов,
    -- остальные языки — «Нужен перевод». Иначе — дописываем перевод в заявку, его утвердит валидатор.
    if v_match = 'in_request' and v_new <> '{}'::jsonb then
      select * into v_rq from requests where code = v_req;
      if not exists (select 1 from jsonb_object_keys(v_new) key where lang_has_validator(key)) then
        v_match := 'from_request';
        v_lst := (select jsonb_object_agg(key, case when value->>'status' = 'to_request' then value || '{"status": "add", "as": "unchecked"}'::jsonb else value end)
                  from jsonb_each(v_lst));
        if p_apply then
          insert into terms(tb, ru, definition, examples, comment, created_by, updated_by)
          values ('TB-' || lpad(nextval('tb_seq')::text, 5, '0'), v_rq.ru, coalesce(nullif(v_rq.definition, ''), v_def), v_rq.examples, v_rq.comment, u.id, u.id)
          returning * into t;
          insert into term_projects select t.id, p.id from projects p where p.id = any(v_rq.project_ids || v_proj) on conflict do nothing;
          for v_lang, v_text in select key, value from jsonb_each_text(v_new) loop
            k := 1;
            foreach v in array split_variants(v_text) loop perform add_translation(t.id, v_lang, v, 'unchecked', u.id, k); k := k + 1; end loop;
            v_add := v_add + 1;
          end loop;
          for v_lang, v_text, v_rid in select rt.lang, rt.text, rt.author_id from request_translations rt where rt.request_id = v_rq.id loop
            if exists (select 1 from translations x where x.term_id = t.id and x.lang = v_lang) then continue; end if;
            k := 1;
            foreach v in array split_variants(v_text) loop
              perform add_translation(t.id, v_lang, v, case when lang_has_validator(v_lang) then 'draft' else 'unchecked' end, v_rid, k); k := k + 1;
            end loop;
          end loop;
          update requests set status = 'auto_removed', term_id = t.id, decided_by = u.id, decided_at = now(), version = version + 1,
            reason = 'Термин ' || t.tb || ' создан при загрузке таблицы: перевод ' || (select string_agg(key, ', ') from jsonb_object_keys(v_new) key)
                     || ' уже принят подрядчиком. Переводы из заявки — черновики для валидаторов своих языков.'
           where id = v_rq.id;
          perform log_event(u, 'Термин из таблицы', t.tb, v_rq.code, null, null, t.ru, 'Создан из заявки ' || v_rq.code || ' при загрузке таблицы');
          v_term := t.id;
        end if;
      else
        if p_apply then
          for v_lang, v_text in select key, value from jsonb_each_text(v_new) loop
            insert into request_translations(request_id, lang, text, author_id) values (v_rq.id, v_lang, v_text, u.id) on conflict do nothing;
            update requests set version = version + 1,
              target_langs = case when target_langs is null or v_lang = any(target_langs) then target_langs else target_langs || v_lang end
             where id = v_rq.id;
            perform log_event(u, 'Вписан перевод в заявку', null, v_req, v_lang, null, v_text, 'Из загруженной таблицы');
            v_add := v_add + 1;
          end loop;
        end if;
      end if;
    end if;
    -- новый термин → заявка на валидацию: её увидят валидаторы языков из файла
    if v_match = 'new' then
      v_seen := v_seen || v_key;
      if not exists (select 1 from jsonb_object_keys(v_new) key where lang_has_validator(key)) then
        -- ни у одного языка из файла нет валидатора — проверять некому: термин сразу, переводы «Без проверки»
        v_match := 'direct';
        if p_apply then
          insert into terms(tb, ru, definition, created_by, updated_by) values ('TB-' || lpad(nextval('tb_seq')::text, 5, '0'), v_ru, v_def, u.id, u.id)
          returning * into t;
          insert into term_projects select t.id, x from unnest(v_proj) x;
          for v_lang, v_text in select key, value from jsonb_each_text(v_new) loop
            k := 1;
            foreach v in array split_variants(v_text) loop perform add_translation(t.id, v_lang, v, 'unchecked', u.id, k); k := k + 1; end loop;
            v_add := v_add + 1;
          end loop;
          perform log_event(u, 'Термин из таблицы', t.tb, null, null, null, v_ru, 'Без проверки: ' || (select string_agg(key, ', ' order by key) from jsonb_object_keys(v_new) key));
          v_term := t.id;
        end if;
      elsif p_apply then
        v_warn := duplicate_warnings(v_ru, v_new, null, null);
        v_code := 'Z-' || lpad(nextval('req_seq')::text, 5, '0');
        insert into requests(code, type, ru, definition, comment, project_ids, lang, translation, warnings, author_id, target_langs)
        values (v_code, 'new', v_ru, v_def, 'Загружено из таблицы.', v_proj, null, '', v_warn, u.id,
                array(select jsonb_object_keys(v_new)))
        returning id into v_rid;
        insert into request_translations(request_id, lang, text, author_id) select v_rid, key, value, u.id from jsonb_each_text(v_new);
        perform log_event(u, 'Подана заявка', null, v_code, null, null, null, 'Новый термин из таблицы «' || v_ru || '»: ' ||
          (select string_agg(key, ', ' order by key) from jsonb_object_keys(v_new) key));
        v_reqs := v_reqs || to_jsonb(v_code);
        v_req := v_code;
      end if;
    end if;
    outv := outv || jsonb_build_object('row', i, 'match', v_match, 'tb', (select tb from terms where id = v_term),
      'ru', coalesce((select ru from terms where id = v_term), v_ru), 'definition', coalesce((select definition from terms where id = v_term), nullif(v_def, '')),
      'candidates', v_cands, 'request', v_req, 'langs', v_lst);
  end loop;
  return jsonb_build_object('rows', outv, 'added', v_add, 'requests', v_reqs);
end $$;

-- =====================================================================
-- API: напоминания в браузере — сохранить или убрать подписку этого браузера
-- =====================================================================
create or replace function save_push_subscription(p_sub jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  if coalesce(p_sub->>'endpoint', '') !~ '^https://' or coalesce(p_sub->'keys'->>'p256dh', '') = '' or coalesce(p_sub->'keys'->>'auth', '') = '' then
    perform app_error('Браузер не дал подписку на уведомления. Попробуйте ещё раз.');
  end if;
  insert into push_subs(endpoint, profile_id, p256dh, auth) values (p_sub->>'endpoint', u.id, p_sub->'keys'->>'p256dh', p_sub->'keys'->>'auth')
  on conflict (endpoint) do update set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function remove_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile();
begin
  delete from push_subs where endpoint = p_endpoint and profile_id = u.id;
end $$;

-- =====================================================================
-- Вход только для добавленных владельцем людей
-- =====================================================================
create or replace function only_invited_users() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where lower(email) = lower(new.email) and active) then
    raise exception 'Этот адрес не добавлен в глоссарий. Обратитесь к владельцу.';
  end if;
  return new;
end $$;

drop trigger if exists only_invited_users on auth.users;
create trigger only_invited_users before insert on auth.users for each row execute function only_invited_users();

-- =====================================================================
-- Права на вызов: браузеру — только API, только после входа
-- =====================================================================
revoke all on all functions in schema public from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'me()', 'set_prefs(jsonb)', 'set_avatar(text)', 'dashboard()',
    'glossary_page(text, integer, text, text, integer, integer, boolean, text[])', 'recent_terms(integer)', 'term_card(integer, text)',
    'similar_terms(text)', 'check_duplicates(text, jsonb, integer)', 'submit_request(jsonb)', 'set_request_translation(integer, text, text)',
    'edit_request(integer, jsonb)', 'approve_request(integer, integer, boolean)', 'reject_request(integer, integer)',
    'lang_requests(text)', 'my_requests()', 'all_requests(text, text)', 'add_request_comment(integer, text)', 'list_request_comments(integer)',
    'set_cell_text(integer, text, text, integer)', 'set_lang_approval(jsonb, text, boolean)', 'edit_translation(integer, text, text)',
    'edit_lang_fields(integer, text, jsonb, integer)', 'set_unused(integer, text, boolean)', 'set_unused_many(integer[], text, boolean)',
    'propose_obsolete(integer, text)', 'answer_obsolete(integer, text, text)', 'close_obsolete(integer)',
    'edit_ru(integer, integer, jsonb)', 'set_term_project(integer[], integer, boolean)', 'archive_term(integer, integer)', 'restore_term(integer, integer)', 'delete_term(integer, text)',
    'merge_terms(integer, integer, jsonb)', 'add_term_comment(integer, text)', 'hide_term_comment(integer)',
    'work_page(text, text, text, integer, text, integer, integer, boolean)', 'archive_lists(text)', 'log_page(jsonb, integer, integer)',
    'export_data(text[], integer)', 'export_contractor(text[], integer)', 'export_view(integer)', 'export_count(integer)', 'log_export(text[], integer, text, integer)', 'export_history()',
    'admin_users()', 'admin_create_user(text, text, text, text, jsonb)', 'admin_update_user(integer, text, text, text, jsonb)', 'admin_set_active(integer, boolean)',
    'admin_languages()', 'admin_add_language(text, text, text, text)', 'admin_update_language(text, text, text, text, boolean)',
    'admin_add_project(text)', 'admin_update_project(integer, text, boolean)', 'admin_delete_project(integer)',
    'withdraw_request(integer)', 'set_lang_optional(integer, text, boolean)', 'import_translations(jsonb, boolean, integer[])',
    'submit_feedback(text, text, text)', 'save_push_subscription(jsonb)', 'remove_push_subscription(text)', 'feedback_list(text)', 'answer_feedback(integer, text, text)'
  ] loop
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;

commit;
