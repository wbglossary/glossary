import { useState } from 'react';
import { rpc, type GlossaryItem, type Page } from '../api';
import type { PageProps } from '../router';
import { Button, Empty, Message, Pager, SearchBox, useAsync } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { TermsTable } from '../ui/TermsTable';

export function GlossaryPage({ me, route, reloadMe }: PageProps) {
  const active = me.languages.filter((l) => l.active);
  const [q, setQ] = useState('');
  const [project, setProject] = useState<number | null>(null);
  const [lang, setLang] = useState(route.params.get('lang') ?? '');
  const [mode, setMode] = useState<'any' | 'has' | 'missing'>((route.params.get('mode') as 'missing') ?? 'any');
  const dupes = route.params.get('dupes') === '1';
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [chooser, setChooser] = useState(false);
  const shown = (me.prefs.langs?.length ? me.prefs.langs : active.map((l) => l.code)).filter((c) => active.some((l) => l.code === c));

  const { data, error, loading, reload } = useAsync(
    () => rpc<Page<GlossaryItem>>('glossary_page', { p_q: q || null, p_project: project, p_lang: lang || null, p_mode: lang ? mode : 'any', p_page: page, p_size: 100, p_dupes: dupes }),
    [q, project, lang, mode, page, dupes]
  );
  const saveLangs = async (list: string[]) => { await rpc('set_prefs', { p_prefs: { ...me.prefs, langs: list } }); await reloadMe(); };

  return (
    <div>
      <h1>Глоссарий{dupes ? <span className="muted"> · одинаковые русские термины</span> : null}</h1>
      <div className="toolbar">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} />
        <select value={project ?? ''} onChange={(e) => { setProject(e.target.value ? Number(e.target.value) : null); setPage(1); }}>
          <option value="">Все проекты</option>
          {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.closed ? ' (закрыт)' : ''}</option>)}
        </select>
        <select value={lang} onChange={(e) => { setLang(e.target.value); setPage(1); if (!e.target.value) setMode('any'); else if (mode === 'any') setMode('missing'); }}>
          <option value="">Язык: любой</option>
          {active.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
        </select>
        {lang ? (
          <select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPage(1); }}>
            <option value="missing">нет перевода</option>
            <option value="has">есть перевод</option>
          </select>
        ) : null}
        <Button onClick={() => setChooser(!chooser)}>Показывать языки…</Button>
        {dupes ? <a href="#/glossary">показать все термины</a> : null}
      </div>
      {chooser ? (
        <div className="card checks">
          {active.map((l) => (
            <label key={l.code}><input type="checkbox" checked={shown.includes(l.code)}
              onChange={(e) => saveLangs(e.target.checked ? [...shown, l.code] : shown.filter((x) => x !== l.code))} /> {l.code} — {l.name}</label>
          ))}
          <span className="muted small">Выбор сохраняется только для вас.</span>
        </div>
      ) : null}
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap">
        {data ? <TermsTable me={me} items={data.items} langs={shown} openId={open} onOpen={setOpen} /> : null}
        {!loading && data && !data.items.length ? <Empty>Ничего не найдено.</Empty> : null}
        {loading ? <div className="empty">Загрузка…</div> : null}
      </div>
      {data ? <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} /> : null}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={reload} />
    </div>
  );
}
