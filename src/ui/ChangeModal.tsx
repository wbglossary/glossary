import { useState } from 'react';
import { langGen, rpc } from '../api';
import { Button, Message } from './kit';

export type ChangeMode = 'replace' | 'edit' | 'variant' | 'translation';

/**
 * Маленькое окно «Заменить» / «Изменить» / «Добавить вариант» / «Предложить перевод».
 * Термин, язык и текущий перевод уже подставлены — остаётся вписать новое и причину.
 */
export function ChangeModal(p: {
  mode: ChangeMode; termId: number; tb: string; ru: string; lang: string; langName: string;
  current?: { id: number; text: string } | null; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titles: Record<ChangeMode, string> = {
    replace: 'Заменить перевод', edit: 'Изменить перевод', variant: 'Добавить вариант', translation: 'Предложить перевод'
  };
  const needReason = p.mode !== 'translation';

  const save = async () => {
    setErr(null);
    if (!text.trim()) return setErr('Впишите перевод.');
    if (needReason && !reason.trim()) return setErr('Укажите причину.');
    setBusy(true);
    try {
      if (p.mode === 'edit') {
        await rpc('edit_translation', { p_translation: p.current!.id, p_text: text, p_reason: reason });
        p.onDone('Перевод изменён. Прежний сохранён в истории.');
      } else {
        const r = await rpc<{ status: string; code?: string; message?: string; warnings?: string[] }>('submit_request', {
          p_input: { type: p.mode, term_id: p.termId, lang: p.lang, translation: text, reason, target_id: p.current?.id ?? null }
        });
        p.onDone(r.status === 'added' ? r.message ?? 'Готово.' : `Заявка ${r.code} отправлена валидатору ${langGen(p.langName)}.` +
          (r.warnings?.length ? ' Возможные дубли: ' + r.warnings.join('; ') : ''));
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onMouseDown={p.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{titles[p.mode]}</h3>
        <dl className="fields">
          <dt>Термин</dt><dd><span className="tb">{p.tb}</span> {p.ru}</dd>
          <dt>Язык</dt><dd>{p.lang} — {p.langName}</dd>
          {p.current ? <><dt>Сейчас</dt><dd>{p.current.text}</dd></> : null}
        </dl>
        <label className="field"><span>{p.mode === 'variant' ? 'Новый вариант' : 'Новый перевод'}</span>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {needReason ? (
          <label className="field"><span>Причина <b className="req">обязательно</b></span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
        {p.mode === 'replace' ? <p className="muted small">Пока валидатор не примет замену, в глоссарии остаётся текущий перевод.</p> : null}
        {err ? <Message kind="error">{err}</Message> : null}
        <div className="modal-actions">
          <Button onClick={p.onClose}>Отмена</Button>
          <Button kind="primary" disabled={busy} onClick={save}>{p.mode === 'edit' ? 'Сохранить' : 'Отправить'}</Button>
        </div>
      </div>
    </div>
  );
}
