import { useEffect, useState } from 'react';
import { rpc } from './api';
import { Button } from './ui/kit';

/** Открытый ключ для уведомлений (закрытый хранится только в GitHub Secrets). */
const VAPID_PUBLIC = 'BDvHWZHEnLQxYr5aQ1nSRgV1IZotyHxnwQB076llxkUjCbLz5dvtqs8ND6IVSCgi753a61SEAHKN2dzL6j5qQxU';
const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const toBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const reg = async () => {
  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
  return navigator.serviceWorker.ready;   // ждём, пока помощник уведомлений заработает (в Edge и Safari это важно)
};

type Browser = 'edge' | 'chrome' | 'firefox' | 'safari' | 'yandex' | 'other';
const browser = (): Browser => {
  const u = navigator.userAgent;
  if (/Edg\//.test(u)) return 'edge';
  if (/YaBrowser/.test(u)) return 'yandex';
  if (/Firefox\//.test(u)) return 'firefox';
  if (/Chrome\//.test(u)) return 'chrome';
  if (/Safari\//.test(u)) return 'safari';
  return 'other';
};
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Куда нажать, чтобы разрешить уведомления — для каждого браузера */
const HOW_TO_ALLOW: Record<Browser, string> = {
  edge: 'В Edge: нажмите на значок замка (или перечёркнутого колокольчика) слева в адресной строке → «Разрешения для этого сайта» → «Уведомления» → «Разрешить». Потом обновите страницу и нажмите «Включить» ещё раз. Если колокольчика нет: Настройки Edge → «Файлы cookie и разрешения сайтов» → «Уведомления» → выключите «Запрашивать без вывода» (тихие запросы).',
  chrome: 'В Chrome: нажмите на значок слева в адресной строке → «Настройки сайтов» → «Уведомления» → «Разрешить». Потом обновите страницу.',
  yandex: 'В Яндекс Браузере: нажмите на значок замка в адресной строке → «Уведомления» → «Разрешить». Потом обновите страницу.',
  firefox: 'В Firefox: нажмите на значок слева в адресной строке → у «Отправлять уведомления» уберите блокировку. Потом обновите страницу.',
  safari: 'В Safari: меню Safari → «Настройки» → «Веб-сайты» → «Уведомления» → для этого сайта выберите «Разрешить». Потом обновите страницу.',
  other: 'Разрешите уведомления для этого сайта в настройках браузера (обычно — значок замка слева в адресной строке) и обновите страницу.'
};

/** Карточка на Главной: включить или выключить напоминания в этом браузере, прислать проверочное. */
export function PushCard() {
  const [state, setState] = useState<'loading' | 'off' | 'on' | 'blocked' | 'unsupported'>('loading');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const b = browser();
  useEffect(() => {
    if (!supported()) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('blocked'); return; }
    reg().then((r) => r.pushManager.getSubscription()).then((s) => setState(s && Notification.permission === 'granted' ? 'on' : 'off')).catch(() => setState('off'));
  }, []);
  if (state === 'loading') return null;

  const enable = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'denied') { setState('blocked'); return; }
      if (perm !== 'granted') {
        // Edge и Chrome иногда не показывают окно «Разрешить?» (тихий запрос) — подскажем, куда нажать
        setErr('Браузер не показал вопрос о разрешении. ' + HOW_TO_ALLOW[b]);
        return;
      }
      const r = await reg();
      let sub = await r.pushManager.getSubscription();
      if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(VAPID_PUBLIC) });
      await rpc('save_push_subscription', { p_sub: sub.toJSON() });
      setState('on');
      await test(r);
    } catch (e) {
      const m = (e as Error).message || String(e);
      setErr(/push service|registration|AbortError|not available/i.test(m)
        ? `Браузер не смог подключиться к своей службе уведомлений (${m}). Это бывает в режиме «Инкогнито / InPrivate» и при включённом VPN или блокировщике. Попробуйте обычное окно.`
        : `Не получилось включить: ${m}`);
    } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const s = await (await reg()).pushManager.getSubscription();
      if (s) { await rpc('remove_push_subscription', { p_endpoint: s.endpoint }); await s.unsubscribe(); }
      setState('off');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  /** Проверочное уведомление — показывается прямо сейчас, без рассылки */
  const test = async (r?: ServiceWorkerRegistration) => {
    setErr(null);
    try {
      const sw = r ?? await reg();
      await sw.showNotification('Глоссарий: проверка 🔔', { body: 'Если вы видите это уведомление — напоминания будут приходить в этот браузер.', data: { url: location.href.split('#')[0] } });
      setNote('Отправили проверочное уведомление. Не видно? Проверьте режим «Не беспокоить» на компьютере и разрешение уведомлений для браузера в системных настройках.');
    } catch (e) { setErr('Проверочное уведомление не показалось: ' + ((e as Error).message || e)); }
  };

  return (
    <div className="card push-card">
      <div>
        <b>🔔 Напоминания в браузере</b>
        <div className="muted small">
          {state === 'on' ? 'Включены в этом браузере. Раз в неделю придёт короткое напоминание о ваших терминах.'
            : state === 'blocked' ? 'Браузер запретил уведомления для этого сайта. ' + HOW_TO_ALLOW[b]
            : state === 'unsupported' ? (isIOS()
              ? 'На iPhone и iPad уведомления работают, только если добавить сайт на экран «Домой»: кнопка «Поделиться» → «На экран «Домой»», потом открыть сайт с этой иконки.'
              : 'Этот браузер не поддерживает уведомления от сайтов. Откройте глоссарий в Chrome, Edge, Яндекс Браузере, Firefox или Safari.')
            : 'Раз в неделю — короткое (и смешное) напоминание о ваших терминах.'}
        </div>
        {err ? <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{err}</div> : null}
        {note ? <div className="small muted" style={{ marginTop: 4 }}>{note}</div> : null}
      </div>
      <div className="row gap">
        {state === 'off' ? <Button kind="primary" small disabled={busy} onClick={enable}>Включить</Button> : null}
        {state === 'on' ? <Button small disabled={busy} onClick={() => test()}>Прислать проверочное</Button> : null}
        {state === 'on' ? <Button small kind="link" disabled={busy} onClick={disable}>Выключить</Button> : null}
      </div>
    </div>
  );
}
