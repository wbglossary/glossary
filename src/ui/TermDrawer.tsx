import { useEffect, useState } from 'react';
import { fmtDate, langGen, rpc, type Forbidden, type GlossaryItem, type Me, type Page, type TermCard, type TermLang } from '../api';
import { AuthorChip, CopyButton } from './bits';
import { ChangeModal, type ChangeMode } from './ChangeModal';
import { Button, Confirm, Drawer, Message, SearchBox, StatusBadge, useAsync } from './kit';
import { LogCell } from '../logText';

/** Карточка термина справа. Кнопки — только доступные; права всё равно проверяет база. */
export function TermDrawer({ me, id, tb, onClose, onChanged }: { me: Me; id: number | null; tb?: string | null; onClose: () => void; onChanged?: () => void }) {
  // открыть можно по id или по номеру TB (например, из журнала изменений)
  const { data: c, error, loading, reload } = useAsync(
    () => (id ? rpc<TermCard | null>('term_card', { p_id: id }) : tb ? rpc<TermCard | null>('term_card', { p_tb: tb }) : Promise.resolve(null)), [id, tb]);
  const [tab, setTab] = useState<'term' | 'comments' | 'history'>('term');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | { mode: ChangeMode; lang: TermLang; current?: { id: number; text: string } }>(null);
  const [confirm, setConfirm] = useState<null | 'archive' | 'restore' | 'delete' | 'obsolete' | 'merge'>(null);
  const [editRu, setEditRu] = useState(false);
  const [editFields, setEditFields] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const [editProjects, setEditProjects] = useState(false);
  useEffect(() => { setShowEmpty(false); setEditProjects(false); }, [id, tb]);

  const act = async (fn: () => Promise<unknown>, ok: string, close = false) => {
    setBusy(true);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); onChanged?.(); if (close) onClose(); else reload(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); setConfirm(null); }
  };
  const approve = (l: TermLang, on: boolean) => act(async () => {
    const r = await rpc<{ done: string[]; skipped: string[] }>('set_lang_approval', { p_items: [{ id: c!.id, version: c!.version }], p_lang: l.code, p_approve: on });
    if (!r.done.length && r.skipped.length) throw new Error(r.skipped[0]);
  }, on ? 'Согласовано.' : 'Согласование снято — перевод снова черновик.');

  return (
    <Drawer open={!!id || !!tb} onClose={onClose} title={c ? <><span className="tb">{c.tb}</span> {c.ru} <CopyButton text={c.ru} /></> : 'Термин'}>
      {loading && !c ? <div>Загрузка…</div> : null}
      {error ? <Message kind="error">{error}</Message> : null}
      {!loading && !c && !error ? <Message kind="warn">Термин не найден — возможно, его удалили или объединили с другим.</Message> : null}
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      {c ? (
        <>
          <div className="row gap">
            <span className={`badge ${c.status === 'active' ? 'st-approved' : 'st-unused'}`}>{c.status === 'active' ? 'Действует' : 'В архиве'}</span>
            <div className="tabs">
              <button className={tab === 'term' ? 'on' : ''} onClick={() => setTab('term')}>Термин</button>
              <button className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>Комментарии{c.comments.length ? ` (${c.comments.length})` : ''}</button>
              <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>История</button>
            </div>
          </div>

          {c.obsolete_request ? (
            <Message kind="warn">
              <b>Предложено: термин устарел.</b> {c.obsolete_request.reason} <span className="muted">— <AuthorChip a={c.obsolete_request.author} size={16} /></span>
              {c.obsolete_request.answers.length ? <ul>{c.obsolete_request.answers.map((a) => (
                <li key={a.lang}>{a.lang}: {a.answer === 'unused' ? '«Не актуально для языка»' : 'оставить'}{a.comment ? ` — ${a.comment}` : ''}</li>
              ))}</ul> : null}
              <div className="actions">
                {c.obsolete_request.can_answer ? <>
                  <Button small kind="primary" onClick={() => act(() => rpc('answer_obsolete', { p_request: c.obsolete_request!.id, p_answer: 'unused' }), 'Ваш язык помечен «Не актуально для языка».')}>Отметить мой язык «Не актуально для языка»</Button>
                  <Button small onClick={() => { const why = prompt('Почему оставить? (по желанию)') ?? ''; act(() => rpc('answer_obsolete', { p_request: c.obsolete_request!.id, p_answer: 'keep', p_comment: why }), 'Ответ сохранён.'); }}>Оставить</Button>
                </> : null}
                {c.obsolete_request.can_close ? <Button small onClick={() => act(() => rpc('close_obsolete', { p_request: c.obsolete_request!.id }), 'Просьба закрыта.')}>Закрыть просьбу</Button> : null}
              </div>
            </Message>
          ) : null}

          {tab === 'term' ? (
            <>
              <h4>Русская часть</h4>
              {editRu ? <RuForm c={c} me={me} onDone={(n) => { setEditRu(false); if (n !== null) { setMsg({ kind: 'ok', text: n ? 'Сохранено.' : 'Изменений нет.' }); reload(); onChanged?.(); } }} /> : (
                <dl className="fields">
                  <dt>Определение</dt><dd>{c.definition || '—'}</dd>
                  <dt>Примеры</dt><dd>{c.examples || '—'}</dd>
                  <dt>Проекты</dt><dd>
                    {editProjects ? <ProjectsForm c={c} me={me} onDone={(n) => { setEditProjects(false); if (n !== null) { setMsg({ kind: 'ok', text: n ? 'Проекты сохранены.' : 'Изменений нет.' }); reload(); onChanged?.(); } }} /> : <>
                      {c.projects.length ? c.projects.map((p) => p.name).join(', ') : 'Общий (все проекты)'}
                      {c.can.edit_ru ? <> <Button small kind="link" onClick={() => setEditProjects(true)}>Изменить</Button></> : null}
                    </>}
                  </dd>
                  <dt>Комментарий</dt><dd>{c.comment || '—'}</dd>
                </dl>
              )}
              {c.can.edit_ru && !editRu ? <Button small onClick={() => setEditRu(true)}>Изменить русскую часть</Button> : null}

              <h4>Переводы</h4>
              {(() => {
                // Пустые языки (перевода нет, полей нет) сворачиваются в одну строку; свой язык всегда виден.
                const isEmpty = (l: TermLang) => !l.live.length && !l.unused && !l.history.length && !l.draft
                  && !l.comment && !l.forbidden.length && !me.langs.some((x) => x.code === l.code);
                const empty = c.langs.filter(isEmpty);
                const shown = showEmpty ? c.langs : c.langs.filter((l) => !isEmpty(l));
                const block = (l: TermLang) => (
                <div key={l.code} className="langblock">
                    <div className="langhead">
                      <b>{l.code}</b> <span className="muted">{l.name}{l.kind === 'short' ? ' · сокращённый' : ''}</span>
                      <StatusBadge status={l.status} />
                      <span style={{ flex: 1 }} />
                      {l.can.approve && (l.status === 'draft' || l.status === 'unchecked') ? <Button small kind="primary" disabled={busy} onClick={() => approve(l, true)}>Согласовать</Button> : null}
                      {l.can.approve && l.status === 'approved' ? <Button small disabled={busy} onClick={() => approve(l, false)}>Снять согласование</Button> : null}
                      {l.can.unused && l.status !== 'unused' ? <Button small onClick={() => { if (confirm_(`Пометить ${l.name} «Не актуально для языка»? В выгрузке ячейка будет пустой.`)) act(() => rpc('set_unused', { p_term: c.id, p_lang: l.code, p_unused: true }), 'Язык помечен «Не актуально для языка».'); }}>Не актуально</Button> : null}
                      {l.can.unused && l.unused ? <Button small onClick={() => act(() => rpc('set_unused', { p_term: c.id, p_lang: l.code, p_unused: false }), 'Язык возвращён в работу.')}>Вернуть в работу</Button> : null}
                      {l.can.optional && l.status === 'optional' ? <Button small onClick={() => act(() => rpc('set_lang_optional', { p_term: c.id, p_lang: l.code, p_optional: false }), 'Теперь перевод на этот язык нужен.')}>Нужен перевод</Button> : null}
                      {l.can.optional && l.status === 'need' && me.role !== 'validator' ? <Button small kind="link" onClick={() => act(() => rpc('set_lang_optional', { p_term: c.id, p_lang: l.code, p_optional: true }), 'Перевод на этот язык — по желанию.')}>По желанию</Button> : null}
                    </div>
                    {l.live.length ? l.live.map((t, i) => (
                      <div key={t.id} className="row gap" style={{ marginTop: 6 }}>
                        <span>{t.text}</span><CopyButton text={t.text} />
                        {i > 0 ? <span className="muted small">вариант</span> : null}
                        {t.status !== 'approved' ? <StatusBadge status={t.status as never} /> : null}
                        <span style={{ flex: 1 }} />
                        {l.can.edit && t.status !== 'draft' ? <Button small kind="link" onClick={() => setModal({ mode: 'edit', lang: l, current: t })}>Изменить</Button> : null}
                        {l.can.request && t.status !== 'draft' ? <Button small kind="link" onClick={() => setModal({ mode: 'replace', lang: l, current: t })}>Заменить</Button> : null}
                        {!l.can.edit && !l.can.request && l.can.type && t.status === 'approved' && me.langs.some((x) => x.code === l.code && x.role === 'translator') ? <Button small kind="link" onClick={() => setModal({ mode: 'replace', lang: l, current: t })}>Заменить</Button> : null}
                      </div>
                    )) : <div className="muted small" style={{ marginTop: 6 }}>Перевода нет</div>}
                    {c.status === 'active' && !l.unused ? (
                      <div className="row gap" style={{ marginTop: 6 }}>
                        {!l.live.length && (l.can.type || l.can.request) ? <Button small onClick={() => setModal({ mode: 'translation', lang: l })}>{l.can.type ? 'Вписать перевод' : 'Предложить перевод'}</Button> : null}
                        {l.live.length && (l.can.type || l.can.request || l.can.edit) ? <Button small kind="link" onClick={() => setModal({ mode: 'variant', lang: l })}>Добавить вариант</Button> : null}
                      </div>
                    ) : null}
                    {l.history.map((h, i) => <div key={i} className="muted small">было «{h.text}» → «{h.replaced_by}», {fmtDate(h.at, false)}</div>)}
                    <LangFields l={l} />
                    {l.can.fields ? (editFields === l.code
                      ? <FieldsForm c={c} l={l} me={me} onDone={(saved) => { setEditFields(null); if (saved) { setMsg({ kind: 'ok', text: saved }); reload(); } }} />
                      : <Button small kind="link" onClick={() => setEditFields(l.code)}>Комментарий лингвиста и «Как нельзя»</Button>) : null}
                  </div>
                );
                return (
                  <>
                    {shown.map(block)}
                    {empty.length ? (
                      <div className="empty-langs">
                        <span className="muted">{showEmpty ? 'Языки без перевода показаны выше.' : <>Нет перевода: <b>{empty.map((l) => l.code).join(', ')}</b></>}</span>
                        <Button small kind="link" onClick={() => setShowEmpty(!showEmpty)}>{showEmpty ? 'Свернуть' : 'Показать'}</Button>
                      </div>
                    ) : null}
                  </>
                );
              })()}

              {c.pending.length ? (
                <>
                  <h4>Заявки по этому термину</h4>
                  <ul className="plain">{c.pending.map((p) => <li key={p.id}>{p.code} · {p.type}{p.lang ? ` ${p.lang}` : ''}{p.translation ? ` «${p.translation}»` : ''} · <AuthorChip a={p.author} size={16} /></li>)}</ul>
                </>
              ) : null}

              <div className="actions">
                {c.can.propose_obsolete && !c.obsolete_request ? <Button onClick={() => setConfirm('obsolete')}>Предложить: устарел</Button> : null}
                {c.can.merge ? <Button onClick={() => setConfirm('merge')}>Объединить с…</Button> : null}
                {c.can.archive ? <Button onClick={() => setConfirm('archive')}>В архив</Button> : null}
                {c.can.restore ? <Button kind="primary" onClick={() => setConfirm('restore')}>Вернуть из архива</Button> : null}
                {c.can.delete ? <Button kind="danger" onClick={() => setConfirm('delete')}>Удалить окончательно</Button> : null}
              </div>
              <p className="muted small">Создан {fmtDate(c.created_at)} ({c.created_by}). Изменён {fmtDate(c.updated_at)} ({c.updated_by}).</p>
            </>
          ) : tab === 'comments' ? <Comments c={c} reload={reload} setMsg={setMsg} /> : (
            <table className="grid compact">
              <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Было</th><th>Стало</th></tr></thead>
              <tbody>{c.history.map((h, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtDate(h.at)}</td><td>{h.user}</td>
                  <td>{h.action}{h.lang ? ` (${h.lang})` : ''}{h.details ? <div className="muted small">{h.details}</div> : null}</td>
                  <td><LogCell value={h.before} max={140} /></td><td><LogCell value={h.after} max={140} /></td>
                </tr>
              ))}</tbody>
            </table>
          )}

          {modal ? <ChangeModal mode={modal.mode} termId={c.id} tb={c.tb} ru={c.ru} lang={modal.lang.code} langName={modal.lang.name}
            current={modal.current} onClose={() => setModal(null)}
            onDone={(t) => { setModal(null); setMsg({ kind: 'ok', text: t }); reload(); onChanged?.(); }} /> : null}
          {confirm === 'obsolete' ? <ObsoleteConfirm onCancel={() => setConfirm(null)} busy={busy}
            onOk={(reason) => act(() => rpc('propose_obsolete', { p_term: c.id, p_reason: reason }), 'Просьба отправлена валидаторам.')} /> : null}
          {confirm === 'merge' ? <MergeDialog c={c} onCancel={() => setConfirm(null)}
            onDone={(t) => { setConfirm(null); setMsg({ kind: 'ok', text: t }); onChanged?.(); onClose(); }} /> : null}
          {confirm === 'archive' ? (
            <Confirm title={`Отправить ${c.tb} в архив?`} confirmLabel="В архив" busy={busy} onCancel={() => setConfirm(null)}
              onConfirm={() => act(() => rpc('archive_term', { p_term: c.id, p_version: c.version }), 'Термин в архиве.')}>
              Термин исчезнет из глоссария и выгрузок. Переводы сохранятся — его можно будет вернуть.
            </Confirm>
          ) : null}
          {confirm === 'restore' ? (
            <Confirm title={`Вернуть ${c.tb} из архива?`} confirmLabel="Вернуть" busy={busy} onCancel={() => setConfirm(null)}
              onConfirm={() => act(() => rpc('restore_term', { p_term: c.id, p_version: c.version }), 'Термин возвращён.')}>
              Термин вернётся с теми же переводами и статусами, что были до архива.
            </Confirm>
          ) : null}
          {confirm === 'delete' ? (
            <Confirm title={`Удалить ${c.tb} навсегда?`} confirmLabel="Удалить навсегда" danger requireText={c.tb} busy={busy} onCancel={() => setConfirm(null)}
              onConfirm={() => act(() => rpc('delete_term', { p_term: c.id, p_typed_tb: c.tb }), 'Термин удалён.', true)}>
              Термин и все переводы удалятся без возможности вернуть. Номер больше не будет использоваться. В журнале останется запись.
            </Confirm>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

const confirm_ = (t: string) => window.confirm(t);
const short = (s: string | null) => (s && s.length > 140 ? s.slice(0, 140) + '…' : s);

function LangFields({ l }: { l: TermLang }) {
  if (!l.comment && !l.forbidden.length && !l.draft) return null;
  return (
    <div className="small" style={{ marginTop: 6 }}>
      {l.comment ? <div style={{ whiteSpace: 'pre-line' }}><span className="muted">Комментарий лингвиста:</span> {l.comment}</div> : null}
      {l.forbidden.length ? <div><span className="muted">Как нельзя:</span> {l.forbidden.map((f, i) => (
        <span key={i}><span className="forbidden">{f.text}</span>{f.note ? <span className="muted"> ({f.note})</span> : null}{i < l.forbidden.length - 1 ? ', ' : ''}</span>
      ))}</div> : null}
      {l.draft ? <div className="muted">Есть изменения полей от переводчика — появятся после согласования.</div> : null}
    </div>
  );
}

function FieldsForm({ c, l, me, onDone }: { c: TermCard; l: TermLang; me: Me; onDone: (msg: string | null) => void }) {
  const d = (l.draft ?? {}) as { comment?: string; forbidden?: Forbidden[] };
  const [f, setF] = useState({ comment: d.comment ?? l.comment });
  const [forb, setForb] = useState<Forbidden[]>(d.forbidden ?? l.forbidden);
  const [err, setErr] = useState<string | null>(null);
  const direct = l.can.approve || me.is_en_validator || (me.role === 'contractor');
  const save = async () => {
    try {
      await rpc('edit_lang_fields', { p_term: c.id, p_lang: l.code, p_fields: { ...f, forbidden: forb }, p_version: c.version });
      onDone(direct ? 'Поля сохранены.' : 'Изменения сохранены как черновик — их согласует валидатор.');
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card">
      <label className="field"><span>Комментарий лингвиста ({l.code})</span>
        <textarea value={f.comment} placeholder="Например: в интерфейсе приложения — только так; для сайта допустим вариант…" onChange={(e) => setF({ ...f, comment: e.target.value })} /></label>
      <div className="field"><span>Как нельзя — неправильные варианты</span>
        {forb.map((x, i) => (
          <div key={i} className="row gap">
            <input placeholder="Неправильный вариант" value={x.text} onChange={(e) => setForb(forb.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} />
            <input placeholder="Почему (по желанию)" value={x.note} onChange={(e) => setForb(forb.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} />
            <Button small kind="link" onClick={() => setForb(forb.filter((_, j) => j !== i))}>убрать</Button>
          </div>
        ))}
        <Button small kind="link" onClick={() => setForb([...forb, { text: '', note: '' }])}>+ добавить вариант «как нельзя»</Button>
      </div>
      {err ? <Message kind="error">{err}</Message> : null}
      <div className="actions"><Button onClick={() => onDone(null)}>Отмена</Button><Button kind="primary" onClick={save}>Сохранить</Button></div>
    </div>
  );
}

function RuForm({ c, me, onDone }: { c: TermCard; me: Me; onDone: (n: number | null) => void }) {
  const [f, setF] = useState({ definition: c.definition, examples: c.examples, comment: c.comment });
  const [projects, setProjects] = useState<number[]>(c.projects.map((p) => p.id));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try { onDone(await rpc<number>('edit_ru', { p_term: c.id, p_version: c.version, p_fields: { ...f, project_ids: projects } })); }
    catch (e) { setErr((e as Error).message); }
  };
  const area = (k: keyof typeof f, label: string) => (
    <label className="field"><span>{label}</span><textarea value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <div className="card">
      <p className="muted small">Русский термин не меняется. Нужен другой — предложите новый термин.</p>
      {area('definition', 'Определение')}
      {area('examples', 'Примеры')}
      <div className="field"><span>Проекты (не выбрано — общий термин)</span>
        <div className="checks">{me.projects.filter((p) => !p.closed || projects.includes(p.id)).map((p) => (
          <label key={p.id}><input type="checkbox" checked={projects.includes(p.id)} disabled={p.closed && !projects.includes(p.id)}
            onChange={(e) => setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))} /> {p.name}{p.closed ? ' (закрыт)' : ''}</label>
        ))}</div>
      </div>
      {area('comment', 'Комментарий')}
      {err ? <Message kind="error">{err}</Message> : null}
      <div className="actions"><Button onClick={() => onDone(null)}>Отмена</Button><Button kind="primary" onClick={save}>Сохранить</Button></div>
    </div>
  );
}

function Comments({ c, reload, setMsg }: { c: TermCard; reload: () => void; setMsg: (m: { kind: 'ok' | 'error'; text: string } | null) => void }) {
  const [text, setText] = useState('');
  const send = async () => {
    try { await rpc('add_term_comment', { p_term: c.id, p_body: text }); setText(''); reload(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  return (
    <>
      {c.comments.length ? (
        <ul className="comments">{c.comments.map((m) => (
          <li key={m.id}>
            <div className="row gap"><AuthorChip a={m.author} /> <span className="muted small">{fmtDate(m.at)}</span>
              {c.can.hide_comment ? <Button small kind="link" onClick={async () => { await rpc('hide_term_comment', { p_comment: m.id }); reload(); }}>скрыть</Button> : null}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.body}</div>
          </li>
        ))}</ul>
      ) : <p className="muted">Комментариев пока нет. Задайте вопрос или поделитесь мнением о термине.</p>}
      {c.can.comment ? (
        <>
          <label className="field"><span>Ваш комментарий</span><textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
          <Button kind="primary" disabled={!text.trim()} onClick={send}>Отправить</Button>
        </>
      ) : null}
    </>
  );
}

function ObsoleteConfirm({ onOk, onCancel, busy }: { onOk: (reason: string) => void; onCancel: () => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Confirm title="Предложить: термин устарел" confirmLabel="Отправить просьбу" busy={busy || !reason.trim()} onCancel={onCancel} onConfirm={() => onOk(reason)}>
      Валидаторы всех языков, где есть перевод, получат просьбу отметить свой язык «Не актуально для языка». Когда отметят все — термин уйдёт в архив.
      <label className="field"><span>Почему термин устарел <b className="req">обязательно</b></span><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Confirm>
  );
}

function MergeDialog({ c, onCancel, onDone }: { c: TermCard; onCancel: () => void; onDone: (msg: string) => void }) {
  const [q, setQ] = useState(c.ru);
  const { data } = useAsync(() => rpc<Page<GlossaryItem>>('glossary_page', { p_q: q || null, p_size: 20 }), [q]);
  const [other, setOther] = useState<GlossaryItem | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const conflicts = other ? c.langs.filter((l) => l.live.length && other.cells[l.code]?.t.length) : [];
  const [main, setMain] = useState<Record<string, number>>({});
  const run = async () => {
    try {
      const r = await rpc<{ tb: string; retired: string }>('merge_terms', { p_keep: c.id, p_drop: other!.id, p_main: main });
      onDone(`Объединено в ${r.tb}. Номер ${r.retired} больше не используется.`);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Объединить {c.tb} с другим термином</h3>
        {!other ? (
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Найдите дубль" />
            <ul className="pick">{data?.items.filter((x) => x.id !== c.id).map((x) => (
              <li key={x.id} onClick={() => setOther(x)}><span className="tb">{x.tb}</span> <b>{x.ru}</b> {x.definition ? <span className="muted">({x.definition.slice(0, 80)})</span> : null}</li>
            ))}</ul>
          </>
        ) : (
          <>
            <p>Останется термин с <b>меньшим номером</b>. Второй номер больше не будет использоваться. Переводы, комментарии и проекты объединятся.</p>
            <p><span className="tb">{c.tb}</span> {c.ru} + <span className="tb">{other.tb}</span> {other.ru}</p>
            {conflicts.length ? <>
              <p className="muted small">Где переводы есть у обоих, выберите основной — остальные станут вариантами:</p>
              {conflicts.map((l) => (
                <label key={l.code} className="field"><span>{l.code}</span>
                  <select value={main[l.code] ?? ''} onChange={(e) => setMain({ ...main, [l.code]: Number(e.target.value) })}>
                    <option value="">основной как у {c.tb < other.tb ? c.tb : other.tb}</option>
                    {l.live.map((t) => <option key={t.id} value={t.id}>{c.tb}: {t.text}</option>)}
                  </select>
                  <span className="muted small">У {other.tb}: {other.cells[l.code].t.join('; ')}</span>
                </label>
              ))}
            </> : null}
          </>
        )}
        {err ? <Message kind="error">{err}</Message> : null}
        <div className="modal-actions">
          <Button onClick={onCancel}>Отмена</Button>
          {other ? <Button kind="primary" onClick={run}>Объединить</Button> : null}
        </div>
      </div>
    </div>
  );
}

export { langGen };

/** Быстрое изменение проектов термина — только галочки, без формы всей русской части. */
function ProjectsForm({ c, me, onDone }: { c: TermCard; me: Me; onDone: (n: number | null) => void }) {
  const [projects, setProjects] = useState<number[]>(c.projects.map((p) => p.id));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try { onDone(await rpc<number>('edit_ru', { p_term: c.id, p_version: c.version, p_fields: { project_ids: projects } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="projects-form">
      <div className="checks">{me.projects.filter((p) => !p.closed || projects.includes(p.id)).map((p) => (
        <label key={p.id}><input type="checkbox" checked={projects.includes(p.id)} disabled={p.closed && !projects.includes(p.id)}
          onChange={(e) => setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))} /> {p.name}{p.closed ? ' (закрыт)' : ''}</label>
      ))}</div>
      <p className="muted small">Без отметок — общий термин для всех проектов.</p>
      {err ? <Message kind="error">{err}</Message> : null}
      <div className="row gap">
        <Button small kind="primary" disabled={busy} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить'}</Button>
        <Button small onClick={() => onDone(null)}>Отмена</Button>
      </div>
    </div>
  );
}
