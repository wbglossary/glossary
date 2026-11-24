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
const reg = () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });

/** Карточка на Главной: включить или выключить напоминания в этом браузере. */
export function PushCard() {
  const [state, setState] = useState<'loading' | 'off' | 'on' | 'blocked' | 'unsupported'>('loading');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!supported()) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('blocked'); return; }
    reg().then((r) => r.pushManager.getSubscription()).then((s) => setState(s ? 'on' : 'off')).catch(() => setState('off'));
  }, []);
  if (state === 'loading' || state === 'unsupported') return null;
  const enable = async () => {
    setBusy(true); setErr(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'blocked' : 'off'); return; }
      const r = await reg();
      const sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(VAPID_PUBLIC) });
      await rpc('save_push_subscription', { p_sub: sub.toJSON() });
      setState('on');
    } catch (e) { setErr((e as Error).message || 'Не получилось включить.'); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await (await reg()).pushManager.getSubscription();
      if (s) { await rpc('remove_push_subscription', { p_endpoint: s.endpoint }); await s.unsubscribe(); }
      setState('off');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card push-card">
      <div>
        <b>🔔 Напоминания в браузере</b>
        <div className="muted small">
          {state === 'on' ? 'Включены в этом браузере. Раз в неделю придёт короткое напоминание о ваших терминах.'
            : state === 'blocked' ? 'Браузер запретил уведомления для сайта. Разрешите их в настройках сайта (значок замка в адресной строке).'
            : 'Раз в неделю — короткое (и смешное) напоминание о ваших терминах.'}
        </div>
        {err ? <div className="small" style={{ color: 'var(--red)' }}>{err}</div> : null}
      </div>
      {state === 'off' ? <Button kind="primary" small disabled={busy} onClick={enable}>Включить</Button> : null}
      {state === 'on' ? <Button small disabled={busy} onClick={disable}>Выключить</Button> : null}
    </div>
  );
}
