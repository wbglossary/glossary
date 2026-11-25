/** Значок «?» рядом с трудным местом: открывает нужный раздел инструкции. topics — названия разделов, первый найденный и откроется. */
export function HelpLink({ topics, label = 'Как это работает' }: { topics: string[]; label?: string }) {
  return (
    <a className="help-q" href={`#/help?s=${encodeURIComponent(topics.join('|'))}`} title={`${label} — откроется инструкция`} aria-label={`${label}: открыть инструкцию`}>?</a>
  );
}
