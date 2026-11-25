import { useEffect, useRef, useState } from 'react';
import { can, fmtDate, langGen, rpc, type LangStatus, type Me, type RequestItem, type WorkItem } from '../api';
import { go, type PageProps } from '../router';
import { AuthorChip, CopyButton } from '../ui/bits';
import { ChangeModal, type ChangeMode } from '../ui/ChangeModal';
import { Button, Confirm, Empty, Message, Pager, SearchBox, StatusBadge, useAsync, useFillHeight, usePageSize } from '../ui/kit';
import { RequestDrawer } from '../ui/RequestDrawer';
import { TermDrawer } from '../ui/TermDrawer';
import { Icon } from '../ui/Icon';

interface WorkPageData {
  items: WorkItem[]; total: number; page: number; pages: number; kind: 'full' | 'short';
  counts: { need: number; draft: number; review: number }; can: { type: boolean; approve: boolean; unchecked: boolean; unused: boolean };
}

/** Столбцы рабочей области, которые можно включать и выключать. Номер, русский термин и перевод видны всегда. */
const WORK_COLS = [
  { key: 'definition', label: 'Определение' },
  { key: 'examples', label: 'Примеры' },
  { key: 'status', label: 'Статус' },
  { key: 'lang_comment', label: 'Комментарий лингвиста' },
  { key: 'comment', label: 'Комментарий (общий)' },
  { key: 'projects', label: 'Проекты' },
  { key: 'others', label: 'Другие языки' }
] as const;
type WorkCol = (typeof WORK_COLS)[number]['key'];
const WORK_DEFAULT: WorkCol[] = ['definition', 'examples', 'status', 'lang_comment', 'projects', 'others'];
const clean = (s?: string) => (s && s.trim() !== '—' ? s : '');

function myLangs(me: Me): string[] {
  if (me.langs.length) return me.langs.map((l) => l.code);
  if (me.role === 'owner') return me.languages.filter((l) => l.active).map((l) => l.code);
  return can.directLangs(me).map((l) => l.code);
}

export function WorkPage({ me, route, reloadMe }: PageProps) {
  const langs = myLangs(me);
  const [lang, setLang] = useState(route.params.get('lang') && langs.includes(route.params.get('lang')!) ? route.params.get('lang')! : langs[0]);
  const [tab, setTab] = useState<string>(route.params.get('tab') ?? 'mine');
  const [status, setStatus] = useState<string>(route.params.get('status') ?? 'all');
  const [project, setProject] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = usePageSize();
  const canHide = ['owner', 'manager', 'validator', 'translator'].includes(me.role);
  const hideUnused = canHide && (me.prefs.hide_unused ?? true);   // «не актуально» своего языка скрыто сразу
  const wrap = useFillHeight<HTMLDivElement>();
  const [open, setOpen] = useState<number | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [msgs, setMsgs] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string }[]>([]);
  const [modal, setModal] = useState<null | { mode: ChangeMode; row: WorkItem; current?: { id: number; text: string } }>(null);
  const [chooser, setChooser] = useState(false);
  const [savingCols, setSavingCols] = useState(false);
  const cols = (me.prefs.work_cols ?? WORK_DEFAULT).filter((c): c is WorkCol => WORK_COLS.some((w) => w.key === c));
  const show = (k: WorkCol) => cols.includes(k);
  const saveCols = async (next: string[]) => {
    setSavingCols(true);
    try { await rpc('set_prefs', { p_prefs: { ...me.prefs, work_cols: next } }); await reloadMe(); } finally { setSavingCols(false); }
  };
  const language = me.languages.find((l) => l.code === lang);
  const isWorker = can.worksLang(me, lang ?? '');

  useEffect(() => { setSel([]); setPage(1); }, [lang, tab, status, project, q]);
  const data = useAsync(() => (tab === 'requests' ? Promise.resolve(null)
    : rpc<WorkPageData>('work_page', { p_lang: lang, p_tab: tab, p_status: status, p_project: project, p_q: q || null, p_page: page, p_size: size, p_hide_unused: hideUnused })),
    [lang, tab, status, project, q, page, size, hideUnused]);
  const reqs = useAsync(() => (isWorker || me.role === 'owner' ? rpc<RequestItem[]>('lang_requests', { p_lang: lang }) : Promise.resolve([])), [lang, tab]);

  if (!lang) return <Empty>Рабочая область есть у переводчиков и валидаторов.</Empty>;
  const d = data.data;
  const items = d?.items ?? [];

  const approveRows = async (rows: WorkItem[]) => {
    setMsgs([]);
    try {
      const r = await rpc<{ done: string[]; skipped: string[] }>('set_lang_approval', { p_items: rows.map((x) => ({ id: x.id, version: x.version })), p_lang: lang, p_approve: true });
      setMsgs([...(r.done.length ? [{ kind: 'ok' as const, text: `Согласовано: ${r.done.length}` }] : []), ...r.skipped.map((s) => ({ kind: 'warn' as const, text: s }))]);
    } catch (e) { setMsgs([{ kind: 'error', text: (e as Error).message }]); }
    setSel([]); data.reload();
  };
  const selectable = items;
  const canSel = !!(d?.can.approve || d?.can.unused);
  const selRows = items.filter((x) => sel.includes(x.id));
  const toApprove = selRows.filter((x) => x.status === 'draft' || x.status === 'unchecked');
  const markUnused = async (rows: WorkItem[], unused: boolean) => {
    setMsgs([]);
    try {
      const r = await rpc<{ changed: number; archived: number }>('set_unused_many', { p_terms: rows.map((x) => x.id), p_lang: lang, p_unused: unused });
      setMsgs([{ kind: 'ok', text: (unused ? `Отмечено «Не актуально для языка»: ${r.changed}.` : `Возвращено в работу: ${r.changed}.`)
        + (r.archived ? ` Ушло в архив (не актуально ни для одного языка): ${r.archived}.` : '') }]);
    } catch (e) { setMsgs([{ kind: 'error', text: (e as Error).message }]); }
    setSel([]); data.reload();
  };
  const pendingReqs = reqs.data?.length ?? 0;

  return (
    <div>
      <h1>Рабочая область — {language?.name ?? lang}</h1>
      {langs.length > 1 ? (
        <div className="toolbar">
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Язык">
            {langs.map((l) => <option key={l} value={l}>{l} — {me.languages.find((x) => x.code === l)?.name}</option>)}
          </select>
        </div>
      ) : null}
      <div className="page-tabs" role="tablist" aria-label="Разделы рабочей области">
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>Мой язык</button>
        <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>Новое из других языков</button>
        {(d?.counts.review ?? 0) > 0 || tab === 'review' ? <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>На пересмотр<span className="count">{d?.counts.review ?? ''}</span></button> : null}
        {isWorker || me.role === 'owner' ? <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>Заявки и просьбы{pendingReqs ? <span className="count">{pendingReqs}</span> : null}</button> : null}
      </div>
      {me.role === 'owner' && !isWorker ? (
        <div className="viewonly" role="note">
          <Icon name="eye" size={20} />
          <div><b>Режим просмотра.</b> Вы владелец, а вписывать и согласовывать переводы здесь могут переводчики и валидатор этого языка.
            Чтобы что-то поменять, нажмите на термин — в карточке есть действия владельца. Назначить людей на язык можно в «Администрировании».</div>
        </div>
      ) : null}
      {d?.can.unchecked ? <Message kind="info">У языка пока нет валидатора. Ваши переводы сразу видны в глоссарии со статусом «Без проверки».</Message> : null}
      {msgs.map((m, i) => <Message key={i} kind={m.kind} onClose={() => setMsgs(msgs.filter((_, j) => j !== i))}>{m.text}</Message>)}

      {tab === 'requests' ? <RequestsTab me={me} lang={lang} langName={language?.name ?? lang} reqs={reqs} /> : (
        <>
          {tab === 'mine' ? (
            <div className="chips" role="group" aria-label="Статус перевода">
              {[['all', 'Все'], ['need', `Нужен перевод${d?.kind === 'full' ? ` · ${d?.counts.need ?? ''}` : ''}`], ['draft', `Черновик · ${d?.counts.draft ?? ''}`],
                ['unchecked', 'Без проверки'], ['approved', 'Согласовано'], ['unused', 'Не актуально для языка']].map(([k, label]) => (
                <button key={k} className={`chip${status === k ? ' on' : ''}${k !== 'all' ? ' dot-' + k : ''}`} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
              ))}
            </div>
          ) : null}
          <div className="toolbar">
            <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Все проекты</option>
              {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <SearchBox value={q} onChange={setQ} />
            {canHide && tab === 'mine' && status === 'all' ? (
              <label className="small"><input type="checkbox" checked={hideUnused} disabled={savingCols}
                onChange={async (e) => { setSavingCols(true); try { await rpc('set_prefs', { p_prefs: { ...me.prefs, hide_unused: e.target.checked } }); await reloadMe(); } finally { setSavingCols(false); } }} /> Скрыть «не актуально»</label>
            ) : null}
            <Button onClick={() => setChooser(!chooser)}>{chooser ? 'Скрыть настройку' : 'Столбцы…'}</Button>
            {d?.can.approve ? <Button kind="primary" disabled={!toApprove.length} why={!toApprove.length ? 'Отметьте строки с черновиком' : undefined}
              onClick={() => approveRows(toApprove)}>Согласовать выбранные ({toApprove.length})</Button> : null}
            {d?.can.unused && sel.length ? (status === 'unused' && tab === 'mine'
              ? <Button onClick={() => markUnused(selRows, false)}>Вернуть в работу ({sel.length})</Button>
              : <Button onClick={() => { if (window.confirm(`Отметить ${sel.length} терм. «Не актуально для языка»? Ячейки станут белыми, в выгрузке — пустыми. Вернуть можно в фильтре «Не актуально для языка».`)) markUnused(selRows, true); }}>Не актуально для языка ({sel.length})</Button>) : null}
          </div>
          {chooser ? (
            <div className="card colpick">
              <div>
                <h4>Столбцы</h4>
                <div className="checks">
                  {WORK_COLS.map((w) => (
                    <label key={w.key}><input type="checkbox" checked={show(w.key)} disabled={savingCols}
                      onChange={(e) => saveCols(e.target.checked ? WORK_COLS.map((x) => x.key).filter((k) => k === w.key || cols.includes(k)) : cols.filter((k) => k !== w.key))} /> {w.label}</label>
                  ))}
                </div>
              </div>
              <div className="row gap">
                <span className="muted small">Номер, русский термин и перевод видны всегда. Выбор сохраняется только для вас.</span>
                <Button small kind="link" disabled={savingCols} onClick={() => saveCols(WORK_DEFAULT)}>Вернуть как было</Button>
              </div>
            </div>
          ) : null}
          {data.error ? <Message kind="error">{data.error}</Message> : null}
          <div className="table-wrap" ref={wrap}>
            <table className={`grid sticky work-grid${canSel ? ' with-check' : ''}`}>
              <thead><tr>
                {canSel ? <th className="s0"><input type="checkbox" checked={!!selectable.length && selectable.every((x) => sel.includes(x.id))}
                  onChange={(e) => setSel(e.target.checked ? selectable.map((x) => x.id) : [])} /></th> : null}
                <th className="s1">Номер</th><th className="s2">Русский термин</th><th className="wide" title={language?.name}>{lang} — {language?.name}</th>
                {show('definition') ? <th>Определение</th> : null}
                {show('examples') ? <th>Примеры</th> : null}
                {show('status') ? <th>Статус</th> : null}
                {show('lang_comment') ? <th>Комментарий лингвиста</th> : null}
                {show('comment') ? <th>Комментарий</th> : null}
                {show('projects') ? <th>Проекты</th> : null}
                {show('others') ? <th>Другие языки</th> : null}
                <th />
              </tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={open === r.id ? 'sel' : ''}>
                    {canSel ? <td className="s0"><input type="checkbox" checked={sel.includes(r.id)}
                      onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td> : null}
                    <td className="tb link s1" onClick={() => setOpen(r.id)}>{r.tb}</td>
                    <td className="link s2" onClick={() => setOpen(r.id)}><b>{r.ru}</b>{tab === 'new' ? <div className="muted small">{fmtDate(r.created_at, false)}</div> : null}</td>
                    <td className={`c-${r.status}`}>
                      <TrCell row={r} lang={lang} canType={!!d?.can.type} onSaved={() => data.reload()} />
                      {r.forbidden.length ? <div className="small"><span className="muted">Как нельзя: </span>{r.forbidden.map((f, i) => <span key={i} className="forbidden" title={f.note}>{f.text}{i < r.forbidden.length - 1 ? ', ' : ''}</span>)}</div> : null}
                    </td>
                    {show('definition') ? <td className="muted"><div className="clip" title={clean(r.definition)}>{clean(r.definition)}</div></td> : null}
                    {show('examples') ? <td className="muted"><div className="clip" title={clean(r.examples)}>{clean(r.examples)}</div></td> : null}
                    {show('status') ? <td><StatusBadge status={r.status} /></td> : null}
                    {show('lang_comment') ? <td className="muted"><div className="clip" title={r.lang_comment}>{r.lang_comment}</div></td> : null}
                    {show('comment') ? <td className="muted"><div className="clip" title={clean(r.comment)}>{clean(r.comment)}</div></td> : null}
                    {show('projects') ? <td>{r.projects.join(', ')}</td> : null}
                    {show('others') ? <td className="small">{Object.entries(r.others).map(([l, t]) => <div key={l}><b>{l}</b> {t}</div>)}</td> : null}
                    <td className="nowrap">
                      {d?.can.approve && (r.status === 'draft' || r.status === 'unchecked') ? <Button small kind="primary" onClick={() => approveRows([r])}>Согласовать</Button> : null}
                      {r.live.filter((x) => x.status !== 'draft').slice(0, 1).map((t) => d?.can.approve || d?.can.unchecked
                        ? <Button key={t.id} small kind="link" onClick={() => setModal({ mode: 'edit', row: r, current: t })}>Изменить</Button>
                        : d?.can.type ? <Button key={t.id} small kind="link" onClick={() => setModal({ mode: 'replace', row: r, current: t })}>Заменить</Button> : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.loading && d && !items.length ? <Empty>{tab === 'review' ? 'Всё пересмотрено.' : tab === 'new' ? 'Новых терминов из других языков нет.' : 'Ничего не найдено.'}</Empty> : null}
            {data.loading ? <div className="empty">Загрузка…</div> : null}
          </div>
          {d ? <Pager page={d.page} pages={d.pages} total={d.total} onPage={setPage} size={size} onSize={(a) => { setSize(a); setPage(1); }} /> : null}
        </>
      )}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={() => data.reload()} list={items.map((x) => x.id)} onOpen={setOpen} />
      {modal ? <ChangeModal mode={modal.mode} termId={modal.row.id} tb={modal.row.tb} ru={modal.row.ru} lang={lang} langName={language?.name ?? lang}
        current={modal.current} onClose={() => setModal(null)} onDone={(t) => { setModal(null); setMsgs([{ kind: 'ok', text: t }]); data.reload(); }} /> : null}
    </div>
  );
}

/** Высота поля — по тексту: короткий перевод — одна строка. */
function autoSize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}

/** Ячейка перевода: как в таблице, сохраняется сама. Несохранённый текст хранится в браузере. */
function TrCell({ row, lang, canType, onSaved }: { row: WorkItem; lang: string; canType: boolean; onSaved: () => void }) {
  const key = `gl_tr_${row.id}_${lang}`;
  const [v, setV] = useState(() => localStorage.getItem(key) ?? row.text);
  const [state, setState] = useState<'idle' | 'typing' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const ver = useRef(row.version);
  useEffect(() => { ver.current = row.version; setV(localStorage.getItem(key) ?? row.text); }, [row.version, row.text, key]);
  const locked = row.status === 'unused' || !canType;
  if (locked) return <span>{row.text}<CopyButton text={row.live[0]?.text ?? ''} /></span>;

  const save = async (text: string) => {
    if (text === row.text) { localStorage.removeItem(key); return; }
    setState('saving');
    try {
      const r = await rpc<{ text: string; status: LangStatus; version: number; warnings: string[] }>('set_cell_text', { p_term: row.id, p_lang: lang, p_text: text, p_version: ver.current });
      ver.current = r.version; localStorage.removeItem(key); setState('saved'); setV(r.text); setWarn(r.warnings ?? []);
      onSaved();
    } catch (e) {
      setState('error'); setErr((e as Error).message);
      if (/нельзя изменить/.test((e as Error).message)) { setV(row.text); localStorage.removeItem(key); }
    }
  };
  return (
    <div>
      <textarea className="cell-input" rows={1} value={v} placeholder="Впишите перевод" title="Сохранится само через секунду" ref={autoSize}
        aria-label={`Перевод: ${row.ru}`}
        onChange={(e) => {
          setV(e.target.value); localStorage.setItem(key, e.target.value); setState('typing'); autoSize(e.target);
          window.clearTimeout(timer.current);
          const t = e.target.value;
          timer.current = window.setTimeout(() => save(t), 1500);
        }}
        onBlur={() => { window.clearTimeout(timer.current); if (v !== row.text) save(v); }} />
      <span className={`save-state ${state}`} role="status">{state === 'typing' ? 'Сохраню через секунду…' : state === 'saving' ? 'Сохраняю…'
        : state === 'saved' ? <><Icon name="check" size={12} /> Сохранено</> : state === 'error' ? err : ''}</span>
      {warn.length ? <div className="small warn-line"><Icon name="alert" size={14} /> {warn.join(' ')}</div> : null}
    </div>
  );
}

interface ApproveRes { status: 'approved' | 'confirm'; code: string; tb?: string; message?: string; warnings?: string[] }

function RequestsTab({ me, lang, langName, reqs }: { me: Me; lang: string; langName: string; reqs: ReturnType<typeof useAsync<RequestItem[]>> }) {
  const [msgs, setMsgs] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string }[]>([]);
  const [open, setOpen] = useState<RequestItem | null>(null);
  const [confirmDup, setConfirmDup] = useState<{ item: RequestItem; warnings: string[] } | null>(null);
  const [reject, setReject] = useState<RequestItem | null>(null);
  const [term, setTerm] = useState<number | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const items = reqs.data ?? [];
  const hasNew = items.some((r) => r.type === 'new');
  const selectable = items.filter((r) => r.can_approve);
  const canBulk = selectable.length > 0;

  /** Утвердить выбранные по очереди. Заявки с возможным дублем не утверждаются молча — остаются для проверки. */
  const approveSelected = async () => {
    setBusy(true);
    const ok: string[] = [], dup: string[] = [], err: string[] = [];
    for (const r of items.filter((x) => sel.includes(x.id) && x.can_approve)) {
      try {
        const res = await rpc<ApproveRes>('approve_request', { p_request: r.id, p_version: r.version, p_force: false });
        if (res.status === 'confirm') dup.push(r.code); else ok.push(r.code);
      } catch (e) { err.push(`${r.code}: ${(e as Error).message}`); }
    }
    const m: { kind: 'ok' | 'error' | 'warn'; text: string }[] = [];
    if (ok.length) m.push({ kind: 'ok', text: `Утверждено: ${ok.length} (${ok.join(', ')}).` });
    if (dup.length) m.push({ kind: 'warn', text: `Не утверждены — возможный дубль, посмотрите по одной: ${dup.join(', ')}.` });
    if (err.length) m.push({ kind: 'error', text: `Не получилось: ${err.join('; ')}` });
    setMsgs(m);
    setSel(dup.length ? items.filter((x) => dup.includes(x.code)).map((x) => x.id) : []);
    setBusy(false);
    reqs.reload();
  };

  const approve = async (r: RequestItem, force = false) => {
    try {
      const res = await rpc<ApproveRes>('approve_request', { p_request: r.id, p_version: r.version, p_force: force });
      if (res.status === 'confirm') { setConfirmDup({ item: r, warnings: res.warnings ?? [] }); return; }
      setMsgs([{ kind: 'ok', text: `Утверждено: ${res.message}` }]);
    } catch (e) { setMsgs([{ kind: 'error', text: `${r.code}: ${(e as Error).message}` }]); }
    reqs.reload();
  };
  const answer = async (r: RequestItem, a: 'unused' | 'keep') => {
    try {
      const comment = a === 'keep' ? prompt('Почему оставить? (по желанию)') ?? '' : '';
      const res = await rpc<{ archived: boolean }>('answer_obsolete', { p_request: r.id, p_answer: a, p_comment: comment });
      setMsgs([{ kind: 'ok', text: a === 'keep' ? 'Ответ сохранён: оставить.' : res.archived ? 'Все языки отметили — термин ушёл в архив.' : 'Ваш язык помечен «Не актуально для языка».' }]);
    } catch (e) { setMsgs([{ kind: 'error', text: (e as Error).message }]); }
    reqs.reload();
  };

  return (
    <>
      {msgs.map((m, i) => <Message key={i} kind={m.kind} onClose={() => setMsgs([])}>{m.text}</Message>)}
      {reqs.error ? <Message kind="error">{reqs.error}</Message> : null}
      {canBulk ? (
        <div className="toolbar">
          <Button kind="primary" disabled={!sel.length || busy} onClick={approveSelected}>
            {busy ? 'Утверждаю…' : `Утвердить выбранные (${sel.length})`}</Button>
          <span className="muted small">Отметьте заявки галочками. Заявки с возможным дублем не утвердятся — их нужно посмотреть по одной.</span>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr>
            {canBulk ? <th><input type="checkbox" aria-label="Выбрать все" checked={sel.length > 0 && selectable.every((x) => sel.includes(x.id))}
              onChange={(e) => setSel(e.target.checked ? selectable.map((x) => x.id) : [])} /></th> : null}
            <th>Заявка</th><th>Что</th><th>Русский термин</th><th>Предложено</th>{hasNew ? <th>{lang}</th> : null}<th>Автор</th><th>Дубли</th><th />
          </tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className={sel.includes(r.id) ? 'sel' : ''}>
                {canBulk ? <td>{r.can_approve ? <input type="checkbox" aria-label={`Выбрать ${r.code}`} checked={sel.includes(r.id)}
                  onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /> : null}</td> : null}
                <td className="link nowrap" onClick={() => setOpen(r)}>{r.code}{r.comments ? <span className="ccount"><Icon name="comment" size={13} />{r.comments}</span> : null}</td>
                <td>{r.type_label}{r.type === 'new' && !r.lang ? <div className="muted small">{r.target_langs?.length ? `на ${r.target_langs.join(', ')}` : 'на все языки'}</div> : null}{r.ru_only ? <div className="muted small">русская часть (у {r.lang} нет валидатора)</div> : null}</td>
                <td>{r.tb ? <div className="tb link tb-line" onClick={() => setTerm(r.term_id)}>{r.tb}</div> : null}<b>{r.ru}</b>{clean(r.definition) ? <div className="muted small clip" title={r.definition}>{r.definition}</div> : null}</td>
                <td className="small">
                  {r.type === 'obsolete' ? <>Причина: {r.reason}</> : <>
                    {r.lang && r.translation ? <div><b>{r.lang}</b> {r.translation}</div> : null}
                    {r.target_text ? <div className="muted">вместо «{r.target_text}»</div> : null}
                    {r.reason && r.type !== 'new' ? <div className="muted">Причина: {r.reason}</div> : null}
                    {r.definition ? <div className="muted">{r.definition}</div> : null}
                  </>}
                </td>
                {hasNew ? <td>{r.type === 'new' ? <ReqTranslation r={r} lang={lang} onSaved={() => reqs.reload()} disabled={!can.worksLang(me, lang)} /> : null}</td> : null}
                <td><AuthorChip a={r.author} /><div className="muted small">{fmtDate(r.created_at)}</div></td>
                <td>{r.warnings.length ? <span className="badge st-draft" title={r.warnings.join('\n')}><Icon name="alert" size={12} /> {r.warnings.length}</span> : null}</td>
                <td className="nowrap">
                  {r.can_approve ? <>
                    <Button small kind="primary" onClick={() => approve(r)}>Утвердить</Button>
                    <Button small onClick={() => setReject(r)}>Отклонить</Button>
                  </> : null}
                  {r.can_answer ? <>
                    <Button small kind="primary" onClick={() => answer(r, 'unused')}>Не актуально</Button>
                    <Button small onClick={() => answer(r, 'keep')}>Оставить</Button>
                  </> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!reqs.loading && !items.length ? <Empty>Заявок и просьб для {langGen(langName)} нет.</Empty> : null}
      </div>
      <RequestDrawer item={open} onClose={() => setOpen(null)} onChanged={() => reqs.reload()} />
      <TermDrawer me={me} id={term} onClose={() => setTerm(null)} />
      {confirmDup ? (
        <Confirm title={`Возможные дубли: ${confirmDup.item.code} «${confirmDup.item.ru}»`} confirmLabel="Всё равно утвердить"
          onCancel={() => setConfirmDup(null)} onConfirm={() => { const r = confirmDup.item; setConfirmDup(null); approve(r, true); }}>
          <ul>{confirmDup.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          Если это другой смысл — утвердите. Если тот же — отмените и отклоните заявку.
        </Confirm>
      ) : null}
      {reject ? (
        <Confirm title={`Отклонить ${reject.code}?`} confirmLabel="Отклонить" danger onCancel={() => setReject(null)}
          onConfirm={async () => {
            try { await rpc('reject_request', { p_request: reject.id, p_version: reject.version }); setMsgs([{ kind: 'ok', text: `${reject.code} отклонена.` }]); }
            catch (e) { setMsgs([{ kind: 'error', text: (e as Error).message }]); }
            setReject(null); reqs.reload();
          }}>
          Заявка уйдёт в архив. Автор увидит статус «Отклонена» в «Моих заявках». Если нужно уточнить — лучше напишите комментарий к заявке.
        </Confirm>
      ) : null}
      {hasNew ? <p className="muted small" style={{ marginTop: 10 }}>Новый термин утверждается вместе с переводом на ваш язык: впишите его в столбец {lang}. <a href="#/propose" onClick={() => go('propose')}>Предложить термин</a></p> : null}
    </>
  );
}

function ReqTranslation({ r, lang, onSaved, disabled }: { r: RequestItem; lang: string; onSaved: () => void; disabled: boolean }) {
  const [v, setV] = useState(r.translations[lang] ?? '');
  const [state, setState] = useState('');
  if (disabled) return <span>{r.translations[lang] ?? ''}</span>;
  const save = async () => {
    if (v === (r.translations[lang] ?? '')) return;
    setState('Сохраняю…');
    try { await rpc('set_request_translation', { p_request: r.id, p_lang: lang, p_text: v }); setState('Сохранено'); onSaved(); }
    catch (e) { setState((e as Error).message); }
  };
  return (
    <div>
      <input className="cell-input" value={v} placeholder="Перевод" onChange={(e) => setV(e.target.value)} onBlur={save} />
      <span className="save-state">{state}</span>
    </div>
  );
}
