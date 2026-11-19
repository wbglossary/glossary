import { useState } from 'react';
import { fmtDate, rpc, type Author, type RequestItem } from '../api';
import { AuthorChip } from './bits';
import { Button, Drawer, Message, useAsync } from './kit';

/** Карточка заявки: подробности, комментарии, исправление своей заявки. */
export function RequestDrawer({ item, onClose, onChanged }: { item: RequestItem | null; onClose: () => void; onChanged?: () => void }) {
  const { data: comments, error, reload } = useAsync(
    () => (item ? rpc<{ id: number; author: Author; body: string; at: string }[]>('list_request_comments', { p_request: item.id }) : Promise.resolve([])),
    [item?.id]
  );
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  if (!item) return null;
  const send = async () => {
    try { await rpc('add_request_comment', { p_request: item.id, p_body: text }); setText(''); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  const editable = item.mine && item.status === 'pending' && item.type !== 'obsolete';
  return (
    <Drawer open onClose={onClose} title={<>{item.code} · {item.type_label}</>}>
      <dl className="fields">
        <dt>Русский термин</dt><dd><b>{item.ru}</b>{item.tb ? <> · <span className="tb">{item.tb}</span></> : null}</dd>
        <dt>Статус</dt><dd>{item.status_label}{item.decided_by ? ` · ${item.decided_by}, ${fmtDate(item.decided_at)}` : ''}</dd>
        {item.lang ? <><dt>Язык</dt><dd>{item.lang}</dd></> : <><dt>Язык</dt><dd>все полные языки</dd></>}
        {item.translation ? <><dt>Перевод</dt><dd>{item.translation}</dd></> : null}
        {Object.keys(item.translations).length ? <><dt>Вписанные переводы</dt><dd>{Object.entries(item.translations).map(([l, t]) => `${l}: ${t}`).join('\n')}</dd></> : null}
        {item.target_text ? <><dt>Заменяет</dt><dd>«{item.target_text}»</dd></> : null}
        {item.definition ? <><dt>Определение</dt><dd>{item.definition}</dd></> : null}
        {item.examples ? <><dt>Примеры</dt><dd>{item.examples}</dd></> : null}
        {item.context ? <><dt>Значение или контекст</dt><dd>{item.context}</dd></> : null}
        {item.projects.length ? <><dt>Проекты</dt><dd>{item.projects.join(', ')}</dd></> : null}
        {item.reason ? <><dt>Причина</dt><dd>{item.reason}</dd></> : null}
        {item.comment ? <><dt>Комментарий автора</dt><dd>{item.comment}</dd></> : null}
        <dt>Автор</dt><dd><AuthorChip a={item.author} /> · {fmtDate(item.created_at)}</dd>
      </dl>
      {item.warnings.length ? <Message kind="warn">Возможные дубли:<ul>{item.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Message> : null}
      {editable && !edit ? <Button small onClick={() => setEdit(true)}>Исправить заявку</Button> : null}
      {edit ? <EditForm item={item} onDone={(ok) => { setEdit(false); if (ok) onChanged?.(); }} /> : null}
      <h4>Комментарии к заявке</h4>
      {error ? <Message kind="error">{error}</Message> : null}
      {comments?.length ? (
        <ul className="comments">{comments.map((c) => (
          <li key={c.id}><AuthorChip a={c.author} /> <span className="muted small">{fmtDate(c.at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></li>
        ))}</ul>
      ) : <p className="muted">Комментариев пока нет.</p>}
      <label className="field"><span>Ваш комментарий</span><textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
      {err ? <Message kind="error">{err}</Message> : null}
      <Button kind="primary" disabled={!text.trim()} onClick={send}>Отправить комментарий</Button>
    </Drawer>
  );
}

function EditForm({ item, onDone }: { item: RequestItem; onDone: (ok: boolean) => void }) {
  const [f, setF] = useState({ ru: item.ru, translation: item.translation, definition: item.definition, examples: item.examples, context: item.context, comment: item.comment, reason: item.reason });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try { await rpc('edit_request', { p_request: item.id, p_input: f }); onDone(true); }
    catch (e) { setErr((e as Error).message); }
  };
  const field = (k: keyof typeof f, label: string, show = true) => show ? (
    <label className="field"><span>{label}</span><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  ) : null;
  return (
    <div className="card">
      {field('ru', 'Русский термин', item.type === 'new')}
      {field('translation', 'Перевод', !!item.lang)}
      {field('definition', 'Определение', item.type === 'new')}
      {field('examples', 'Примеры', item.type === 'new')}
      {field('context', 'Значение или контекст', item.type === 'new')}
      {field('reason', 'Причина', item.type === 'replace' || item.type === 'variant')}
      {field('comment', 'Комментарий', item.type === 'new')}
      {err ? <Message kind="error">{err}</Message> : null}
      <div className="actions"><Button onClick={() => onDone(false)}>Отмена</Button><Button kind="primary" onClick={save}>Сохранить</Button></div>
    </div>
  );
}
