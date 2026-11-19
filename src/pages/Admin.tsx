import { useState } from 'react';
import { fmtDate, rpc, type Role } from '../api';
import type { PageProps } from '../router';
import { Avatar } from '../ui/Avatar';
import { Button, Message, useAsync } from '../ui/kit';

interface AUser { id: number; email: string; name: string; role: Role; role_label: string; lang: string | null; contractor_no: number | null; avatar: string; active: boolean; last_seen: string | null; joined: boolean }
interface ALang { code: string; name: string; smartcat: string; kind: 'full' | 'short'; active: boolean; validator: string | null; unchecked: number }

const ROLES: { v: Role; l: string }[] = [
  { v: 'validator', l: 'Валидатор' }, { v: 'translator', l: 'Переводчик' }, { v: 'manager', l: 'Менеджер' },
  { v: 'contractor', l: 'Подрядчик' }, { v: 'reader', l: 'Читатель' }, { v: 'owner', l: 'Владелец' }
];
const needsLang = (r: Role) => r === 'validator' || r === 'translator';

export function AdminPage({ me, reloadMe }: PageProps) {
  const [tab, setTab] = useState<'users' | 'langs' | 'projects'>('users');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); after?.(); reloadMe(); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  return (
    <div>
      <h1>Администрирование</h1>
      <div className="seg">
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Пользователи</button>
        <button className={tab === 'langs' ? 'on' : ''} onClick={() => setTab('langs')}>Языки</button>
        <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>Проекты</button>
      </div>
      {msg ? <Message kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Message> : null}
      {tab === 'users' ? <Users me={me} act={act} /> : tab === 'langs' ? <Langs act={act} /> : <Projects me={me} act={act} />}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, ok: string, after?: () => void) => Promise<void>;

function Users({ me, act }: { me: PageProps['me']; act: Act }) {
  const { data, reload } = useAsync(() => rpc<AUser[]>('admin_users'), []);
  const [form, setForm] = useState({ email: '', name: '', role: 'translator' as Role, lang: '' });
  const [edit, setEdit] = useState<AUser | null>(null);
  const langs = me.languages.filter((l) => l.active);
  return (
    <>
      <div className="card">
        <h3>Добавить человека</h3>
        <div className="row gap wrap">
          <label className="field"><span>Почта Google</span><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field"><span>Имя</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Роль</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
          </label>
          {needsLang(form.role) ? (
            <label className="field"><span>Язык</span>
              <select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value })}>
                <option value="">— выберите —</option>{langs.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <Button kind="primary" onClick={() => act(() => rpc('admin_create_user', { p_email: form.email, p_name: form.name, p_role: form.role, p_lang: needsLang(form.role) ? form.lang : null }),
          'Человек добавлен. Пока приложение Google в тестовом режиме, добавьте эту почту и в «Test users» Google.', () => { setForm({ email: '', name: '', role: 'translator', lang: '' }); reload(); })}>Добавить</Button>
        <p className="muted small">Подрядчик получает постоянный номер («Подрядчик 3») и видит остальных только по роли и языку.</p>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th /><th>Имя</th><th>Почта</th><th>Роль</th><th>Язык</th><th>Входил</th><th /></tr></thead>
          <tbody>{data?.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'off'}>
              <td><Avatar name={u.avatar} size={28} /></td>
              <td><b>{u.name}</b>{u.contractor_no ? <span className="muted"> · Подрядчик {u.contractor_no}</span> : null}{u.active ? null : <span className="badge st-unused">отключён</span>}</td>
              <td>{u.email}</td><td>{u.role_label}</td><td>{u.lang}</td>
              <td className="small">{u.last_seen ? fmtDate(u.last_seen) : u.joined ? 'да' : 'ещё не входил'}</td>
              <td className="nowrap">
                <Button small onClick={() => setEdit(u)}>Изменить</Button>
                {u.id !== me.id ? <Button small kind={u.active ? 'danger' : 'primary'} onClick={() => act(() => rpc('admin_set_active', { p_user: u.id, p_active: !u.active }),
                  u.active ? 'Пользователь отключён.' : 'Пользователь включён.', reload)}>{u.active ? 'Отключить' : 'Включить'}</Button> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit ? (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3>{edit.email}</h3>
            <label className="field"><span>Имя</span><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field"><span>Роль</span>
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
            </label>
            {needsLang(edit.role) ? (
              <label className="field"><span>Язык</span>
                <select value={edit.lang ?? ''} onChange={(e) => setEdit({ ...edit, lang: e.target.value })}>
                  <option value="">— выберите —</option>{langs.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                </select>
              </label>
            ) : null}
            <div className="actions">
              <Button kind="primary" onClick={() => act(() => rpc('admin_update_user', { p_user: edit.id, p_name: edit.name, p_role: edit.role, p_lang: needsLang(edit.role) ? edit.lang : null }),
                'Сохранено.', () => { setEdit(null); reload(); })}>Сохранить</Button>
              <Button onClick={() => setEdit(null)}>Отмена</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Langs({ act }: { act: Act }) {
  const { data, reload } = useAsync(() => rpc<ALang[]>('admin_languages'), []);
  const [form, setForm] = useState({ code: '', name: '', smartcat: '', kind: 'full' as 'full' | 'short' });
  const [rows, setRows] = useState<Record<string, ALang>>({});
  const row = (l: ALang) => rows[l.code] ?? l;
  const setRow = (l: ALang, patch: Partial<ALang>) => setRows({ ...rows, [l.code]: { ...row(l), ...patch } });
  return (
    <>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Код</th><th>Название</th><th>Код Smartcat</th><th>Тип</th><th>Валидатор</th><th>Без проверки</th><th>Включён</th><th /></tr></thead>
          <tbody>{data?.map((l) => { const r = row(l); return (
            <tr key={l.code}>
              <td><b>{l.code}</b></td>
              <td><input value={r.name} onChange={(e) => setRow(l, { name: e.target.value })} /></td>
              <td><input value={r.smartcat} size={8} onChange={(e) => setRow(l, { smartcat: e.target.value })} /></td>
              <td><select value={r.kind} onChange={(e) => setRow(l, { kind: e.target.value as 'full' | 'short' })}>
                <option value="full">полный</option><option value="short">сокращённый</option></select></td>
              <td>{l.validator ?? <span className="muted">нет</span>}</td>
              <td>{l.unchecked || ''}</td>
              <td><input type="checkbox" checked={r.active} onChange={(e) => setRow(l, { active: e.target.checked })} /></td>
              <td>{rows[l.code] ? <Button small kind="primary" onClick={() => act(() => rpc('admin_update_language', { p_code: l.code, p_name: r.name, p_smartcat: r.smartcat, p_kind: r.kind, p_active: r.active }),
                `Язык ${l.code} сохранён.`, () => { const n = { ...rows }; delete n[l.code]; setRows(n); reload(); })}>Сохранить</Button> : null}</td>
            </tr>); })}</tbody>
        </table>
      </div>
      <p className="muted small">Полные языки выгружаются в Smartcat, пустые ячейки у них красные. Сокращённые — глоссарии подрядчиков, в Smartcat не выгружаются. Если у языка нет валидатора, подрядчик добавляет переводы сразу со статусом «Без проверки»; когда валидатор появится, они попадут ему во вкладку «На пересмотр».</p>
      <div className="card">
        <h3>Добавить язык</h3>
        <div className="row gap wrap">
          <label className="field"><span>Код</span><input value={form.code} placeholder="FR" onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label className="field"><span>Название</span><input value={form.name} placeholder="Французский" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Код Smartcat</span><input value={form.smartcat} placeholder="fr" onChange={(e) => setForm({ ...form, smartcat: e.target.value })} /></label>
          <label className="field"><span>Тип</span><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'full' | 'short' })}>
            <option value="full">полный</option><option value="short">сокращённый</option></select></label>
        </div>
        <Button kind="primary" onClick={() => act(() => rpc('admin_add_language', { p_code: form.code, p_name: form.name, p_smartcat: form.smartcat, p_kind: form.kind }),
          'Язык добавлен.', () => { setForm({ code: '', name: '', smartcat: '', kind: 'full' }); reload(); })}>Добавить язык</Button>
      </div>
    </>
  );
}

function Projects({ me, act }: { me: PageProps['me']; act: Act }) {
  const [name, setName] = useState('');
  const [names, setNames] = useState<Record<number, string>>({});
  return (
    <>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Проект</th><th>Состояние</th><th /></tr></thead>
          <tbody>{me.projects.map((p) => (
            <tr key={p.id}>
              <td><input value={names[p.id] ?? p.name} onChange={(e) => setNames({ ...names, [p.id]: e.target.value })} /></td>
              <td>{p.closed ? 'закрыт' : 'открыт'}</td>
              <td className="nowrap">
                {names[p.id] !== undefined && names[p.id] !== p.name ? <Button small kind="primary" onClick={() => act(() => rpc('admin_update_project', { p_project: p.id, p_name: names[p.id], p_closed: p.closed }), 'Проект переименован.')}>Сохранить</Button> : null}
                <Button small onClick={() => act(() => rpc('admin_update_project', { p_project: p.id, p_name: p.name, p_closed: !p.closed }), p.closed ? 'Проект открыт.' : 'Проект закрыт.')}>{p.closed ? 'Открыть' : 'Закрыть'}</Button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="muted small">Закрытый проект нельзя выбрать в новых заявках, но его термины остаются в глоссарии и выгрузке.</p>
      <div className="card row gap">
        <input placeholder="Название нового проекта" value={name} onChange={(e) => setName(e.target.value)} />
        <Button kind="primary" onClick={() => act(() => rpc('admin_add_project', { p_name: name }), 'Проект добавлен.', () => setName(''))}>Добавить проект</Button>
      </div>
    </>
  );
}
