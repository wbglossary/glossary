import { useState } from 'react';
import { rpc } from '../api';
import { go } from '../router';
import { Button, Message } from './kit';

export const FEEDBACK_KINDS = [
  { v: 'question', l: 'Вопрос', hint: 'Не понятно, как что-то сделать' },
  { v: 'problem', l: 'Проблема', hint: 'Что-то не работает или неудобно' },
  { v: 'idea', l: 'Идея', hint: 'Пожелание или предложение' }
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]['v'];

/** Форма обратной связи: открывается кнопкой в углу с любой страницы. Страницу, где был человек, запоминаем сами. */
export function FeedbackModal({ page, pageLabel, onClose }: { page: string; pageLabel: string; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('problem');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const send = async () => {
    setBusy(true); setErr(null);
    try { await rpc('submit_feedback', { p_kind: kind, p_body: body, p_page: `${pageLabel} (#/${page})` }); setDone(true); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="fb-title">
        {done ? (
          <>
            <h3 id="fb-title">Спасибо!</h3>
            <p>Сообщение отправлено. Ответ появится в разделе «Обратная связь», а на главной загорится счётчик.</p>
            <div className="modal-actions">
              <Button onClick={() => { onClose(); go('feedback'); }}>Мои обращения</Button>
              <Button kind="primary" onClick={onClose}>Закрыть</Button>
            </div>
          </>
        ) : (
          <>
            <h3 id="fb-title">Обратная связь</h3>
            <div className="fb-kinds" role="radiogroup" aria-label="Что вы хотите написать">
              {FEEDBACK_KINDS.map((k) => (
                <button key={k.v} type="button" role="radio" aria-checked={kind === k.v} className={kind === k.v ? 'on' : ''} onClick={() => setKind(k.v)}>
                  <b>{k.l}</b><span>{k.hint}</span>
                </button>
              ))}
            </div>
            <label className="field">
              <span>{kind === 'question' ? 'Ваш вопрос' : kind === 'problem' ? 'Что случилось или что неудобно' : 'Ваше предложение'}</span>
              <textarea autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)}
                placeholder={kind === 'problem' ? 'Например: нажимаю «Сохранить» в карточке термина, а ничего не происходит' : ''} />
            </label>
            <p className="muted small">Страница, на которой вы сейчас, — «{pageLabel}» — прикрепится сама.</p>
            {err ? <Message kind="error">{err}</Message> : null}
            <div className="modal-actions">
              <Button onClick={onClose}>Отмена</Button>
              <Button kind="primary" disabled={busy || !body.trim()} onClick={send}>{busy ? 'Отправляю…' : 'Отправить'}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
