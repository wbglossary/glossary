import { useEffect, useMemo, useState } from 'react';
import { can, rpc, type Forbidden, type GlossaryItem, type Page } from '../api';
import { go, type PageProps } from '../router';
import { Button, Message, SearchBox } from '../ui/kit';

type Kind = 'new' | 'translation';
interface Form {
  ru: string; lang: string; translation: string; definition: string; examples: string;
  projectIds: number[]; comment: string;
  lComment: string; forbidden: Forbidden[];
  targets: string[] | null;   // менеджер: на какие языки нужен перевод (null — ещё не трогал, значит все полные)
}
const EMPTY: Form = { ru: '', lang: '', translation: '', definition: '', examples: '', projectIds: [], comment: '',
  lComment: '', forbidden: [], targets: null };
const DRAFT_KEY = 'gl_propose_draft_v3';
interface Similar { id: number; tb: string; ru: string; definition: string; status: string; exact: boolean }
const brief = (s?: string) => (s && s.trim() && s.trim() !== '—' ? ` (${s.length > 80 ? s.slice(0, 80) + '…' : s})` : '');

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
  const [repeat, setRepeat] = useState<{ id: number; tb: string; ru: string; definition: string }[] | null>(null);
  const activeLangs = me.languages.filter((l) => l.active);
  const targets = form.targets ?? activeLangs.filter((l) => l.kind === 'full').map((l) => l.code);
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
    if (kind === 'new' && !langs.length && !targets.length) return setError('Отметьте хотя бы один язык, на который нужен перевод.');
    setBusy(true);
    try {
      const lang_fields = form.lang ? { comment: form.lComment, forbidden: form.forbidden } : {};
      const r = await rpc<{ status: string; code?: string; type?: string; message?: string; warnings?: string[]; matches?: typeof repeat }>('submit_request', {
        p_input: {
          type: kind, ru: form.ru, lang: form.lang || null, translation: form.translation, definition: form.definition, examples: form.examples,
          project_ids: form.projectIds, comment: form.comment, term_id: term?.id ?? null, lang_fields,
          ...(kind === 'new' && !langs.length ? { target_langs: targets } : {}), ...extra
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
            <div className="card row gap"><span className="tb">{term.tb}</span> <b>{term.ru}</b> <span className="muted">{brief(term.definition)}</span>
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
              <ul>{similar.map((s) => <li key={s.id}><span className="tb">{s.tb}</span> {s.ru}{brief(s.definition)}{s.exact ? ' — точное совпадение' : ''}{s.status === 'archived' ? ' — в архиве' : ''}</li>)}</ul>
            </Message>
          ) : null}
          {repeat ? (
            <Message kind="warn">
              <b>Такой русский термин уже есть. Это тот же смысл?</b>
              <ul>{repeat.map((m) => <li key={m.id}><span className="tb">{m.tb}</span> {m.ru}{brief(m.definition)}</li>)}</ul>
              <div className="actions">
                {repeat.map((m) => form.lang && form.translation ? (
                  <Button key={m.id} kind="primary" small disabled={busy} onClick={() => send({ same_as: m.id })}>Да, тот же ({m.tb}) — добавить перевод к нему</Button>
                ) : null)}
                <Button small disabled={busy} onClick={() => send({ new_meaning: true })}>Нет, другой смысл — отправить как новый</Button>
              </div>
              {!form.lang || !form.translation ? <p className="small">Если смысл тот же и перевода у вас нет — ничего отправлять не нужно, термин уже в глоссарии.</p> : null}
              <p className="small">Для другого смысла обязательно заполните «Определение» ниже — по нему термины будут различать.</p>
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
              <Button small kind="link" onClick={() => setShowLangFields(!showLangFields)}>{showLangFields ? 'Скрыть' : 'Добавить'} комментарий лингвиста и «Как нельзя»</Button>
              {showLangFields ? (
                <div className="card">
                  <label className="field"><span>Комментарий лингвиста ({form.lang})</span><textarea value={form.lComment} onChange={(e) => set('lComment', e.target.value)} /></label>
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
      ) : kind === 'new' ? (
        <div className="field"><span>На какие языки нужен перевод</span>
          <div className="checks">{activeLangs.map((l) => (
            <label key={l.code}><input type="checkbox" checked={targets.includes(l.code)}
              onChange={(e) => set('targets', e.target.checked ? [...targets, l.code] : targets.filter((x) => x !== l.code))} /> {l.code} — {l.name}{l.kind === 'short' ? ' (сокр.)' : ''}</label>
          ))}</div>
          <span className="muted small">Заявка уйдёт переводчикам отмеченных языков. Остальные увидят термин во вкладке «Новое из других языков» и переведут, если он им нужен.</span>
        </div>
      ) : null}

      {kind === 'new' ? (
        <>
          <label className="field"><span>Определение (на русском) {repeat ? <b className="req">обязательно для другого смысла</b> : null}</span>
            <textarea value={form.definition} onChange={(e) => set('definition', e.target.value)} /></label>
          <label className="field"><span>Примеры</span><textarea value={form.examples} onChange={(e) => set('examples', e.target.value)} /></label>
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
        <li key={c.id} onClick={() => onPick(c)}><span className="tb">{c.tb}</span> <b>{c.ru}</b> <span className="muted">{brief(c.definition)}</span></li>
      ))}</ul>
    </div>
  );
}
