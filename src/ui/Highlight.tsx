/** Подсветка найденного фрагмента (без учёта регистра и ё/е). */
export function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle || needle.length < 2 || !text) return <>{text}</>;
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const i = norm(text).indexOf(norm(needle));
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}</>;
}
