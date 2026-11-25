import { useState } from 'react';
import { can, rpc, type GlossaryItem, type Page } from '../api';
import type { PageProps } from '../router';
import { Button, Empty, Message, Pager, SearchBox, useAsync, useFillHeight, usePageSize } from '../ui/kit';
import { TermDrawer } from '../ui/TermDrawer';
import { DEFAULT_COLS, FIELD_COLS, SkeletonRows, TermsTable, type FieldCol, type SortKey } from '../ui/TermsTable';
import { buildGlossaryXlsx, download } from '../exportFile';

/** Быстрые фильтры по статусу выбранного языка */
const MODES: [string, string][] = [['any', 'Все'], ['missing', 'Нет перевода'], ['has', 'Есть перевод'], ['need', 'Нужен перевод'], ['draft', 'Черновик'],
  ['unchecked', 'Без проверки'], ['approved', 'Согласовано'], ['unused', 'Не актуально'], ['optional', 'По желанию']];

export function GlossaryPage({ me, route, reloadMe }: PageProps) {
  const active = me.languages.filter((l) => l.active);
  const [q, setQ] = useState('');
  const [project, setProject] = useState<number | null>(null);
  const [lang, setLang] = useState(route.params.get('lang') ?? '');
  const [mode, setMode] = useState<string>(route.params.get('mode') ?? 'any');
  const [sort, setSort] = useState<SortKey>('ru');
  const dupes = route.params.get('dupes') === '1';
  const [page, setPage] = useState(1);
  const [size, setSize] = usePageSize();
  const myLangs = me.langs.map((l) => l.code);
  // у переводчиков и валидаторов «не актуально» своего языка скрыто сразу; у остальных — по галочке, для показанных языков
  const canHide = ['owner', 'manager', 'validator', 'translator'].includes(me.role);
  const hideUnused = canHide && (me.prefs.hide_unused ?? myLangs.length > 0);
  const wrap = useFillHeight<HTMLDivElement>();
  const [open, setOpen] = useState<number | null>(null);
  const [chooser, setChooser] = useState(false);
  // массовая работа с проектами — менеджер, валидатор английского, владелец
  const bulk = can.editRu(me);
  const [sel, setSel] = useState<number[]>([]);
  const [bulkProjects, setBulkProjects] = useState<number[]>([]);
  // «Не актуально»: свои языки валидатора; у менеджера и владельца — языки без валидатора
  const unusedLangs = active.filter((l) => can.validatorOf(me, l.code) || ((me.role === 'manager' || me.role === 'owner') && !l.has_validator));
  const [unusedLang, setUnusedLang] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const shown = (me.prefs.langs?.length ? me.prefs.langs : active.map((l) => l.code)).filter((c) => active.some((l) => l.code === c));

  const { data, error, loading, reload } = useAsync(
    () => rpc<Page<GlossaryItem>>('glossary_page', { p_q: q || null, p_project: project, p_lang: lang || null, p_mode: lang ? mode : 'any', p_page: page, p_size: size, p_dupes: dupes,
      p_hide_unused: hideUnused ? (myLangs.length ? myLangs : shown) : null, p_sort: sort }),
    [q, project, lang, mode, page, dupes, size, hideUnused, shown.join(','), sort]
  );
  const cols = (me.prefs.cols ?? DEFAULT_COLS).filter((c): c is FieldCol => FIELD_COLS.some((f) => f.key === c));
  const [saving, setSaving] = useState(false);
  const savePrefs = async (patch: { langs?: string[]; cols?: string[]; hide_unused?: boolean }) => {
    setSaving(true);
    try { await rpc('set_prefs', { p_prefs: { ...me.prefs, ...patch } }); await reloadMe(); } finally { setSaving(false); }
  };
  const [dl, setDl] = useState(false);
  /** Скачать всё, что подходит под фильтры (все страницы), с выбранными столбцами и языками */
  const downloadShown = async () => {
    setDl(true); setBulkMsg(null);
    try {
      const all = await rpc<Page<GlossaryItem>>('glossary_page', { p_q: q || null, p_project: project, p_lang: lang || null, p_mode: lang ? mode : 'any',
        p_page: 1, p_size: 5000, p_dupes: dupes, p_hide_unused: hideUnused ? (myLangs.length ? myLangs : shown) : null, p_sort: sort });
      const fields = FIELD_COLS.filter((f) => cols.includes(f.key) && f.key !== 'lang_comment').map((f) => ({ key: f.key, label: f.label }));
      const d = new Date(); const p2 = (n: number) => String(n).padStart(2, '0');
      const projName = project ? me.projects.find((p) => p.id === project)?.name : '';
      const name = ['Глоссарий', projName, q ? `«${q}»` : '', lang && mode !== 'any' ? `${lang} ${MODES.find((m) => m[0] === mode)?.[1] ?? ''}` : '', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`].filter(Boolean).join(' — ');
      download(await buildGlossaryXlsx(all.items, fields, shown, cols.includes('lang_comment')), `${name}.xlsx`);
      setBulkMsg({ kind: 'ok', text: `Скачано терминов: ${all.items.length}.` });
    } catch (e) { setBulkMsg({ kind: 'error', text: (e as Error).message }); } finally { setDl(false); }
  };
  const downloadSelected = async () => {
    setDl(true); setBulkMsg(null);
    try {
      const fields = FIELD_COLS.filter((f) => cols.includes(f.key) && f.key !== 'lang_comment').map((f) => ({ key: f.key, label: f.label }));
      const items = (data?.items ?? []).filter((x) => sel.includes(x.id));
      download(await buildGlossaryXlsx(items, fields, shown, cols.includes('lang_comment')), `Глоссарий — выбранные ${items.length}.xlsx`);
      setBulkMsg({ kind: 'ok', text: `Скачано терминов: ${items.length}.` });
    } catch (e) { setBulkMsg({ kind: 'error', text: (e as Error).message }); } finally { setDl(false); }
  };
  const toggle = (list: string[], key: string, on: boolean) => (on ? [...list, key] : list.filter((x) => x !== key));
  const runUnused = async (unused: boolean) => {
    if (!unusedLang) return;
    if (unused && !window.confirm(`Отметить ${sel.length} терм. «Не актуально» для ${unusedLang}? Ячейки станут белыми, в выгрузке — пустыми.`)) return;
    setBulkBusy(true); setBulkMsg(null);
    try {
      const r = await rpc<{ changed: number; archived: number }>('set_unused_many', { p_terms: sel, p_lang: unusedLang, p_unused: unused });
      setBulkMsg({ kind: 'ok', text: (unused ? `«Не актуально» для ${unusedLang}: ${r.changed}.` : `Возвращено в работу (${unusedLang}): ${r.changed}.`)
        + (r.changed < sel.length ? ' Остальные уже были в таком состоянии.' : '') + (r.archived ? ` Ушло в архив (не актуально ни для одного языка): ${r.archived}.` : '') });
      setSel([]); reload();
    } catch (e) { setBulkMsg({ kind: 'error', text: (e as Error).message }); } finally { setBulkBusy(false); }
  };
  const runBulk = async (add: boolean) => {
    if (!bulkProjects.length) { setBulkMsg({ kind: 'error', text: 'Отметьте хотя бы один проект.' }); return; }
    setBulkBusy(true); setBulkMsg(null);
    const done: string[] = [];
    try {
      for (const id of bulkProjects) {
        const name = me.projects.find((p) => p.id === id)?.name ?? '';
        const n = await rpc<number>('set_term_project', { p_terms: sel, p_project: id, p_add: add });
        done.push(`«${name}» — ${n}`);
      }
      setBulkMsg({ kind: 'ok', text: (add ? 'Добавлено в проекты: ' : 'Убрано из проектов: ') + done.join(', ')
        + '. Где число меньше отмеченных — эти термины уже были (или не были) в проекте.' });
      setSel([]); setBulkProjects([]); reload();
    } catch (e) { setBulkMsg({ kind: 'error', text: (done.length ? `Успели: ${done.join(', ')}. ` : '') + (e as Error).message }); } finally { setBulkBusy(false); }
  };

  return (
    <div>
      <h1>Глоссарий{dupes ? <span className="muted"> · одинаковые русские термины</span> : null}</h1>
      <div className="toolbar">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} />
        <select value={project ?? ''} onChange={(e) => { setProject(e.target.value ? Number(e.target.value) : null); setPage(1); }} aria-label="Проект">
          <option value="">Все проекты</option>
          {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.closed ? ' (закрыт)' : ''}</option>)}
        </select>
        <select value={lang} onChange={(e) => { setLang(e.target.value); setPage(1); if (!e.target.value) setMode('any'); }} aria-label="Язык для фильтра">
          <option value="">Язык: любой</option>
          {active.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
        </select>
        <Button onClick={() => setChooser(!chooser)}>{chooser ? 'Скрыть настройку' : 'Столбцы…'}</Button>
        {canHide ? (
          <label className="small" title={myLangs.length ? '' : 'Скрываются термины, которые «не актуально» для всех показанных языков'}>
            <input type="checkbox" checked={hideUnused} disabled={saving}
              onChange={(e) => savePrefs({ hide_unused: e.target.checked })} /> Скрыть «не актуально»{myLangs.length ? ` (${myLangs.join(', ')})` : ''}</label>
        ) : null}
        {dupes ? <a href="#/glossary">показать все термины</a> : null}
      </div>
      {/* быстрые фильтры по статусу языка */}
      <div className="chips" role="group" aria-label="Статус перевода">
        {lang ? MODES.map(([k, label]) => (
          <button key={k} className={`chip${mode === k ? ' on' : ''}`} aria-pressed={mode === k} onClick={() => { setMode(k); setPage(1); }}>{label}</button>
        )) : <span className="muted small">Выберите язык — появятся быстрые фильтры: без перевода, черновики, «не актуально»…</span>}
      </div>
      <div className="results-bar">
        <span className="results-count">{data ? <>Найдено <b>{data.total.toLocaleString('ru-RU')}</b> из {data.all?.toLocaleString('ru-RU') ?? '…'}</> : 'Ищу…'}</span>
        <select value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setPage(1); }} aria-label="Сортировка" className="small-select">
          <option value="ru">По алфавиту А→Я</option>
          <option value="-ru">По алфавиту Я→А</option>
          <option value="tb">По номеру ↑</option>
          <option value="-tb">По номеру ↓</option>
          <option value="new">Сначала новые</option>
          <option value="updated">Недавно изменённые</option>
        </select>
        <span className="seg pager-size" aria-label="Сколько показывать">
          <button className={size !== 100 ? 'on' : ''} onClick={() => { setSize(true); setPage(1); }}>Все сразу</button>
          <button className={size === 100 ? 'on' : ''} onClick={() => { setSize(false); setPage(1); }}>По 100</button>
        </span>
        <span style={{ flex: 1 }} />
        <span className="dl-box">
          <Button kind="primary" small disabled={dl || !data?.total} onClick={downloadShown}>{dl ? 'Готовлю…' : `⬇ Скачать ${data ? data.total.toLocaleString('ru-RU') : ''} (.xlsx)`}</Button>
          <span className="muted small">найденные, со столбцами как на экране</span>
        </span>
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
      {bulkMsg ? <Message kind={bulkMsg.kind} onClose={() => setBulkMsg(null)}>{bulkMsg.text}</Message> : null}
      {bulk && sel.length ? (
        <div className="bulkbar floating" role="region" aria-label="Действия с отмеченными терминами">
          <b>Выбрано: {sel.length}</b>
          <Button small disabled={dl} onClick={downloadSelected}>⬇ Скачать выбранные</Button>
          <div className="checks" role="group" aria-label="Проекты">{me.projects.map((p) => (
            <label key={p.id}><input type="checkbox" checked={bulkProjects.includes(p.id)}
              onChange={(e) => setBulkProjects(e.target.checked ? [...bulkProjects, p.id] : bulkProjects.filter((x) => x !== p.id))} /> {p.name}{p.closed ? ' (закрыт)' : ''}</label>
          ))}</div>
          <Button kind="primary" disabled={bulkBusy || !bulkProjects.length} onClick={() => runBulk(true)}>Добавить в проекты</Button>
          <Button disabled={bulkBusy || !bulkProjects.length} onClick={() => runBulk(false)}>Убрать из проектов</Button>
          {unusedLangs.length ? (
            <span className="row gap bulk-unused">
              <select value={unusedLang} onChange={(e) => setUnusedLang(e.target.value)} aria-label="Язык">
                <option value="">— язык —</option>
                {unusedLangs.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
              </select>
              <Button disabled={bulkBusy || !unusedLang} onClick={() => runUnused(true)}>Не актуально для языка</Button>
              <Button kind="link" disabled={bulkBusy || !unusedLang} onClick={() => runUnused(false)}>Вернуть</Button>
            </span>
          ) : null}
          <Button kind="link" onClick={() => setSel([])}>Снять отметки</Button>
        </div>
      ) : null}
      {error ? <Message kind="error">{error}</Message> : null}
      <div className="table-wrap" ref={wrap}>
        {data ? <div className={loading ? 'reloading' : ''}><TermsTable me={me} items={data.items} langs={shown} cols={cols} openId={open} onOpen={setOpen}
          selected={bulk ? sel : undefined} onSelect={bulk ? setSel : undefined} q={q} sort={sort} onSort={(s2) => { setSort(s2); setPage(1); }} /></div> : null}
        {!data && loading ? <SkeletonRows cols={4 + shown.length} /> : null}
        {!loading && data && !data.items.length ? <Empty>Ничего не найдено. Попробуйте другое слово или снимите фильтры.</Empty> : null}
      </div>
      {data && data.pages > 1 ? <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} /> : null}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={reload} />
    </div>
  );
}
