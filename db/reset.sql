-- ВНИМАНИЕ: удаляет ВСЕ данные глоссария в базе (термины, людей, журнал).
-- Нужен один раз — чтобы перейти со старой схемы на новую, пока в базе нет настоящих данных.
-- После него: db/schema.sql, затем db/functions.sql, затем снова добавить себя владельцем.

drop trigger if exists only_invited_users on auth.users;

-- Таблицы и счётчики глоссария (старые и новые имена)
drop table if exists push_subs, feedback, audit_log, exports, request_comments, request_answers, request_translations, requests,
  term_comments, term_langs, term_projects, retired_tb, translations, terms, concept_projects, concepts,
  settings, profiles, projects, languages cascade;
drop sequence if exists tb_seq, req_seq;

-- Все наши функции (функции расширений, например pg_trgm, не трогаем)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as f
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute 'drop function if exists ' || r.f || ' cascade';
  end loop;
end $$;
