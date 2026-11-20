import { createClient } from '@supabase/supabase-js';

/** Подключение к Supabase. Ключ публичный: все права проверяет база. */
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
});

export class ApiError extends Error {
  conflict: boolean;
  constructor(message: string, conflict = false) {
    super(message);
    this.conflict = conflict;
  }
}

/** Вызов функции базы. Ошибки — простыми словами. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const msg = error.message || '';
    if (/Данные уже изменились/.test(msg)) throw new ApiError('Данные уже изменились, обновите страницу.', true);
    if (error.code === 'P0001') throw new ApiError(msg);
    if (/JWT|not authenticated/i.test(msg)) throw new ApiError('Сессия закончилась. Войдите снова.');
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    console.error(fn, error);
    throw new ApiError('Что-то пошло не так. Попробуйте ещё раз, а если не получится — напишите владельцу.');
  }
  return data as T;
}

// ---------- Типы ----------

export type Role = 'owner' | 'validator' | 'manager' | 'translator' | 'contractor' | 'reader';
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Владелец', validator: 'Валидатор', manager: 'Менеджер', translator: 'Переводчик', contractor: 'Подрядчик', reader: 'Читатель'
};

export interface Language { code: string; name: string; smartcat: string; kind: 'full' | 'short'; active: boolean; has_validator: boolean }
export interface Project { id: number; name: string; closed: boolean }
export interface Me {
  id: number; email: string; name: string; role: Role; lang: string | null; avatar: string; contractor_no: number | null;
  langs: { code: string; role: 'translator' | 'validator' }[];   // языки человека и роль на каждом
  prefs: { langs?: string[]; cols?: string[]; work_cols?: string[] }; is_en_validator: boolean; languages: Language[]; projects: Project[];
}

export const can = {
  submit: (m: Me) => m.role !== 'reader',
  validator: (m: Me) => m.langs.some((l) => l.role === 'validator'),
  validatorOf: (m: Me, lang: string) => m.langs.some((l) => l.code === lang && l.role === 'validator'),
  worksLang: (m: Me, lang: string) => m.langs.some((l) => l.code === lang),
  enValidator: (m: Me) => m.is_en_validator,
  editRu: (m: Me) => m.role === 'owner' || m.role === 'manager' || m.is_en_validator,
  work: (m: Me) => m.langs.length > 0,
  export: (m: Me) => m.role === 'manager' || m.role === 'owner',
  admin: (m: Me) => m.role === 'owner',
  archive: (m: Me) => m.role === 'owner' || m.role === 'validator',
  log: (m: Me) => m.role === 'owner' || m.role === 'validator',
  proposeLangs: (m: Me): string[] =>
    m.langs.length ? m.langs.map((l) => l.code) : m.role === 'contractor' ? m.languages.filter((l) => l.active).map((l) => l.code) : [],
  /** Языки без валидатора, где подрядчик пишет сразу */
  directLangs: (m: Me): Language[] => (m.role === 'contractor' ? m.languages.filter((l) => l.active && !l.has_validator) : [])
};

export type LangStatus = 'need' | 'optional' | 'draft' | 'unchecked' | 'approved' | 'unused';
export const STATUS_LABEL: Record<LangStatus, string> = {
  need: 'Нужен перевод', optional: 'Перевод по желанию', draft: 'Черновик', unchecked: 'Без проверки', approved: 'Согласовано', unused: 'Не актуально для языка'
};

export interface Cell { t: string[]; s: LangStatus; f: boolean; c?: string }
export interface GlossaryItem {
  id: number; tb: string; ru: string; version: number; projects: string[];
  definition?: string; examples?: string; comment?: string;
  cells: Record<string, Cell>; replaced: { lang: string; old: string; new: string; at: string }[];
  obsolete_request: { code: string; reason: string } | null;
  forbidden_hit: { lang: string; text: string; good: string }[] | null;
}
export interface Page<T> { items: T[]; total: number; page: number; pages: number }

export interface Author { name: string; avatar: string | null }
export interface Forbidden { text: string; note: string }
export interface TermLang {
  code: string; name: string; kind: 'full' | 'short'; has_validator: boolean; status: LangStatus;
  comment: string; optional: boolean; forbidden: Forbidden[]; draft: Record<string, unknown> | null; unused: boolean;
  live: { id: number; text: string; status: string; sort: number }[];
  history: { text: string; replaced_by: string | null; at: string }[];
  can: { type: boolean; approve: boolean; edit: boolean; request: boolean; unused: boolean; optional: boolean; fields: boolean };
}
export interface TermCard {
  id: number; tb: string; ru: string; definition: string; examples: string; comment: string;
  status: 'active' | 'archived'; archive_reason: string | null; version: number;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
  projects: { id: number; name: string }[];
  can: { edit_ru: boolean; merge: boolean; propose_obsolete: boolean; archive: boolean; restore: boolean; delete: boolean; comment: boolean; hide_comment: boolean };
  langs: TermLang[];
  pending: { id: number; code: string; type: string; lang: string | null; translation: string; reason: string; author: Author }[];
  obsolete_request: { id: number; code: string; reason: string; author: Author; can_close: boolean; can_answer: boolean;
    answers: { lang: string; answer: string; comment: string; author: Author }[] } | null;
  comments: { id: number; author: Author; body: string; at: string; mine: boolean }[];
  history: { at: string; user: string; action: string; lang: string | null; before: string | null; after: string | null; details: string | null }[];
}

export interface RequestItem {
  id: number; code: string; type: string; type_label: string; status: string; status_label: string; ru: string;
  definition: string; examples: string; comment: string; lang: string | null; translation: string; reason: string;
  target_langs: string[] | null; can_withdraw: boolean;
  warnings: string[]; author: Author; mine: boolean; created_at: string; decided_by: string | null; decided_at: string | null;
  version: number; term_id: number | null; tb: string | null; target_text: string | null; projects: string[];
  translations: Record<string, string>; comments: number;
  can_approve?: boolean; can_answer?: boolean; ru_only?: boolean;
}

export interface WorkItem {
  id: number; tb: string; ru: string; definition: string; examples: string; comment: string; lang_comment: string;
  version: number; status: LangStatus; created_at: string;
  projects: string[]; text: string; live: { id: number; text: string; status: string }[]; forbidden: Forbidden[]; others: Record<string, string>;
}

export interface DashCard { key: string; label: string; count: number; link: string }

export const fmtDate = (s: string | null | undefined, withTime = true) => {
  if (!s) return '';
  return new Date(s).toLocaleString('ru-RU', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export function langGen(name: string) {
  return /(ий|ый)$/.test(name) ? name.replace(/(ий|ый)$/, 'ого') : name;
}
