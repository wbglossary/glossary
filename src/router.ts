import type { Me } from './api';

export type Route = { page: string; params: URLSearchParams };

/** Адреса страниц после #: работают на GitHub Pages без настройки сервера. */
export function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [page, qs] = h.split('?');
  return { page: page || 'home', params: new URLSearchParams(qs ?? '') };
}

export function go(page: string, params?: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
  window.location.hash = '/' + page + (qs.toString() ? '?' + qs.toString() : '');
}

export interface PageProps { me: Me; route: Route; reloadMe: () => Promise<void> }

/** Тихо поменять параметр в адресе (без перехода): например, номер открытой карточки, чтобы ссылку можно было отправить. */
export function setHashParam(key: string, value: string | null) {
  const r = readRoute();
  const cur = r.params.get(key);
  if (cur === value || (!cur && !value)) return;
  if (value) r.params.set(key, value); else r.params.delete(key);
  const qs = r.params.toString();
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + '#/' + r.page + (qs ? '?' + qs : ''));
}
export const hashParam = (key: string) => readRoute().params.get(key);
