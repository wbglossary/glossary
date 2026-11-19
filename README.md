# Веб-админка глоссария

Статичный сайт (GitHub Pages) + Supabase (база, вход через Google, все права). Своего сервера нет: каждое действие — функция в базе, она сама проверяет, кто вы и что вам можно. Браузер напрямую к таблицам не допускается.

| Папка / файл | Что это |
|---|---|
| `db/schema.sql` | Таблицы базы |
| `db/functions.sql` | Все правила: заявки, утверждение, замены, архив, журнал, права, выгрузка |
| `src/` | Сам сайт (React) |
| `tests/db.test.ts` | Проверка правил ТЗ на встроенной базе (`npm test`) |
| `scripts/import-from-sheets.ts` | Перенос из Google Таблицы |
| `scripts/backup.ts` | Ночная копия и восстановление |
| `.github/workflows/` | Выкладка сайта и ночные копии |

---

## 1. Подготовить Supabase (один раз)

0. Если в базе уже стоит прошлая версия — сначала новый запрос с целиком `db/reset.sql` → **Run** (удалит старые таблицы и данные; владельца потом добавить заново, шаг 3).
1. **SQL Editor → New query** → вставь целиком `db/schema.sql` → **Run**.
2. Ещё один запрос → вставь целиком `db/functions.sql` → **Run**.
3. Добавь себя владельцем (ещё один запрос, со своей почтой Google):
   ```sql
   insert into profiles(email, name, role) values ('твоя.почта@gmail.com', 'Твоё имя', 'owner');
   ```
4. **Authentication → Sign In / Providers**: **Allow new users to sign up — ВКЛЮЧЕНО.**
   Это не дыра: функция в базе не даёт создать учётную запись почте, которой нет в списке пользователей. Если регистрацию выключить, новый человек не сможет войти через Google в первый раз.
5. **Authentication → Sign In / Providers → Google** — включено, ключи из Google Cloud вставлены (шаг 4 в «Админка — что подготовить»).
6. **Authentication → URL Configuration**: Site URL — адрес сайта, Redirect URLs — адрес сайта с `/**` и `http://localhost:3000/**`.

## 2. Запустить у себя на компьютере

1. Скопируй `.env.example` в `.env.local` и впиши `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` (Supabase → Project Settings → Data API). Оба значения не секретные.
2. В Терминале в папке `admin`:
   ```bash
   npm install
   ```
   ```bash
   npm test
   ```
   ```bash
   npm run dev
   ```
3. Открой http://localhost:3000 → «Войти через Google».

## 3. Перенести данные из Google Таблицы

1. В Google Таблице: **Файл → Скачать → Microsoft Excel (.xlsx)**.
2. В `.env.local` добавь строку `DATABASE_URL=…`: Supabase → кнопка **Connect** вверху → **Session pooler** → скопируй URI и вставь пароль базы вместо `[YOUR-PASSWORD]`. **Это секрет** — никому не отправляй.
3. В Терминале:
   ```bash
   npm run import -- "/путь/к/Глоссарий.xlsx"
   ```
4. Открой `import-report.txt` — там сколько перенесено и что не удалось. Перенос идёт целиком или не идёт совсем: при ошибке база не меняется.

## 4. Выложить сайт на GitHub Pages

1. В GitHub Desktop: **File → Add local repository** → папка `admin` → **create a repository** → имя `glossary` → **Publish repository**. Сними галочку «Keep this code private»: на бесплатном тарифе GitHub Pages работает только с публичными репозиториями. Секретов в коде нет — пароли и ключ базы хранятся в настройках GitHub и Supabase.
2. На github.com в репозитории:
   - **Settings → Pages → Source: GitHub Actions**.
   - **Settings → Secrets and variables → Actions → Variables**: `SUPABASE_URL` и `SUPABASE_ANON_KEY` (те же, что в `.env.local`).
   - **Settings → Secrets and variables → Actions → Secrets**: `DATABASE_URL` (для ночных копий).
3. Любое изменение, отправленное в `main`, само проверяется тестами и выкладывается. Адрес: `https://ник.github.io/glossary/`.
4. Добавь этот адрес в Supabase (URL Configuration) — как в шаге 1.6.

## 5. Ночные копии

Каждую ночь GitHub Actions делает копию базы (вкладка **Actions → Ночная копия базы → артефакт**), копии хранятся 30 дней. Эта же задача не даёт бесплатному Supabase уснуть.
Проверить восстановление до запуска: создай второй пустой проект Supabase, примени `db/schema.sql` и `db/functions.sql`, впиши его `DATABASE_URL` в `.env.local` и выполни
```bash
npm run backup -- --restore backups/backup-ГГГГ-ММ-ДД.json.gz
```

## 6. Как переехать на wblocalization

В коде нет адреса сайта, поэтому код менять не нужно.

1. Репозиторий: **Settings → General → Danger Zone → Transfer ownership** → `wblocalization` (нужны права в организации).
2. В новом месте проверь **Settings → Pages → Source: GitHub Actions** и заново заведи переменные и секрет из шага 4.2 (при переносе они не всегда сохраняются).
3. Новый адрес: `https://wblocalization.github.io/glossary/` (если имя репозитория то же).
4. Supabase → **Authentication → URL Configuration**: замени Site URL и Redirect URLs на новый адрес.
5. Google Cloud → **Clients → Glossary**: адрес возврата (`…supabase.co/auth/v1/callback`) не меняется. Если там добавлялись «Authorized JavaScript origins» со старым адресом — добавь новый.
6. Разошли команде новую ссылку. Термины, люди и журнал не теряются: они в Supabase.

## Проверить сайт без Supabase

Можно посмотреть сайт на своём компьютере с настоящими данными, ничего не настраивая. Встроенная база загружает перенесённый глоссарий и даёт тестовые входы.

```bash
npx tsx scripts/dev-mock.ts "../Глоссарий/Глоссарий — эталон для загрузки.xlsx"
```

В другом окне Терминала:

```bash
VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=dev npm run dev
```

Открой http://localhost:3000/?as=man — войдёшь менеджером. Другие роли: `owner` (владелец), `ven` (валидатор английского — главный редактор), `en` (переводчик EN), `vka` и `ka` (валидатор и переводчик KA), `con` (подрядчик), `reader`. Данные живут, пока запущена встроенная база.

## Ограничения бесплатного варианта

- Нет гарантий доступности; откат только на ночную копию.
- Писем нет: о новых заявках напоминает менеджер.
- Письма владельцу об ошибках пока нет (своего сервера нет). Ошибки видно в Supabase → **Logs**.
