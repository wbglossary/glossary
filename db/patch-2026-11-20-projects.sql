-- Обновление 20.11.2026 (3): добавить выбранные термины в проект / убрать из проекта.
-- Выполнить один раз в Supabase → SQL Editor. Данные не меняются.

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

revoke all on function set_term_project(integer[], integer, boolean) from public, anon;
grant execute on function set_term_project(integer[], integer, boolean) to authenticated;
