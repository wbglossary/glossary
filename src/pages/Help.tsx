import { useState } from 'react';
import { ROLE_LABELS, type Role } from '../api';
import type { PageProps } from '../router';

/**
 * Инструкции по ролям. Тексты допишем позже: у каждой роли — список разделов.
 * Раздел без текста показывается как «скоро». Чтобы добавить текст, заполните `text` (абзацы через пустую строку).
 */
interface Section { title: string; text?: string }
const GUIDES: Record<Role, Section[]> = {
  translator: [
    { title: 'С чего начать' }, { title: 'Как перевести термин в «Рабочей области»' }, { title: 'Черновик и согласование' },
    { title: 'Как предложить новый термин' }, { title: 'Заменить перевод или добавить вариант' }, { title: 'Комментарии и вопросы' }
  ],
  validator: [
    { title: 'С чего начать' }, { title: 'Согласование черновиков' }, { title: 'Заявки: утвердить, отклонить, сразу несколько' },
    { title: 'Возможные дубли' }, { title: '«Не используется» и просьбы «Устарел»' }, { title: '«Как нельзя» и поля языка' }, { title: 'Пересмотр переводов «Без проверки»' }
  ],
  manager: [
    { title: 'С чего начать' }, { title: 'Поиск и фильтры в глоссарии' }, { title: 'Предложить русский термин для всех языков' },
    { title: 'Русская часть и проекты термина' }, { title: 'Выгрузка для Smartcat' }
  ],
  contractor: [
    { title: 'С чего начать' }, { title: 'Где и что можно переводить' }, { title: 'Статус «Без проверки»' }, { title: 'Как предложить термин' }
  ],
  reader: [{ title: 'Как найти термин' }, { title: 'Что значат статусы и цвета' }],
  owner: [
    { title: 'Люди, роли и вход через Google' }, { title: 'Языки и валидаторы' }, { title: 'Проекты' }, { title: 'Архив и удаление' },
    { title: 'Журнал изменений' }, { title: 'Обратная связь' }, { title: 'Загрузка таблиц и ночные копии' }
  ]
};
const ORDER: Role[] = ['translator', 'validator', 'manager', 'contractor', 'reader', 'owner'];

export function HelpPage({ me }: PageProps) {
  const owner = me.role === 'owner';
  const [role, setRole] = useState<Role>(me.role);
  const sections = GUIDES[role];
  const ready = sections.filter((s) => s.text).length;
  return (
    <div className="narrow">
      <h1>Инструкция</h1>
      {owner ? (
        <div className="seg" role="tablist" aria-label="Роль">
          {ORDER.map((r) => <button key={r} role="tab" aria-selected={role === r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{ROLE_LABELS[r]}</button>)}
        </div>
      ) : null}
      <p className="muted">
        {owner ? `Инструкция для роли «${ROLE_LABELS[role]}». ` : `Инструкция для вашей роли — «${ROLE_LABELS[role]}». `}
        {ready ? '' : 'Тексты готовятся — пока здесь план разделов. Если что-то непонятно уже сейчас, напишите в «Обратную связь».'}
      </p>
      <ol className="help-toc">
        {sections.map((s, i) => (
          <li key={i} className={s.text ? '' : 'soon'}>
            <h3>{s.title}{s.text ? null : <span className="badge st-unused">скоро</span>}</h3>
            {s.text ? s.text.split(/\n{2,}/).map((p, j) => <p key={j}>{p}</p>) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
