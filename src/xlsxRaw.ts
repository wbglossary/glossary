/**
 * Запасное чтение .xlsx без ExcelJS. Smartcat сохраняет xlsx с префиксами «x:» и без стилей —
 * ExcelJS такие файлы не открывает. Здесь просто разбираем XML листов.
 */
export interface RawSheet { name: string; rows: string[][] }

const colIndex = (ref: string | null, fallback: number) => {
  const m = ref?.match(/^([A-Z]+)/);
  if (!m) return fallback;
  return [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
};
const byTag = (el: Element | Document, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));
const textOf = (el: Element, tag: string) => byTag(el, tag).map((t) => t.textContent ?? '').join('');

export async function readXlsxRaw(buf: ArrayBuffer): Promise<RawSheet[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buf);
  const xml = async (path: string) => {
    const f = zip.file(path.replace(/^\//, ''));
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const shared = await xml('xl/sharedStrings.xml');
  const strings = shared ? byTag(shared, 'si').map((si) => textOf(si, 't')) : [];
  const wb = await xml('xl/workbook.xml');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  const target = (id: string | null) => {
    const r = rels ? byTag(rels, 'Relationship').find((x) => x.getAttribute('Id') === id) : null;
    const t = r?.getAttribute('Target') ?? '';
    return t.startsWith('/') ? t.slice(1) : 'xl/' + t;
  };
  const sheets = wb ? byTag(wb, 'sheet') : [];
  const out: RawSheet[] = [];
  for (const s of sheets) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id');
    const doc = await xml(target(rid));
    if (!doc) continue;
    const rows = byTag(doc, 'row').map((r) => {
      const row: string[] = [];
      byTag(r, 'c').forEach((c) => {
        const i = colIndex(c.getAttribute('r'), row.length);
        while (row.length < i) row.push('');
        const t = c.getAttribute('t');
        const v = textOf(c, 'v');
        row[i] = (t === 's' ? strings[Number(v)] ?? '' : t === 'inlineStr' ? textOf(c, 't') : v).trim();
      });
      return row;
    }).filter((r) => r.some(Boolean));
    if (rows.length) out.push({ name: s.getAttribute('name') ?? `Лист ${out.length + 1}`, rows });
  }
  return out;
}
