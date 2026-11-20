import { useState } from 'react';
import { fmtDate, rpc, type Author } from '../api';
import type { PageProps } from '../router';
import { AuthorChip } from '../ui/bits';
import { Button, Empty, Message, useAsync } from '../ui/kit';
import { FeedbackModal } from '../ui/FeedbackModal';

interface Item {
  id: number; kind: string; kind_label: string; body: string; page: string; status: 'new' | 'in_progress' | 'done';
  answer: string; answered_at: string | null; created_at: string; mine: boolean; author: Author; answered_by: string | null; unseen: boolean;
}
const STATUS: Record<Item['status'], { l: string; cls: string }> = {
  new: { l: 'Новое', cls: 'st-draft' }, in_progress: { l: 'В работе', cls: 'st-unchecked' }, done: { l: 'Готово', cls: 'st-approved' }
};
const KIND_CLS: Record<string, string> = { question: 'kind-q', problem: 'kind-p', idea: 'kind-i' };

export function FeedbackPage({ me }: PageProps) {
  const owner = me.role === 'owner';
  const [filter, setFilter] = useState<'' | Item['status']>(owner ? 'new' : '');
  const [writing, setWriting] = useState(false);
  const { data, error, loading, reload } = useAsync(() => rpc<Item[]>('feedback_list', { p_status: filter || null }), [filter]);
  const items = data ?? [];

  return (
    <div className="narrow">
      <div className="row gap wrap" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Обратная связь</h1>
        <Button kind="primary" onClick={() => setWriting(true)}>Написать</Button>
      </div>
      <p className="muted">{owner
        ? 'Вопросы, проблемы и идеи всех пользователей. Ответ увидит автор — у него на главной загорится счётчик.'
        : 'Здесь ваши вопросы, жалобы и предложения о сайте и ответы на них. Написать можно с любой страницы — кнопка в правом нижнем углу.'}</p>
      {owner ? (
        <div className="seg">
          {([['new', 'Новые'], ['in_progress', 'В работе'], ['done', 'Готово'], ['', 'Все']] as const).map(([v, l]) => (
            <button key={v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>
      ) : null}
      {error ? <Message kind="error">{error}</Message> : null}
      {items.map((f) => <FeedbackCard key={f.id} f={f} owner={owner} onSaved={reload} />)}
      {!loading && !items.length ? <Empty>{owner ? 'Обращений нет.' : 'Вы ещё ничего не писали. Нажмите «Написать», если что-то непонятно или неудобно.'}</Empty> : null}
      {writing ? <FeedbackModal page="feedback" pageLabel="Обратная связь" onClose={() => { setWriting(false); reload(); }} /> : null}
    </div>
  );
}

function FeedbackCard({ f, owner, onSaved }: { f: Item; owner: boolean; onSaved: () => void }) {
  const [answer, setAnswer] = useState(f.answer);
  const [status, setStatus] = useState(f.status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const dirty = answer !== f.answer || status !== f.status;
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await rpc('answer_feedback', { p_id: f.id, p_answer: answer, p_status: status }); setMsg({ kind: 'ok', text: 'Сохранено.' }); onSaved(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <article className={`card fb-card${f.unseen ? ' fresh' : ''}`}>
      <header className="row gap wrap">
        <span className={`badge ${KIND_CLS[f.kind] ?? ''}`}>{f.kind_label}</span>
        <span className={`badge ${STATUS[f.status].cls}`}>{STATUS[f.status].l}</span>
        {owner ? <AuthorChip a={f.author} /> : null}
        <span className="muted small">{fmtDate(f.created_at)}{f.page ? ` · ${f.page}` : ''}</span>
        {f.unseen ? <span className="badge st-approved">Новый ответ</span> : null}
      </header>
      <p className="fb-body">{f.body}</p>
      {owner ? (
        <div className="fb-answer-form">
          <label className="field"><span>Ответ автору</span>
            <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Автор увидит ответ в «Обратной связи»" />
          </label>
          <div className="row gap wrap">
            <select value={status} onChange={(e) => setStatus(e.target.value as Item['status'])} aria-label="Статус">
              <option value="new">Новое</option><option value="in_progress">В работе</option><option value="done">Готово</option>
            </select>
            <Button kind="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить'}</Button>
            {f.answered_at ? <span className="muted small">ответ от {fmtDate(f.answered_at)}{f.answered_by ? `, ${f.answered_by}` : ''}</span> : null}
          </div>
          {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
        </div>
      ) : f.answer ? (
        <div className="fb-answer"><b>Ответ</b>{f.answered_by ? <span className="muted small"> · {f.answered_by}, {fmtDate(f.answered_at)}</span> : null}<p>{f.answer}</p></div>
      ) : <p className="muted small">Ответа пока нет.</p>}
    </article>
  );
}
