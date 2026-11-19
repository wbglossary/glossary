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
