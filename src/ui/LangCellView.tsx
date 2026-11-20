import { fmtDate, type Cell, type GlossaryItem } from '../api';
import { CopyButton } from './bits';
import { Icon } from './Icon';

/** Ячейка языка в таблице: перевод, «Скопировать», значки замены и «Как нельзя». */
export function LangCellView({ cell, kind, replaced, showComment }: { cell?: Cell; kind: 'full' | 'short'; replaced?: GlossaryItem['replaced']; showComment?: boolean }) {
  if (!cell) return <td />;
  const cls = cell.s === 'unused' ? 'c-unused' : cell.s === 'unchecked' ? 'c-unchecked'
    : cell.s === 'need' || (cell.s === 'draft' && !cell.t.length) ? (kind === 'full' ? 'c-need' : '') : '';
  const text = cell.t.join('; ');
  return (
    <td className={cls}>
      {cell.s === 'unused' ? <span className="muted small">не актуально</span> : null}
      {cell.s === 'optional' ? <span className="muted small">по желанию</span> : null}
      {text ? <>{text}<CopyButton text={cell.t[0]} /></> : null}
      {cell.s === 'unchecked' ? <span className="muted small"> без проверки</span> : null}
      {replaced?.length ? <span className="rep" title={replaced.map((x) => `Было «${x.old}», заменено ${fmtDate(x.at, false)}`).join('\n')}><Icon name="swap" size={14} /></span> : null}
      {cell.f ? <span className="warn-icon" title="Есть неправильные варианты «Как нельзя» — откройте карточку"><Icon name="alert" size={14} /></span> : null}
      {showComment && cell.c ? <div className="cell-note" title={cell.c}>{cell.c}</div> : null}
    </td>
  );
}
