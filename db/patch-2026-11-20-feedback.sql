-- Обновление 20.11.2026 (4): обратная связь о сайте.
-- Выполнить один раз в Supabase → SQL Editor.

-- ---------- Обратная связь о сайте ----------
create table feedback (
  id          serial primary key,
  author_id   int not null references profiles(id),
  kind        text not null check (kind in ('question','problem','idea')),
  body        text not null,
  page        text not null default '',     -- где был человек, когда писал
  status      text not null default 'new' check (status in ('new','in_progress','done')),
  answer      text not null default '',
  answered_by int references profiles(id),
  answered_at timestamptz,
  answer_seen boolean not null default true, -- автор ещё не видел новый ответ — false
  created_at  timestamptz not null default now()
);
create index feedback_author on feedback (author_id, created_at desc);
create index feedback_status on feedback (status, created_at desc);
alter table feedback enable row level security;

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

create or replace function dashboard() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles := app_profile(); cards jsonb := '[]'; n int; l record;
begin
  if u.role in ('translator','validator') then
    if (select kind from languages where code = u.lang) = 'full' then
      select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, u.lang) = 'need';
      cards := cards || jsonb_build_object('key', 'need', 'label', 'Нужен перевод', 'count', n, 'link', 'work?tab=mine&status=need');
    end if;
    select count(*) into n from terms t where t.status = 'active' and lang_status(t.id, u.lang) = 'draft';
    cards := cards || jsonb_build_object('key', 'draft', 'label', case when u.role = 'validator' then 'Черновики на согласование' else 'Мои черновики ждут валидатора' end,
      'count', n, 'link', 'work?tab=mine&status=draft');
  end if;
  if u.role = 'validator' then
    select count(*) into n from requests r where r.status = 'pending' and r.type <> 'obsolete' and request_for_lang(r, u.lang);
    cards := cards || jsonb_build_object('key', 'requests', 'label', 'Заявки моего языка', 'count', n, 'link', 'work?tab=requests');
    select count(*) into n from requests r where r.status = 'pending' and r.type = 'obsolete' and request_for_lang(r, u.lang);
    cards := cards || jsonb_build_object('key', 'obsolete', 'label', 'Просьбы «Устарел»', 'count', n, 'link', 'work?tab=requests');
    select count(*) into n from translations x join terms t on t.id = x.term_id where t.status = 'active' and x.lang = u.lang and x.status = 'unchecked';
    if n > 0 then cards := cards || jsonb_build_object('key', 'review', 'label', 'На пересмотр', 'count', n, 'link', 'work?tab=review'); end if;
    if is_en_validator(u) then
      select count(*) into n from (select ru_norm from terms where status = 'active' group by ru_norm having count(*) > 1) d;
      cards := cards || jsonb_build_object('key', 'dupes', 'label', 'Одинаковые русские термины', 'count', n, 'link', 'glossary?dupes=1');
    end if;
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

revoke all on function feedback_kind_label(text) from public, anon, authenticated;
revoke all on function submit_feedback(text, text, text), feedback_list(text), answer_feedback(integer, text, text) from public, anon;
grant execute on function submit_feedback(text, text, text), feedback_list(text), answer_feedback(integer, text, text) to authenticated;
