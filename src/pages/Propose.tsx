import { useEffect, useMemo, useState } from 'react';
import { can, rpc, type Forbidden, type GlossaryItem, type Page } from '../api';
import { go, type PageProps } from '../router';
import { Button, Message, SearchBox } from '../ui/kit';

type Kind = 'new' | 'translation';
interface Form {
  ru: string; lang: string; translation: string; definition: string; examples: string; context: string;
  projectIds: number[]; comment: string;
  lDefinition: string; lExamples: string; lContext: string; forbidden: Forbidden[];
}
const EMPTY: Form = { ru: '', lang: '', translation: '', definition: '', examples: '', context: '', projectIds: [], comment: '',
  lDefinition: '', lExamples: '', lContext: '', forbidden: [] };
const DRAFT_KEY = 'gl_propose_draft_v2';
interface Similar { id: number; tb: string; ru: string; context: string; status: string; exact: boolean }

export function ProposePage({ me, route }: PageProps) {
  const langs = can.proposeLangs(me);
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } }, []);
  const [kind, setKind] = useState<Kind>((route.params.get('type') as Kind) || saved?.kind || 'new');
  const [form, setForm] = useState<Form>(() => {
    const f: Form = { ...EMPTY, lang: langs.length === 1 ? langs[0] : '', ...(saved?.form ?? {}) };
    if (f.lang && !langs.includes(f.lang)) f.lang = langs.length === 1 ? langs[0] : '';
    return f;
  });
  const [term, setTerm] = useState<GlossaryItem | null>(null);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [repeat, setRepeat] = useState<{ id: number; tb: string; ru: string; context: string }[] | null>(null);
  const [result, setResult] = useState<{ text: string; code?: string; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLangFields, setShowLangFields] = useState(false);

  useEffect(() => { localStorage.setItem(DRAFT_KEY, JSON.stringify({ kind, form })); }, [kind, form]);
  useEffect(() => {
    if (kind !== 'new' || form.ru.trim().length < 2) { setSimilar([]); return; }
    const t = window.setTimeout(() => rpc<Similar[]>('similar_terms', { p_ru: form.ru }).then(setSimilar).catch(() => setSimilar([])), 300);
    return () => window.clearTimeout(t);
  }, [form.ru, kind]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const send = async (extra: Record<string, unknown> = {}) => {
    setError(null);
    if (kind === 'new' && !form.ru.trim()) return setError('Впишите русский термин.');
    if (kind === 'translation' && !term) return setError('Выберите термин.');
    if (kind === 'translation' && (!form.lang || !form.translation.trim())) return setError('Выберите язык и впишите перевод.');
    setBusy(true);
    try {
      const lang_fields = form.lang ? { definition: form.lDefinition, examples: form.lExamples, context: form.lContext, forbidden: form.forbidden } : {};
      const r = await rpc<{ status: string; code?: string; type?: string; message?: string; warnings?: string[]; matches?: typeof repeat }>('submit_request', {
        p_input: {
          type: kind, ru: form.ru, lang: form.lang || null, translation: form.translation, definition: form.definition, examples: form.examples,
          context: form.context, project_ids: form.projectIds, comment: form.comment, term_id: term?.id ?? null, lang_fields, ...extra
        }
      });
      if (r.status === 'repeat') { setRepeat(r.matches ?? []); return; }
      setResult({ text: r.status === 'added' ? r.message ?? 'Готово.' : `Заявка ${r.code} отправлена. Её рассмотрит валидатор.`, code: r.code, warnings: r.warnings ?? [] });
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const restart = () => { setResult(null); setForm({ ...EMPTY, lang: langs.length === 1 ? langs[0] : '' }); setTerm(null); setRepeat(null); setError(null); localStorage.removeItem(DRAFT_KEY); };

  if (result) {
    return (
      <div className="narrow">
        <h1>Готово</h1>
        <Message kind="ok">{result.text}</Message>
        {result.warnings.length ? <Message kind="warn">Возможные дубли — валидатор их увидит:<ul>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Message> : null}
        <div className="actions">
          {result.code ? <Button kind="primary" onClick={() => go('my-requests')}>Открыть «Мои заявки»</Button> : null}
          <Button onClick={restart}>Предложить ещё</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="narrow">
      <h1>Предложить термин</h1>
      <h3>1. Что вы предлагаете</h3>
      <div className="kinds">
        <label className={`kind ${kind === 'new' ? 'on' : ''}`}>
          <input type="radio" checked={kind === 'new'} onChange={() => { setKind('new'); setRepeat(null); }} />
          <b>Новый термин</b><span className="muted">Новый смысл, которого ещё нет в глоссарии.</span>
        </label>
        {langs.length ? (
          <label className={`kind ${kind === 'translation' ? 'on' : ''}`}>
            <input type="radio" checked={kind === 'translation'} onChange={() => { setKind('translation'); setRepeat(null); }} />
            <b>Перевод к существующему термину</b><span className="muted">Термин есть, а перевода на нужный язык нет.</span>
          </label>
        ) : null}
      </div>
      <p className="muted small">Заменить перевод или добавить вариант можно прямо в карточке термина — кнопками «Заменить» и «Добавить вариант».</p>

      {kind === 'translation' ? (
        <>
          <h3>2. Термин</h3>
          {term ? (
            <div className="card row gap"><span className="tb">{term.tb}</span> <b>{term.ru}</b> {term.context ? <span className="muted">({term.context})</span> : null}
              <Button small kind="link" onClick={() => setTerm(null)}>выбрать другой</Button></div>
          ) : <TermPicker onPick={setTerm} />}
        </>
      ) : null}

      <h3>{kind === 'new' ? '2' : '3'}. Поля</h3>
      {kind === 'new' ? (
        <>
          <label className="field"><span>Русский термин <b className="req">обязательно</b></span>
            <input value={form.ru} onChange={(e) => { set('ru', e.target.value); setRepeat(null); }} autoFocus />
          </label>
          {similar.length && !repeat ? (
            <Message kind="warn">Похожие термины уже есть — проверьте, не то же ли это. Заявку всё равно можно отправить.
              <ul>{similar.map((s) => <li key={s.id}><span className="tb">{s.tb}</span> {s.ru}{s.context ? ` (${s.context})` : ''}{s.exact ? ' — точное совпадение' : ''}{s.status === 'archived' ? ' — в архиве' : ''}</li>)}</ul>
            </Message>
          ) : null}
          {repeat ? (
            <Message kind="warn">
              <b>Такой русский термин уже есть. Это тот же смысл?</b>
              <ul>{repeat.map((m) => <li key={m.id}><span className="tb">{m.tb}</span> {m.ru}{m.context ? ` (${m.context})` : ''}</li>)}</ul>
              <div className="actions">
                {repeat.map((m) => form.lang && form.translation ? (
                  <Button key={m.id} kind="primary" small disabled={busy} onClick={() => send({ same_as: m.id })}>Да, тот же ({m.tb}) — добавить перевод к нему</Button>
                ) : null)}
                <Button small disabled={busy} onClick={() => send({ new_meaning: true })}>Нет, другой смысл — отправить как новый</Button>
              </div>
              {!form.lang || !form.translation ? <p className="small">Если смысл тот же и перевода у вас нет — ничего отправлять не нужно, термин уже в глоссарии.</p> : null}
              <p className="small">Для другого смысла обязательно заполните «Значение или контекст» ниже.</p>
            </Message>
          ) : null}
        </>
      ) : null}

      {langs.length ? (
        <>
          <label className="field"><span>Язык перевода{kind === 'new' ? ' (по желанию)' : ''}</span>
            <select value={form.lang} onChange={(e) => set('lang', e.target.value)}>
              <option value="">{kind === 'new' ? '— без перевода —' : '— выберите —'}</option>
              {langs.map((l) => { const L = me.languages.find((x) => x.code === l); return <option key={l} value={l}>{l} — {L?.name}{L && !L.has_validator && me.role === 'contractor' ? ' (сразу, без проверки)' : ''}</option>; })}
            </select>
          </label>
          {form.lang ? (
            <>
              <label className="field"><span>Перевод{kind === 'new' ? ' (по желанию)' : ''}</span>
                <input value={form.translation} onChange={(e) => set('translation', e.target.value)} />
              </label>
              <Button small kind="link" onClick={() => setShowLangFields(!showLangFields)}>{showLangFields ? 'Скрыть' : 'Добавить'} определение, примеры, «Как нельзя» на этом языке</Button>
              {showLangFields ? (
                <div className="card">
                  <label className="field"><span>Определение на этом языке</span><textarea value={form.lDefinition} onChange={(e) => set('lDefinition', e.target.value)} /></label>
                  <label className="field"><span>Примеры</span><textarea value={form.lExamples} onChange={(e) => set('lExamples', e.target.value)} /></label>
                  <label className="field"><span>Значение или контекст</span><input value={form.lContext} onChange={(e) => set('lContext', e.target.value)} /></label>
                  <div className="field"><span>Как нельзя</span>
                    {form.forbidden.map((x, i) => (
                      <div key={i} className="row gap">
                        <input placeholder="Неправильный вариант" value={x.text} onChange={(e) => set('forbidden', form.forbidden.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} />
                        <input placeholder="Почему" value={x.note} onChange={(e) => set('forbidden', form.forbidden.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} />
                      </div>
                    ))}
                    <Button small kind="link" onClick={() => set('forbidden', [...form.forbidden, { text: '', note: '' }])}>+ вариант «как нельзя»</Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : <p className="muted small">Вы предлагаете только русскую часть — заявка уйдёт переводчикам всех языков.</p>}

      {kind === 'new' ? (
        <>
          <label className="field"><span>Определение (на русском)</span><textarea value={form.definition} onChange={(e) => set('definition', e.target.value)} /></label>
          <label className="field"><span>Примеры</span><textarea value={form.examples} onChange={(e) => set('examples', e.target.value)} /></label>
          <label className="field"><span>Значение или контекст {repeat ? <b className="req">обязательно для другого смысла</b> : null}</span>
            <input value={form.context} onChange={(e) => set('context', e.target.value)} /></label>
          <div className="field"><span>Проекты (не выбрано — общий термин)</span>
            <div className="checks">{me.projects.filter((p) => !p.closed).map((p) => (
              <label key={p.id}><input type="checkbox" checked={form.projectIds.includes(p.id)}
                onChange={(e) => set('projectIds', e.target.checked ? [...form.projectIds, p.id] : form.projectIds.filter((x) => x !== p.id))} /> {p.name}</label>
            ))}</div>
          </div>
          <label className="field"><span>Комментарий</span><textarea value={form.comment} onChange={(e) => set('comment', e.target.value)} /></label>
        </>
      ) : null}

      {error ? <Message kind="error">{error}</Message> : null}
      {!repeat ? (
        <div className="actions">
          <Button kind="primary" disabled={busy} onClick={() => send()}>Отправить</Button>
          <Button kind="link" onClick={restart}>Очистить форму</Button>
        </div>
      ) : null}
      <p className="muted small">Введённое сохраняется автоматически, пока вы не отправите.</p>
    </div>
  );
}

function TermPicker({ onPick }: { onPick: (t: GlossaryItem) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<GlossaryItem[]>([]);
  useEffect(() => {
    if (!q.trim()) { setItems([]); return; }
    rpc<Page<GlossaryItem>>('glossary_page', { p_q: q, p_size: 20 }).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [q]);
  return (
    <div className="card">
      <SearchBox value={q} onChange={setQ} placeholder="Начните вводить русский термин, перевод или TB-" />
      <ul className="pick">{items.map((c) => (
        <li key={c.id} onClick={() => onPick(c)}><span className="tb">{c.tb}</span> <b>{c.ru}</b> {c.context ? <span className="muted">({c.context})</span> : null}</li>
      ))}</ul>
    </div>
  );
}
