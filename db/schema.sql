-- Схема базы веб-админки глоссария (ТЗ v3.6).
-- Применяется к пустой базе: Supabase → SQL Editor → вставить → Run. Потом db/functions.sql.
-- Чтобы начать с нуля в уже настроенной базе — сначала db/reset.sql.
-- Таблицы закрыты от браузера (RLS без политик); всё делают функции из functions.sql.

create extension if not exists pg_trgm;

-- ---------- Нормализация для поиска и дублей ----------
-- Не учитывает регистр, ё/е, пробелы (включая неразрывные), дефисы и тире, кавычки,
-- похожие латинские и русские буквы.
create or replace function norm_term(t text) returns text
language sql immutable parallel safe as $$
  select translate(
    regexp_replace(
      regexp_replace(
        regexp_replace(replace(lower(coalesce(t, '')), 'ё', 'е'),
          '[[:space:]' || chr(160) || chr(8192) || '-' || chr(8203) || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', '', 'g'),
        '[-' || chr(173) || chr(8208) || '-' || chr(8213) || chr(8722) || ']', '', 'g'),
      '[«»“”„‟"''‘’‚`]', '', 'g'),
    'abcehkmoptxy', 'авсенкмортху')
$$;

-- ---------- Справочники ----------
create table languages (
  code          text primary key,               -- EN, KA, ...
  name          text not null,                  -- английский
  smartcat_code text not null,                  -- en-US
  kind          text not null default 'full' check (kind in ('full','short')),  -- полный / сокращённый глоссарий
  sort          int  not null default 100,
  active        boolean not null default true
);

create table projects (
  id     serial primary key,
  name   text not null unique,
  closed boolean not null default false
);

create table profiles (
  id            serial primary key,
  user_id       uuid unique,                    -- auth.users.id (запоминается при первом входе)
  email         text not null unique,
  name          text not null,
  role          text not null check (role in ('owner','validator','manager','translator','contractor','reader')),
  lang          text references languages(code), -- язык переводчика и валидатора
  contractor_no int unique,                     -- «Подрядчик 1», «Подрядчик 2»…
  avatar        text,                           -- код пиксельного животного
  active        boolean not null default true,
  prefs         jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_seen     timestamptz,
  check ((role in ('translator','validator')) = (lang is not null))
);
-- У языка один действующий валидатор
create unique index one_validator_per_lang on profiles (lang) where role = 'validator' and active;

create table settings (key text primary key, value text not null);
insert into settings(key, value) values ('ru_smartcat_code', 'ru-RU');

-- ---------- Термины ----------
create sequence tb_seq start 1;
create sequence req_seq start 1;

create table terms (
  id             serial primary key,
  tb             text not null unique,          -- TB-00001; при первом утверждении, не переиспользуется
  ru             text not null,
  ru_norm        text generated always as (norm_term(ru)) stored,
  definition     text not null default '',
  examples       text not null default '',
  context        text not null default '',
  comment        text not null default '',
  status         text not null default 'active' check (status in ('active','archived')),
  archive_reason text,                          -- manual / all_unused
  created_at     timestamptz not null default now(),
  created_by     int,                           -- profiles.id
  updated_at     timestamptz not null default now(),
  updated_by     int,
  version        int not null default 1         -- защита от одновременных правок
);
create index terms_ru_norm_trgm on terms using gin (ru_norm gin_trgm_ops);
create index terms_status on terms (status, created_at desc);

-- Номера, выведенные из оборота (объединение дублей, удаление)
create table retired_tb (
  tb          text primary key,
  merged_into text,
  at          timestamptz not null default now()
);

create table term_projects (
  term_id    int not null references terms(id) on delete cascade,
  project_id int not null references projects(id),
  primary key (term_id, project_id)
);

-- Языковая часть термина: поля на языке, «Как нельзя», «Не используется», черновик полей
create table term_langs (
  term_id    int  not null references terms(id) on delete cascade,
  lang       text not null references languages(code),
  definition text not null default '',
  examples   text not null default '',
  context    text not null default '',
  forbidden  jsonb not null default '[]',      -- [{"text": "...", "note": "..."}]
  draft      jsonb,                             -- изменения полей от переводчика, ждут валидатора
  unused     boolean not null default false,    -- «Не используется»
  primary key (term_id, lang)
);

create table translations (
  id          serial primary key,
  term_id     int  not null references terms(id) on delete cascade,
  lang        text not null references languages(code),
  text        text not null,
  text_norm   text generated always as (norm_term(text)) stored,
  sort        int  not null default 1,          -- 1 — основной, дальше варианты
  status      text not null check (status in ('draft','unchecked','approved','obsolete')),
  created_at  timestamptz not null default now(),
  created_by  int,
  approved_at timestamptz,
  approved_by int,
  obsolete_at timestamptz,
  replaced_by int references translations(id)
);
create index translations_term on translations (term_id, lang);
create index translations_norm_trgm on translations using gin (text_norm gin_trgm_ops);
create index translations_lang_status on translations (lang, status);

-- ---------- Заявки ----------
-- new — новый термин; translation — перевод к существующему; variant; replace; obsolete — просьба «Устарел»
create table requests (
  id             serial primary key,
  code           text not null unique,          -- Z-00001
  type           text not null check (type in ('new','translation','variant','replace','obsolete')),
  status         text not null default 'pending' check (status in ('pending','approved','rejected','auto_removed','closed')),
  term_id        int references terms(id) on delete set null,
  target_translation_id int references translations(id) on delete set null,
  ru             text not null default '',
  definition     text not null default '',
  examples       text not null default '',
  context        text not null default '',
  comment        text not null default '',
  project_ids    int[] not null default '{}',
  lang           text references languages(code),  -- язык перевода (null — заявка менеджера «на все языки»)
  translation    text not null default '',
  lang_fields    jsonb not null default '{}',   -- определение/примеры/контекст/«как нельзя» на языке
  reason         text not null default '',
  warnings       text[] not null default '{}',
  author_id      int references profiles(id),
  created_at     timestamptz not null default now(),
  decided_by     int,
  decided_at     timestamptz,
  version        int not null default 1
);
create index requests_status on requests (status, type, lang);
create index requests_author on requests (author_id, created_at desc);

-- Переводы, вписанные в заявку менеджера разными языками
create table request_translations (
  request_id int  not null references requests(id) on delete cascade,
  lang       text not null references languages(code),
  text       text not null,
  author_id  int references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (request_id, lang)
);

-- Ответы на просьбу «Устарел» («оставить»; «не используется» видно по term_langs.unused)
create table request_answers (
  request_id int  not null references requests(id) on delete cascade,
  lang       text not null,
  answer     text not null check (answer in ('keep','unused')),
  comment    text not null default '',
  author_id  int references profiles(id),
  at         timestamptz not null default now(),
  primary key (request_id, lang)
);

create table request_comments (
  id         serial primary key,
  request_id int not null references requests(id) on delete cascade,
  author_id  int references profiles(id),
  body       text not null,
  created_at timestamptz not null default now()
);

create table term_comments (
  id         serial primary key,
  term_id    int not null references terms(id) on delete cascade,
  author_id  int references profiles(id),
  body       text not null,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);
create index term_comments_term on term_comments (term_id, created_at);

-- ---------- Журнал (только добавление) ----------
create table audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  user_id      int,             -- profiles.id; имя показывается с учётом анонимности
  user_label   text not null,   -- имя на момент события (видит владелец)
  action       text not null,
  tb           text,
  request_code text,
  lang         text,
  before       text,
  after        text,
  details      text
);
create index audit_log_at on audit_log (at desc);
create index audit_log_tb on audit_log (tb, at desc);
create index audit_log_user on audit_log (user_id, at desc);

create or replace function audit_log_readonly() returns trigger language plpgsql as $$
begin
  raise exception 'Журнал нельзя менять или очищать';
end $$;
create trigger audit_log_no_update before update or delete on audit_log for each row execute function audit_log_readonly();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_readonly();

-- ---------- Выгрузки ----------
create table exports (
  id         serial primary key,
  at         timestamptz not null default now(),
  user_id    int references profiles(id),
  langs      text[] not null,
  project    text not null,
  format     text not null,
  count      int not null
);

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

-- ---------- Закрываем таблицы от браузерных ключей ----------
do $$
declare t text;
begin
  foreach t in array array['languages','projects','profiles','settings','terms','retired_tb','term_projects','term_langs',
    'translations','requests','request_translations','request_answers','request_comments','term_comments','audit_log','exports','feedback'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
