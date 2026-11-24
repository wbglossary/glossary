import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { can, rpc, ROLE_LABELS, supabase, type Me } from './api';
import { readRoute, type Route } from './router';
import { Avatar, ANIMALS, AVATAR_KEYS } from './ui/Avatar';
import { Button, Message } from './ui/kit';
import { HomePage } from './pages/Home';
import { GlossaryPage } from './pages/Glossary';
import { WorkPage } from './pages/Work';
import { ProposePage } from './pages/Propose';
import { MyRequestsPage } from './pages/MyRequests';
import { ArchivePage } from './pages/Archive';
import { ExportPage } from './pages/Export';
import { LogPage } from './pages/Log';
import { AdminPage } from './pages/Admin';
import { FeedbackPage } from './pages/Feedback';
import { HelpPage } from './pages/Help';
import { ImportTranslationsPage } from './pages/ImportTranslations';
import { FeedbackModal } from './ui/FeedbackModal';
import { Icon } from './ui/Icon';
import { menuHint } from './menuHints';
import { ThemeButton } from './theme';

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(readRoute());
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Только для локальной проверки с подменой Supabase (scripts/dev-mock.ts): ?as=ven — вход тестовым пользователем
    const init = async () => {
      const as = new URLSearchParams(window.location.search).get('as');
      if (import.meta.env.DEV && as && import.meta.env.VITE_SUPABASE_URL.startsWith('http://localhost')) {
        const s = await (await fetch(`${import.meta.env.VITE_SUPABASE_URL}/dev/session?as=${as}`)).json();
        await supabase.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
        window.location.reload(); // чистый старт под новым пользователем
        return;
      }
      setSession((await supabase.auth.getSession()).data.session);
    };
    init();
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const loadMe = useCallback(async () => {
    try { setMe(await rpc<Me>('me')); setMeError(null); }
    catch (e) { setMe(null); setMeError((e as Error).message); }
  }, []);
  useEffect(() => { if (session) loadMe(); else setMe(null); }, [session, loadMe]);

  if (session === undefined) return <div className="center">Загрузка…</div>;
  if (!session) return <Login />;
  if (meError) {
    return (
      <div className="center">
        <div className="login-card">
          <h1>Глоссарий</h1>
          <Message kind="error">{meError}</Message>
          <p className="muted">Вы вошли как {session.user.email}.</p>
          <Button onClick={() => supabase.auth.signOut()}>Выйти</Button>
        </div>
      </div>
    );
  }
  if (!me) return <div className="center">Загрузка…</div>;

  const showWork = can.work(me) || me.role === 'owner' || can.directLangs(me).length > 0;
  const menu: { page: string; label: string; show: boolean }[] = [
    { page: 'home', label: 'Главная', show: true },
    { page: 'glossary', label: 'Глоссарий', show: true },
    { page: 'work', label: 'Рабочая область', show: showWork },
    { page: 'propose', label: 'Предложить термин', show: can.submit(me) },
    { page: 'my-requests', label: can.allRequests(me) ? 'Заявки' : 'Мои заявки', show: can.submit(me) || can.allRequests(me) },
    { page: 'archive', label: 'Архив', show: can.archive(me) },
    { page: 'export', label: 'Выгрузка', show: can.export(me) },
    { page: 'import', label: 'Загрузка терминов', show: me.role === 'manager' || me.role === 'owner' },
    { page: 'log', label: 'Журнал изменений', show: can.log(me) },
    { page: 'admin', label: 'Администрирование', show: can.admin(me) },
    { page: 'help', label: 'Инструкция', show: true },
    { page: 'feedback', label: 'Обратная связь', show: true }
  ];
  const visible = menu.filter((m) => m.show);
  const current = visible.find((m) => m.page === route.page) ? route.page : 'home';
  const props = { me, route, reloadMe: loadMe };
  const langName = me.lang ? me.languages.find((l) => l.code === me.lang)?.name : null;

  return (
    <div className="layout">
      <nav className="side">
        <div className="logo"><i /> Глоссарий</div>
        {visible.map((m, i) => {
          const hint = menuHint(m.page, me);
          return (
            <a key={m.page} href={`#/${m.page}`} className={`${current === m.page ? 'active' : ''}${m.page === 'help' ? ' sep' : ''}`}
              aria-describedby={hint ? `hint-${i}` : undefined}>
              {m.label}
              {hint ? <span className="nav-hint" role="tooltip" id={`hint-${i}`}>{hint}</span> : null}
            </a>
          );
        })}
      </nav>
      <div className="main">
        <header className="top">
          <div className="who">
            <button className="btn link" title="Выбрать аватар" onClick={() => setAvatarOpen(true)}><Avatar name={me.avatar} size={30} /></button>
            <span><b>{me.name}</b> · {me.langs.length > 1
              ? me.langs.map((l) => `${l.role === 'validator' ? 'Валидатор' : 'Переводчик'} ${l.code}`).join(' · ')
              : <>{ROLE_LABELS[me.role]}{langName ? ` (${langName})` : ''}</>}{me.role === 'contractor' ? ` ${me.contractor_no}` : ''}</span>
            <ThemeButton />
            <Button small kind="link" onClick={() => supabase.auth.signOut()}>Выйти</Button>
          </div>
        </header>
        <section className="work">
          {current === 'home' && <HomePage {...props} />}
          {current === 'glossary' && <GlossaryPage {...props} />}
          {current === 'work' && <WorkPage {...props} />}
          {current === 'propose' && <ProposePage {...props} />}
          {current === 'my-requests' && <MyRequestsPage {...props} />}
          {current === 'archive' && <ArchivePage {...props} />}
          {current === 'export' && <ExportPage {...props} />}
          {current === 'import' && <ImportTranslationsPage {...props} />}
          {current === 'log' && <LogPage {...props} />}
          {current === 'admin' && <AdminPage {...props} />}
          {current === 'help' && <HelpPage {...props} />}
          {current === 'feedback' && <FeedbackPage {...props} />}
        </section>
      </div>
      <button className="fb-fab" onClick={() => setFeedbackOpen(true)} aria-label="Обратная связь: вопрос, проблема или идея">
        <Icon name="comment" size={18} /><span>Обратная связь</span>
      </button>
      {feedbackOpen ? <FeedbackModal page={current} pageLabel={visible.find((m) => m.page === current)?.label ?? ''} onClose={() => setFeedbackOpen(false)} /> : null}
      {avatarOpen ? (
        <div className="modal-back" onMouseDown={() => setAvatarOpen(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Выберите аватар</h3>
            <div className="avatars">
              {AVATAR_KEYS.map((k) => (
                <button key={k} className={me.avatar === k ? 'on' : ''}
                  onClick={async () => { await rpc('set_avatar', { p_avatar: k }); await loadMe(); setAvatarOpen(false); }}>
                  <Avatar name={k} size={48} />{ANIMALS[k].name}
                </button>
              ))}
            </div>
            <div className="modal-actions"><Button onClick={() => setAvatarOpen(false)}>Закрыть</Button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Login() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Ошибка входа приходит в адресе. Чужой адрес почты база не пускает.
    const p = new URLSearchParams(window.location.search + '&' + window.location.hash.replace(/^#/, ''));
    const d = p.get('error_description');
    if (d) {
      setError(/Database error|не добавлен/i.test(d)
        ? 'Этот адрес почты не добавлен в глоссарий. Попросите владельца добавить вас и войдите снова тем же аккаунтом Google.'
        : 'Не получилось войти. Попробуйте ещё раз.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);
  const login = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { prompt: 'select_account' } }
    });
    if (error) setError('Не получилось открыть вход через Google. Попробуйте ещё раз.');
  };
  return (
    <div className="center">
      <div className="login-card">
        <div className="row gap"><Avatar name="cat" size={44} /><h1>Глоссарий</h1></div>
        <p className="muted">Войдите своим Google-аккаунтом. Доступ есть только у тех, кого добавил владелец.</p>
        {error ? <Message kind="error">{error}</Message> : null}
        <button className="btn primary google" onClick={login}>Войти через Google</button>
      </div>
    </div>
  );
}
