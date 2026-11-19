import { useState } from 'react';
import { rpc, type GlossaryItem, type Page } from '../api';
import type { PageProps } from '../router';
import { Button, Empty, Message, Pager, SearchBox, useAsync } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { DEFAULT_COLS, FIELD_COLS, TermsTable, type FieldCol } from '../ui/TermsTable';

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
  const cols = (me.prefs.cols ?? DEFAULT_COLS).filter((c): c is FieldCol => FIELD_COLS.some((f) => f.key === c));
  const [saving, setSaving] = useState(false);
  const savePrefs = async (patch: { langs?: string[]; cols?: string[] }) => {
    setSaving(true);
    try { await rpc('set_prefs', { p_prefs: { ...me.prefs, ...patch } }); await reloadMe(); } finally { setSaving(false); }
  };
  const toggle = (list: string[], key: string, on: boolean) => (on ? [...list, key] : list.filter((x) => x !== key));

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
        <Button onClick={() => setChooser(!chooser)}>{chooser ? 'Скрыть настройку' : 'Столбцы…'}</Button>
        {dupes ? <a href="#/glossary">показать все термины</a> : null}
      </div>
      {chooser ? (
        <div className="card colpick">
          <div>
            <h4>Поля</h4>
            <div className="checks">
              {FIELD_COLS.map((f) => (
                <label key={f.key}><input type="checkbox" checked={cols.includes(f.key)} disabled={saving}
                  onChange={(e) => savePrefs({ cols: toggle(cols, f.key, e.target.checked) })} /> {f.label}</label>
              ))}
            </div>
          </div>
          <div>
            <h4>Языки</h4>
            <div className="checks">
              {active.map((l) => (
                <label key={l.code}><input type="checkbox" checked={shown.includes(l.code)} disabled={saving}
                  onChange={(e) => savePrefs({ langs: toggle(shown, l.code, e.target.checked) })} /> {l.code} — {l.name}</label>
              ))}
            </div>
          </div>
          <div className="row gap">
            <span className="muted small">Выбор сохраняется только для вас и действует на любом компьютере.</span>
            <Button small kind="link" disabled={saving} onClick={() => savePrefs({ cols: DEFAULT_COLS, langs: active.map((l) => l.code) })}>Вернуть как было</Button>
          </div>
        </div>
      ) : null}
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap">
        {data ? <TermsTable me={me} items={data.items} langs={shown} cols={cols} openId={open} onOpen={setOpen} /> : null}
        {!loading && data && !data.items.length ? <Empty>Ничего не найдено.</Empty> : null}
        {loading ? <div className="empty">Загрузка…</div> : null}
      </div>
      {data ? <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} /> : null}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={reload} />
    </div>
  );
}
