import { useState } from 'react';
import { fmtDate, rpc } from '../api';
import type { PageProps } from '../router';
import { Button, Empty, Message, Pager, useAsync } from '../ui/kit';
import { HelpLink } from '../ui/HelpLink';
import { LogCell } from '../logText';
import { TermDrawer } from '../ui/TermDrawer';
import { Icon } from '../ui/Icon';

interface LogRow { id: number; at: string; user: string; action: string; tb: string | null; request_code: string | null; lang: string | null; before: string | null; after: string | null; details: string | null }
interface LogData { items: LogRow[]; total: number; page: number; pages: number; actions: string[]; users: { id: number; name: string }[] }

const EMPTY_F = { from: '', to: '', user_id: '', tb: '', action: '', lang: '' };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

/** Значок по смыслу действия — чтобы ленту было легко пробежать глазами. */
function actionIcon(a: string): string {
  const s = a.toLowerCase();
  if (s.includes('удал')) return 'close';
  if (s.includes('архив')) return 'archive';
  if (s.includes('соглас') || s.includes('утвер')) return 'check';
  if (s.includes('отклон')) return 'alert';
  if (s.includes('заявк') || s.includes('просьб')) return 'inbox';
  if (s.includes('коммент')) return 'comment';
  if (s.includes('объедин') || s.includes('замен')) return 'swap';
  if (s.includes('не актуал')) return 'archive';
  if (s.includes('проект')) return 'book';
  if (s.includes('загруз') || s.includes('импорт')) return 'upload';
  if (s.includes('выгруз')) return 'download';
  if (s.includes('созда') || s.includes('добав') || s.includes('нов')) return 'plus';
  return 'pen';
}

function dayTitle(at: string) {
  const d = new Date(at);
  const today = iso(new Date()), y = daysAgo(1), k = iso(d);
  if (k === today) return 'Сегодня';
  if (k === y) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function LogPage({ me }: PageProps) {
  const [f, setF] = useState(EMPTY_F);
  const [page, setPage] = useState(1);
  const [openTb, setOpenTb] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { data, error, loading } = useAsync(() => rpc<LogData>('log_page', { p_f: f, p_page: page, p_size: 100 }), [JSON.stringify(f), page]);
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); };
  const short = (s: string | null) => (s && s.length > 160 ? s.slice(0, 160) + '…' : s);
  const active = Object.values(f).filter(Boolean).length;
  const preset = f.from === iso(new Date()) && !f.to ? 'today' : f.from === daysAgo(7) && !f.to ? '7' : f.from === daysAgo(30) && !f.to ? '30' : f.from || f.to ? 'custom' : 'all';

  // группировка по дням
  const groups: { day: string; rows: LogRow[] }[] = [];
  for (const r of data?.items ?? []) {
    const day = dayTitle(r.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, rows: [] });
    groups.at(-1)!.rows.push(r);
  }

  return (
    <div>
      <h1>Журнал изменений <HelpLink topics={['Журнал изменений', 'Журнал и копии']} /></h1>
      <p className="muted">{me.role === 'owner' || me.role === 'manager' || me.is_en_validator ? 'Все изменения.' : 'Изменения ваших языков и русской части.'} Журнал нельзя изменить или очистить.</p>

      <div className="chips" role="group" aria-label="Период">
        {([['all', 'За всё время', '', ''], ['today', 'Сегодня', iso(new Date()), ''], ['7', '7 дней', daysAgo(7), ''], ['30', '30 дней', daysAgo(30), '']] as const).map(([k, l, from, to]) => (
          <button key={k} className={`chip${preset === k ? ' on' : ''}`} aria-pressed={preset === k} onClick={() => set({ from, to })}>{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className={`chip filter-toggle${filtersOpen ? ' on' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
          <Icon name="sliders" size={14} /> Фильтры{active ? ` · ${active}` : ''}</button>
        {active ? <Button small kind="link" onClick={() => { setF(EMPTY_F); setPage(1); }}>Сбросить</Button> : null}
      </div>

      {filtersOpen ? (
        <div className="card filter-panel">
          <label className="field"><span>С даты</span><input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="field"><span>По дату</span><input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
          <label className="field"><span>Кто</span>
            <select value={f.user_id} onChange={(e) => set({ user_id: e.target.value })}>
              <option value="">Все пользователи</option>
              {data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></label>
          <label className="field"><span>Термин или заявка</span><input placeholder="TB-00012 или Z-00034" value={f.tb} onChange={(e) => set({ tb: e.target.value })} /></label>
          <label className="field"><span>Действие</span>
            <select value={f.action} onChange={(e) => set({ action: e.target.value })}>
              <option value="">Все действия</option>
              {data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select></label>
          <label className="field"><span>Язык</span>
            <select value={f.lang} onChange={(e) => set({ lang: e.target.value })}>
              <option value="">Все языки</option>
              {me.languages.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
            </select></label>
        </div>
      ) : null}

      {error ? <Message kind="error">{error}</Message> : null}
      {data ? <p className="results-count">Записей: <b>{data.total.toLocaleString('ru-RU')}</b></p> : null}
      <div className={`feed${loading ? ' reloading' : ''}`}>
        {groups.map((g) => (
          <section key={g.day + g.rows[0].id}>
            <h3 className="feed-day">{g.day}</h3>
            <ul>{g.rows.map((r) => (
              <li key={r.id} className={`feed-item${openTb && r.tb === openTb ? ' sel' : ''}`}>
                <span className="feed-ico" aria-hidden="true"><Icon name={actionIcon(r.action)} size={15} /></span>
                <div className="feed-main">
                  <div className="feed-line">
                    <b>{r.action}</b>
                    {r.lang ? <span className="badge">{r.lang}</span> : null}
                    {r.tb ? <button className="btn link small tb-link" title={`Открыть карточку ${r.tb}`} onClick={() => setOpenTb(r.tb)}>{r.tb}</button> : null}
                    {r.request_code ? <span className="tb">{r.request_code}</span> : null}
                    <span className="muted small">{r.user} · {fmtDate(r.at).split(', ').pop()}</span>
                  </div>
                  {r.before || r.after ? (
                    <div className="feed-diff">
                      {r.before ? <span className="was" title="Было"><LogCell value={r.before} /></span> : null}
                      {r.before && r.after ? <Icon name="right" size={14} /> : null}
                      {r.after ? <span className="now" title="Стало"><LogCell value={r.after} /></span> : null}
                    </div>
                  ) : null}
                  {r.details ? <div className="muted small">{short(r.details)}</div> : null}
                </div>
              </li>
            ))}</ul>
          </section>
        ))}
        {!loading && data && !data.items.length ? <Empty icon="history">{active ? 'Под эти фильтры записей нет.' : 'Записей пока нет.'}</Empty> : null}
        {loading && !data ? <div className="empty">Загрузка…</div> : null}
      </div>
      {data ? <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} /> : null}
      <TermDrawer me={me} id={null} tb={openTb} onClose={() => setOpenTb(null)} />
    </div>
  );
}
