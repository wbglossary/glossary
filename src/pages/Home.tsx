import { useState } from 'react';
import { can, fmtDate, rpc, type DashCard, type GlossaryItem, type Page } from '../api';
import { go, type PageProps } from '../router';
import { Button, Empty, Message, useAsync } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { DEFAULT_COLS, FIELD_COLS, TermsTable, type FieldCol } from '../ui/TermsTable';
import { LangCellView } from '../ui/LangCellView';
import { Icon } from '../ui/Icon';
import { PushCard } from '../push';
import { HomeSearch } from '../ui/HomeSearch';

/** Что делать с карточкой «Вас ждут» — одной строкой */
function nextStep(key: string, validator: boolean): string {
  if (key.startsWith('need-')) return 'Откройте и впишите перевод';
  if (key.startsWith('draft-')) return validator ? 'Проверьте и согласуйте' : 'Ждут проверки валидатором';
  if (key.startsWith('requests-')) return 'Утвердите или отклоните';
  if (key.startsWith('obsolete-')) return 'Ответьте: оставить или не используется';
  if (key.startsWith('review-')) return 'Проверьте переводы подрядчиков';
  if (key.startsWith('direct-')) return 'Впишите перевод — он появится сразу';
  return ({ mine: 'Посмотрите, что с ними', dupes: 'Объедините или различите определением', novalidator: 'Назначьте валидатора в Администрировании',
    unchecked: 'Переводы, которые некому проверить', allrequests: 'Посмотрите и прокомментируйте', feedback: 'Ответьте на обращения',
    'fb-answers': 'Прочитайте ответы', answers: 'Прочитайте ответы' } as Record<string, string>)[key] ?? 'Откройте';
}

export function HomePage({ me, reloadMe }: PageProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const hideDash = !!me.prefs.hide_dash;
  const toggleDash = async () => { await rpc('set_prefs', { p_prefs: { ...me.prefs, hide_dash: !hideDash } }); await reloadMe(); };
  const dash = useAsync(() => rpc<DashCard[]>('dashboard'), []);
  const recent = useAsync(() => rpc<(GlossaryItem & { created_at: string })[]>('recent_terms', { p_limit: 10 }), []);
  const found = useAsync(() => (q.trim() ? rpc<Page<GlossaryItem>>('glossary_page', { p_q: q, p_size: 50 }) : Promise.resolve(null)), [q]);
  const langs = (me.prefs.langs?.length ? me.prefs.langs : me.languages.filter((l) => l.active).map((l) => l.code));
  const cols = (me.prefs.cols ?? DEFAULT_COLS).filter((c): c is FieldCol => FIELD_COLS.some((f) => f.key === c));
  // В «Недавно добавленных» — русский и язык человека; у кого языка нет — языки из «Столбцы…» (или английский)
  const recentLangs = me.langs.length ? me.langs.map((l) => l.code) : me.prefs.langs?.length ? me.prefs.langs : ['EN'];
  const kind = (c: string) => me.languages.find((l) => l.code === c)?.kind ?? 'full';
  const cards = dash.data ?? [];
  const allDone = cards.length > 0 && cards.every((c) => c.count === 0);
  const needByLang = me.role === 'manager' || me.role === 'owner' ? cards.filter((c) => c.key.startsWith('need-')) : [];

  return (
    <div>
      <div className="home-search">
        <h1 style={{ margin: 0 }}>Найти термин</h1>
        <HomeSearch value={q} onChange={setQ} onOpen={setOpen} langs={recentLangs} />
        {can.submit(me) ? <Button kind="primary" onClick={() => go('propose')}>Предложить термин</Button> : null}
      </div>

      {q.trim() ? (
        <>
          <h2>Результаты {found.data ? <span className="muted">· {found.data.total}</span> : null}</h2>
          {found.error ? <Message kind="error">{found.error}</Message> : null}
          <div className="table-wrap">
            {found.data ? <TermsTable me={me} items={found.data.items} langs={langs} cols={cols} openId={open} onOpen={setOpen} q={q} /> : null}
            {found.data && !found.data.items.length ? <Empty>Ничего не найдено. {can.submit(me) ? 'Можно предложить этот термин.' : ''}</Empty> : null}
          </div>
        </>
      ) : (
        <>
          {cards.length ? (
            <>
              <div className="dash-head">
                <h2>Вас ждут</h2>
                <Button small kind="link" onClick={toggleDash}>{hideDash ? `Показать (${cards.filter((c) => c.count > 0).length})` : 'Свернуть'}</Button>
              </div>
              {hideDash ? null : <>
                {allDone ? <div className="done"><Icon name="check" /> Всё сделано</div> : null}
                {/* «Без перевода» по языкам у менеджера и владельца — одной карточкой с языками, а не по карточке на язык */}
                {needByLang.length > 1 ? (
                  <div className="dash-langs">
                    <span className="muted small">Без перевода:</span>
                    {needByLang.map((c) => (
                      <a key={c.key} href={`#/${c.link}`} className={c.count === 0 ? 'zero' : ''} title={`${c.label} — открыть термины без перевода`}>
                        <b>{c.key.slice(5)}</b> {c.count.toLocaleString('ru-RU')}
                      </a>
                    ))}
                  </div>
                ) : null}
                <div className="dash">
                  {(needByLang.length > 1 ? cards.filter((c) => !needByLang.includes(c)) : cards).map((c) => (
                    <a key={c.key} href={`#/${c.link}`} className={c.count === 0 ? 'zero' : ''}>
                      <b>{c.count.toLocaleString('ru-RU')}</b><span>{c.label}</span>
                      {c.count > 0 ? <small className="dash-next">{nextStep(c.key, can.validator(me))}</small> : null}
                      <Icon name="right" size={18} className="dash-arrow" />
                    </a>
                  ))}
                </div>
              </>}
            </>
          ) : null}
          {me.role !== 'reader' && me.role !== 'contractor' ? <PushCard /> : null}
          <h2>Недавно добавленные</h2>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Номер</th><th>Русский термин</th><th>Определение</th>{recentLangs.map((l) => <th key={l} title={me.languages.find((x) => x.code === l)?.name}>{l}</th>)}<th>Добавлен</th></tr></thead>
              <tbody>{recent.data?.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)} className={`clickable${open === r.id ? ' sel' : ''}`} title="Открыть карточку термина">
                  <td className="tb">{r.tb}</td><td><b>{r.ru}</b></td>
                  <td className="muted">{r.definition && r.definition !== '—' ? <div className="clip" title={r.definition}>{r.definition}</div> : <span className="empty-val">Нет определения</span>}</td>
                  {recentLangs.map((l) => <LangCellView key={l} cell={r.cells[l]} kind={kind(l)} />)}
                  <td className="nowrap">{fmtDate(r.created_at, false)}</td>
                </tr>
              ))}</tbody>
            </table>
            {recent.data && !recent.data.length ? <Empty>Пока нет терминов.</Empty> : null}
          </div>
        </>
      )}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={() => { recent.reload(); found.reload(); dash.reload(); }} />
    </div>
  );
}
