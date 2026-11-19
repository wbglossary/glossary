import { useEffect, useRef, useState } from 'react';
import { can, fmtDate, langGen, rpc, type LangStatus, type Me, type RequestItem, type WorkItem } from '../api';
import { go, type PageProps } from '../router';
import { AuthorChip, CopyButton } from '../ui/bits';
import { ChangeModal, type ChangeMode } from '../ui/ChangeModal';
import { Button, Confirm, Empty, Message, Pager, SearchBox, StatusBadge, useAsync } from '../ui/kit';
import { RequestDrawer } from '../ui/RequestDrawer';
import { TermDrawer } from '../ui/TermDrawer';
import { Icon } from '../ui/Icon';

interface WorkPageData {
  items: WorkItem[]; total: number; page: number; pages: number; kind: 'full' | 'short';
  counts: { need: number; draft: number; review: number }; can: { type: boolean; approve: boolean; unchecked: boolean };
}

function myLangs(me: Me): string[] {
  if (me.role === 'translator' || me.role === 'validator') return [me.lang!];
  if (me.role === 'owner') return me.languages.filter((l) => l.active).map((l) => l.code);
  return can.directLangs(me).map((l) => l.code);
}

export function WorkPage({ me, route }: PageProps) {
  const langs = myLangs(me);
  const [lang, setLang] = useState(route.params.get('lang') && langs.includes(route.params.get('lang')!) ? route.params.get('lang')! : langs[0]);
  const [tab, setTab] = useState<string>(route.params.get('tab') ?? 'mine');
  const [status, setStatus] = useState<string>(route.params.get('status') ?? 'all');
  const [project, setProject] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [msgs, setMsgs] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string }[]>([]);
  const [modal, setModal] = useState<null | { mode: ChangeMode; row: WorkItem; current?: { id: number; text: string } }>(null);
  const [others, setOthers] = useState(true);
  const language = me.languages.find((l) => l.code === lang);
  const isWorker = me.role === 'translator' || me.role === 'validator';

  useEffect(() => { setSel([]); setPage(1); }, [lang, tab, status, project, q]);
  const data = useAsync(() => (tab === 'requests' ? Promise.resolve(null)
    : rpc<WorkPageData>('work_page', { p_lang: lang, p_tab: tab, p_status: status, p_project: project, p_q: q || null, p_page: page, p_size: 100 })),
    [lang, tab, status, project, q, page]);
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
  const selectable = items.filter((x) => x.status === 'draft' || x.status === 'unchecked');
  const pendingReqs = reqs.data?.length ?? 0;

  return (
    <div>
      <h1>Рабочая область — {language?.name ?? lang}</h1>
      <div className="toolbar">
        {langs.length > 1 ? (
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {langs.map((l) => <option key={l} value={l}>{l} — {me.languages.find((x) => x.code === l)?.name}</option>)}
          </select>
        ) : null}
        <div className="seg">
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>Мой язык</button>
          <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>Новое из других языков</button>
          {(d?.counts.review ?? 0) > 0 || tab === 'review' ? <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>На пересмотр<span className="count">{d?.counts.review ?? ''}</span></button> : null}
          {isWorker || me.role === 'owner' ? <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>Заявки и просьбы{pendingReqs ? <span className="count">{pendingReqs}</span> : null}</button> : null}
        </div>
      </div>
      {me.role === 'owner' && !isWorker ? <Message kind="info">Вы смотрите рабочую область как владелец — только просмотр.</Message> : null}
      {d?.can.unchecked ? <Message kind="info">У языка пока нет валидатора. Ваши переводы сразу видны в глоссарии со статусом «Без проверки».</Message> : null}
      {msgs.map((m, i) => <Message key={i} kind={m.kind} onClose={() => setMsgs(msgs.filter((_, j) => j !== i))}>{m.text}</Message>)}

      {tab === 'requests' ? <RequestsTab me={me} lang={lang} langName={language?.name ?? lang} reqs={reqs} /> : (
        <>
          <div className="toolbar">
            {tab === 'mine' ? (
              <div className="seg">
                {[['all', 'Все'], ['need', `Нужен перевод${d?.kind === 'full' ? ` · ${d?.counts.need ?? ''}` : ''}`], ['draft', `Черновик · ${d?.counts.draft ?? ''}`],
                  ['unchecked', 'Без проверки'], ['approved', 'Согласовано'], ['unused', 'Не используется']].map(([k, label]) => (
                  <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
                ))}
              </div>
            ) : null}
            <select value={project ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Все проекты</option>
              {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <SearchBox value={q} onChange={setQ} />
            <label className="small"><input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} /> переводы других языков</label>
            {d?.can.approve ? <Button kind="primary" disabled={!sel.length} why={!sel.length ? 'Отметьте строки с черновиком' : undefined}
              onClick={() => approveRows(items.filter((x) => sel.includes(x.id)))}>Согласовать выбранные ({sel.length})</Button> : null}
          </div>
          {data.error ? <Message kind="error">{data.error}</Message> : null}
          <div className="table-wrap">
            <table className="grid">
              <thead><tr>
                {d?.can.approve ? <th><input type="checkbox" checked={!!selectable.length && selectable.every((x) => sel.includes(x.id))}
                  onChange={(e) => setSel(e.target.checked ? selectable.map((x) => x.id) : [])} /></th> : null}
                <th>Номер</th><th>Русский термин</th><th className="wide">{lang}</th><th>Статус</th>
                <th>Определение</th><th>Контекст</th><th>Проекты</th>
                {others ? <th>Другие языки</th> : null}
                <th />
              </tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={open === r.id ? 'sel' : ''}>
                    {d?.can.approve ? <td><input type="checkbox" disabled={!(r.status === 'draft' || r.status === 'unchecked')} checked={sel.includes(r.id)}
                      onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td> : null}
                    <td className="tb link" onClick={() => setOpen(r.id)}>{r.tb}</td>
                    <td className="link" onClick={() => setOpen(r.id)}><b>{r.ru}</b>{tab === 'new' ? <div className="muted small">{fmtDate(r.created_at, false)}</div> : null}</td>
                    <td className={`c-${r.status}`}>
                      <TrCell row={r} lang={lang} canType={!!d?.can.type} onSaved={() => data.reload()} />
                      {r.forbidden.length ? <div className="small"><span className="muted">Как нельзя: </span>{r.forbidden.map((f, i) => <span key={i} className="forbidden" title={f.note}>{f.text}{i < r.forbidden.length - 1 ? ', ' : ''}</span>)}</div> : null}
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="muted"><div className="clip">{r.definition}</div></td>
                    <td className="muted">{r.context}</td>
                    <td>{r.projects.join(', ')}</td>
                    {others ? <td className="small">{Object.entries(r.others).map(([l, t]) => <div key={l}><b>{l}</b> {t}</div>)}</td> : null}
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
          {d ? <Pager page={d.page} pages={d.pages} total={d.total} onPage={setPage} /> : null}
        </>
      )}
      <TermDrawer me={me} id={open} onClose={() => setOpen(null)} onChanged={() => data.reload()} />
      {modal ? <ChangeModal mode={modal.mode} termId={modal.row.id} tb={modal.row.tb} ru={modal.row.ru} lang={lang} langName={language?.name ?? lang}
        current={modal.current} onClose={() => setModal(null)} onDone={(t) => { setModal(null); setMsgs([{ kind: 'ok', text: t }]); data.reload(); }} /> : null}
    </div>
  );
}

/** Ячейка перевода: как в таблице, сохраняется сама. Несохранённый текст хранится в браузере. */
function TrCell({ row, lang, canType, onSaved }: { row: WorkItem; lang: string; canType: boolean; onSaved: () => void }) {
  const key = `gl_tr_${row.id}_${lang}`;
  const [v, setV] = useState(() => localStorage.getItem(key) ?? row.text);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
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
      <textarea className="cell-input" rows={1} value={v} placeholder="Впишите перевод"
        onChange={(e) => {
          setV(e.target.value); localStorage.setItem(key, e.target.value); setState('idle');
          window.clearTimeout(timer.current);
          const t = e.target.value;
          timer.current = window.setTimeout(() => save(t), 1500);
        }}
        onBlur={() => { window.clearTimeout(timer.current); if (v !== row.text) save(v); }} />
      <span className={`save-state ${state}`}>{state === 'saving' ? 'Сохраняю…' : state === 'saved' ? 'Сохранено' : state === 'error' ? err : ''}</span>
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
  const items = reqs.data ?? [];

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
      setMsgs([{ kind: 'ok', text: a === 'keep' ? 'Ответ сохранён: оставить.' : res.archived ? 'Все языки отметили — термин ушёл в архив.' : 'Ваш язык помечен «Не используется».' }]);
    } catch (e) { setMsgs([{ kind: 'error', text: (e as Error).message }]); }
    reqs.reload();
  };

  return (
    <>
      {msgs.map((m, i) => <Message key={i} kind={m.kind} onClose={() => setMsgs([])}>{m.text}</Message>)}
      {reqs.error ? <Message kind="error">{reqs.error}</Message> : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Заявка</th><th>Что</th><th>Русский термин</th><th>Предложено</th><th>{lang}</th><th>Автор</th><th>Дубли</th><th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="link" onClick={() => setOpen(r)}>{r.code}{r.comments ? <span className="ccount"><Icon name="comment" size={13} />{r.comments}</span> : null}</td>
                <td>{r.type_label}{r.type === 'new' && !r.lang ? <div className="muted small">на все языки</div> : null}{r.ru_only ? <div className="muted small">русская часть (у {r.lang} нет валидатора)</div> : null}</td>
                <td>{r.tb ? <span className="tb link" onClick={() => setTerm(r.term_id)}>{r.tb} </span> : null}<b>{r.ru}</b>{r.context ? <div className="muted small">{r.context}</div> : null}</td>
                <td className="small">
                  {r.type === 'obsolete' ? <>Причина: {r.reason}</> : <>
                    {r.lang && r.translation ? <div><b>{r.lang}</b> {r.translation}</div> : null}
                    {r.target_text ? <div className="muted">вместо «{r.target_text}»</div> : null}
                    {r.reason && r.type !== 'new' ? <div className="muted">Причина: {r.reason}</div> : null}
                    {r.definition ? <div className="muted">{r.definition}</div> : null}
                  </>}
                </td>
                <td>{r.type === 'new' ? <ReqTranslation r={r} lang={lang} onSaved={() => reqs.reload()} disabled={!(me.role === 'translator' || me.role === 'validator')} /> : null}</td>
                <td><AuthorChip a={r.author} /><div className="muted small">{fmtDate(r.created_at)}</div></td>
                <td>{r.warnings.length ? <span className="badge st-draft" title={r.warnings.join('\n')}><Icon name="alert" size={12} /> {r.warnings.length}</span> : null}</td>
                <td className="nowrap">
                  {r.can_approve ? <>
                    <Button small kind="primary" onClick={() => approve(r)}>Утвердить</Button>
                    <Button small onClick={() => setReject(r)}>Отклонить</Button>
                  </> : null}
                  {r.can_answer ? <>
                    <Button small kind="primary" onClick={() => answer(r, 'unused')}>Не используется</Button>
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
      <p className="muted small" style={{ marginTop: 10 }}>Новый термин утверждается вместе с переводом на ваш язык: впишите его в столбец {lang}. <a href="#/propose" onClick={() => go('propose')}>Предложить термин</a></p>
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
