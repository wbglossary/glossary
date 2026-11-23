/** «Было / Стало» в журнале и истории термина: поля языка хранятся как JSON — показываем словами. */
const LABELS: Record<string, string> = {
  comment: 'Комментарий лингвиста', definition: 'Определение', examples: 'Примеры', context: 'Контекст'
};

export function logText(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.trim();
  if (!t.startsWith('{')) return s;
  let o: Record<string, unknown>;
  try { o = JSON.parse(t); } catch { return s; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return s;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'forbidden') {
      const list = (Array.isArray(v) ? v : []) as { text?: string; note?: string }[];
      const items = list.filter((x) => x?.text).map((x) => x.text + (x.note ? ` (${x.note})` : ''));
      if (items.length) parts.push(`Как нельзя: ${items.join('; ')}`);
    } else if (typeof v === 'string' && v.trim()) {
      parts.push(`${LABELS[k] ?? k}: ${v.trim()}`);
    }
  }
  return parts.length ? parts.join('\n') : '—';
}

/** Короткий вид для таблицы; полный текст — во всплывающей подсказке */
export function LogCell({ value, max = 160 }: { value: string | null | undefined; max?: number }) {
  const full = logText(value);
  return <span title={full.length > max ? full : undefined} style={{ whiteSpace: 'pre-line' }}>{full.length > max ? full.slice(0, max) + '…' : full}</span>;
}
