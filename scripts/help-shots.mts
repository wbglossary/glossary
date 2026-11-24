/**
 * Картинки для «Инструкции»: снимки экранов тестовой копии с подсвеченными кнопками.
 * Нужно запустить: npx tsx scripts/dev-mock.ts  и  vite на :3002 с подменой (см. .claude/launch.json → admin-mock-3002).
 * Затем: npx tsx scripts/help-shots.mts  → картинки в public/help/*.png
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'http://localhost:3002/';
const MOCK = 'http://localhost:54321';
const OUT = fileURLToPath(new URL('../public/help/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = join(tmpdir(), 'help-shots-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--window-size=1320,860',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- подготовка данных в тестовой копии ----------
async function rpcAs(who: string, fn: string, args: object) {
  const s = await (await fetch(`${MOCK}/dev/session?as=${who}`)).json();
  const r = await fetch(`${MOCK}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  return r.json();
}
await rpcAs('man', 'submit_request', { p_input: { type: 'new', ru: 'Оплата частями', definition: 'Покупатель платит за заказ не сразу, а несколькими платежами.', target_langs: ['EN', 'KA'] } });
await rpcAs('ka', 'submit_request', { p_input: { type: 'new', ru: 'Кешбэк', lang: 'KA', translation: 'ქეშბექი', definition: 'Часть денег за покупку, которая возвращается покупателю.' } });

// демо-таблица для снимка «Загрузка переводов» (заранее: Vite не сразу видит новые файлы в public)
writeFileSync(new URL('../public/_help-demo.xlsx', import.meta.url), Buffer.from(await (async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Подрядчик');
    ws.addRow(['Русский термин', 'Определение', 'Амхарский']);
    ws.addRow(['Корзина', '', 'ቅርጫት']); ws.addRow(['Скидка', '', 'ቅናሽ']); ws.addRow(['Доставка', '', 'ማድረስ']); ws.addRow(['Возврат', '', 'መመለስ']);
    return wb.xlsx.writeBuffer();
  })()));

// ---------- Chrome ----------
let ws!: WebSocket;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const page = list.find((x: { type: string }) => x.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* ещё запускается */ }
  await sleep(250);
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
const send = (method: string, params: object = {}) => new Promise<any>((ok) => { const id = ++seq; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr: string) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'js error');
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: 2, mobile: false });

const go = async (hash: string, as?: string) => {
  if (as) { await send('Page.navigate', { url: `${APP}?as=${as}#/home` }); await sleep(3500); }
  await send('Page.navigate', { url: `${APP}#/${hash}` });
  await sleep(1800);
  await js(`document.querySelectorAll('.hs-badge').forEach((e) => e.remove()); document.querySelectorAll('.hs-mark').forEach((e) => e.classList.remove('hs-mark')); window.scrollTo(0, 0);`);
  await js(`document.documentElement.dataset.theme = 'light'`);   // картинки всегда в светлой теме
  await js(`if (!document.getElementById('hs-css')) { const s = document.createElement('style'); s.id = 'hs-css'; s.textContent = \`
    .hs-mark { outline: 3px solid #ff3d7f !important; outline-offset: 3px; border-radius: 10px; position: relative; }
    .hs-badge { position: absolute; z-index: 9999; width: 28px; height: 28px; border-radius: 50%; background: #ff3d7f; color: #fff;
      font: 700 16px/28px Onest, sans-serif; text-align: center; box-shadow: 0 2px 6px rgba(0,0,0,.25); pointer-events: none; }
    .fb-fab { display: none !important; } \`; document.head.appendChild(s); }`);
};
const waitFor = async (sel: string) => { for (let i = 0; i < 40; i++) { if (await js(`return !!document.querySelector(${JSON.stringify(sel)})`)) return; await sleep(150); } throw new Error('нет ' + sel); };
/** Подсветить элементы и поставить номера 1, 2, 3… Элемент — CSS-селектор или «текст:…» (кнопка/ссылка с таким текстом). */
const mark = (targets: string[]) => js(`
  const find = (t) => t.startsWith('text:') ? [...document.querySelectorAll('button,a,label,th,span.badge')].find((e) => e.textContent.trim().startsWith(t.slice(5))) : document.querySelector(t);
  ${JSON.stringify(targets)}.forEach((t, i) => {
    const el = find(t); if (!el) throw new Error('нет элемента ' + t);
    el.classList.add('hs-mark');
    const r = el.getBoundingClientRect(); const b = document.createElement('div'); b.className = 'hs-badge'; b.textContent = i + 1;
    b.style.left = (r.left + scrollX - 16) + 'px'; b.style.top = (r.top + scrollY - 16) + 'px'; document.body.appendChild(b);
  });`);
const click = (t: string) => js(`
  const el = ${JSON.stringify(t)}.startsWith('text:') ? [...document.querySelectorAll('button,a,td,b')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(t)}.slice(5))) : document.querySelector(${JSON.stringify(t)});
  if (!el) throw new Error('нет ' + ${JSON.stringify(t)}); el.click();`);
const type = (sel: string, text: string) => js(`
  const el = document.querySelector(${JSON.stringify(sel)}); el.focus();
  const set = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true }));`);
/** Снимок области: селектор (с запасом pad) или прямоугольник {x,y,w,h} */
async function shot(name: string, area: string | { x: number; y: number; w: number; h: number }, pad = 14, maxH = 760) {
  const r = typeof area === 'string'
    ? await js(`const e = document.querySelector(${JSON.stringify(area)}); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };`)
    : area;
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: Math.min(r.h + pad * 2, maxH), scale: 1 };
  const res = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(res.result.data, 'base64'));
  console.log('✓', name);
}

try {
  // 1. Меню
  await go('home', 'en');
  await mark(['text:Глоссарий', 'text:Рабочая область', 'text:Инструкция']);
  await shot('menu', '.side', 10);

  // 1б. Тема
  await mark(['.theme-btn']);
  await shot('theme', '.who', 16);

  // 2. Поиск
  await go('glossary');
  await type('input.search', 'скид');
  await sleep(1200);
  await mark(['.searchbox', '.grid tbody tr td:nth-child(2)']);
  await shot('search', { x: 250, y: 0, w: 1050, h: 330 }, 0);

  // 3. Карточка термина
  await type('input.search', 'корзина'); await sleep(1200);
  await click('.grid tbody tr'); await waitFor('.drawer'); await sleep(900);
  await mark(['.drawer .copy', 'text:Заменить', 'text:Комментарии']);
  await shot('card', '.drawer', 0, 820);

  // 3б. Комментарий лингвиста
  await click('text:Комментарий лингвиста и'); await sleep(700);
  await mark(['.drawer .card textarea', '.drawer .card .btn.primary']);
  const fr = await js(`const c = document.querySelector('.drawer .card').getBoundingClientRect(); return { x: c.left + scrollX, y: c.top + scrollY, w: c.width, h: c.height };`);
  await shot('lang-comment', fr, 18);

  // 4. Столбцы
  await go('home'); await go('glossary');
  await click('text:Столбцы'); await waitFor('.colpick'); await sleep(400);
  await mark(['text:Скрыть настройку', '.colpick']);
  await shot('columns', { x: 250, y: 60, w: 1050, h: 380 }, 0);

  // 4б. Инструменты глоссария: скрыть «не актуально», скачать, все сразу
  await go('home'); await go('glossary');
  await mark(['text:⬇ Скачать', '.toolbar label.small']);
  await shot('glossary-tools', { x: 250, y: 60, w: 1050, h: 200 }, 0);
  await js(`document.querySelectorAll('.hs-badge').forEach((e) => e.remove()); document.querySelectorAll('.hs-mark').forEach((e) => e.classList.remove('hs-mark'));`);
  await js(`document.querySelector('.pager').scrollIntoView({ block: 'center' })`); await sleep(300);
  await mark(['.pager-size']);
  const pg = await js(`const b = document.querySelector('.pager').getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: Math.min(b.width, 700), h: b.height };`);
  await shot('pager', pg, 16);

  // 5. Переводчик: вписать перевод
  await go('work?tab=mine&status=need', 'en');
  await click('text:Нужен перевод'); await sleep(1200);
  await type('textarea.cell-input', 'Favorites'); await sleep(2600);
  await mark(['text:Нужен перевод', 'textarea.cell-input']);
  await shot('work-type', { x: 250, y: 60, w: 1050, h: 420 }, 0);

  // 6. Новое из других языков
  await go('work?tab=new', 'ka');
  await click('text:Новое из других языков'); await sleep(1200);
  await mark(['text:Новое из других языков']);
  await shot('work-new', { x: 250, y: 60, w: 1050, h: 360 }, 0);

  // 7. Валидатор: согласовать / не актуально
  await go('work?tab=mine&status=draft', 'ven');
  await click('text:Черновик'); await sleep(1200);
  await click('.grid tbody tr input[type=checkbox]'); await sleep(400);
  await mark(['.grid tbody tr input[type=checkbox]', 'text:Согласовать выбранные', 'text:Не актуально для языка (']);
  await shot('work-approve', { x: 250, y: 60, w: 1050, h: 400 }, 0);

  // 8. Заявки
  await go('work?tab=requests', 'ven');
  await click('text:Заявки и просьбы'); await sleep(1400);
  await mark(['text:Заявки и просьбы', '.grid tbody tr td input:not([type=checkbox]), .grid tbody tr td textarea', '.grid tbody tr .btn.primary']);
  await shot('requests', { x: 250, y: 60, w: 1050, h: 420 }, 0);

  // 9. Предложить термин (менеджер)
  await go('propose', 'man');
  await type('.narrow input:not([type])', 'Рассрочка'); await sleep(600);
  await mark(['.narrow input:not([type])', '.narrow .checks']);
  const pr = await js(`const a = document.querySelector('.narrow input:not([type])').closest('label').getBoundingClientRect(); const b = document.querySelector('.narrow .checks').parentElement.getBoundingClientRect();
    return { x: a.left + scrollX, y: a.top + scrollY, w: Math.max(a.width, b.width), h: b.bottom - a.top };`);
  await shot('propose', pr, 24);

  // 10. Мои заявки
  await go('my-requests');
  await mark(['.grid tbody tr td.link']);
  await shot('my-requests', { x: 250, y: 60, w: 1050, h: 240 }, 0);

  // 10б. Отозвать заявку
  await click('.grid tbody tr'); await waitFor('.drawer'); await sleep(800);
  await mark(['text:Отозвать заявку']);
  await shot('withdraw', '.drawer', 0, 620);

  // 10в. Меню менеджера
  await go('home');
  await mark(['text:Предложить термин', 'text:Выгрузка', 'text:Загрузка терминов']);
  await shot('menu-manager', '.side', 10);

  // 10г. Все заявки
  await go('my-requests');
  await click('text:Все заявки'); await sleep(1200);
  await mark(['text:Все заявки', 'text:На рассмотрении']);
  await shot('all-requests', { x: 250, y: 60, w: 1050, h: 330 }, 0);

  // 10д. «Не актуально» для языка без валидатора — сразу для нескольких терминов
  await go('home'); await go('glossary');
  await js(`const cb = document.querySelectorAll('.grid tbody input[type=checkbox]'); cb[0].click(); cb[1].click();`); await sleep(400);
  await js(`const s = document.querySelector('.bulk-unused select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, s.options[1].value); s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await sleep(300);
  await mark(['.bulk-unused select', 'text:Не актуально для языка']);
  await shot('bulk-unused', { x: 250, y: 60, w: 1050, h: 330 }, 0);

  // 11. Загрузка переводов
  await go('import');

  await js(`const b = await (await fetch('/_help-demo.xlsx')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], 'таблица подрядчика.xlsx'));
    const inp = document.querySelector('input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));`);
  await sleep(2500);
  await click('text:Проверить'); await sleep(1500);
  await mark(['.filepick label', 'text:Проверить', 'text:Загрузить']);
  await shot('import', { x: 250, y: 60, w: 1050, h: 760 }, 0, 780);

  // 11б. После загрузки: что не загрузилось — красным, с причиной
  await js(`document.querySelectorAll('.hs-badge').forEach((e) => e.remove()); document.querySelectorAll('.hs-mark').forEach((e) => e.classList.remove('hs-mark'));`);
  await click('text:Загрузить'); await sleep(2000);
  await js(`document.querySelector('.msg')?.scrollIntoView({ block: 'start' })`); await sleep(300);
  await mark(['.msg', '.row-fail-why td:nth-child(2)']);
  const ff = await js(`const a = document.querySelector('.msg').getBoundingClientRect(); const b = document.querySelector('.row-fail-why').getBoundingClientRect(); return { x: a.left + scrollX, y: a.top + scrollY, w: Math.max(a.width, b.right - a.left), h: b.bottom - a.top };`);
  await shot('import-fail', ff, 18, 900);

  // 12. Выгрузка
  await go('export');
  await mark(['text:Скачать для Smartcat']);
  await shot('export', { x: 250, y: 60, w: 1050, h: 420 }, 0);

  // 12б. Для подрядчиков
  await js(`document.querySelectorAll('.hs-badge').forEach((e) => e.remove()); document.querySelectorAll('.hs-mark').forEach((e) => e.classList.remove('hs-mark'));`);
  await js(`[...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Для подрядчиков')).scrollIntoView({ block: 'center' })`); await sleep(300);
  await mark(['text:Скачать пустые']);
  const cr = await js(`const c = [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Для подрядчиков')).parentElement.getBoundingClientRect(); return { x: c.left + scrollX, y: c.top + scrollY, w: c.width, h: c.height };`);
  await shot('export-contractor', cr, 16);

  // 13. Обратная связь
  await go('home');
  await js(`document.getElementById('hs-css').textContent = document.getElementById('hs-css').textContent.replace('.fb-fab { display: none !important; }', '')`);
  await click('.fb-fab'); await waitFor('.modal'); await sleep(500);
  await shot('feedback', '.modal', 10);

  // 13б. Главная: «Вас ждут» — свернуть, «Без перевода» одной строкой
  await go('home', 'owner');
  await mark(['text:Свернуть', '.dash-langs']);
  const dh = await js(`const a = document.querySelector('.dash-head').getBoundingClientRect(); const b = document.querySelector('.dash').getBoundingClientRect(); return { x: a.left + scrollX, y: a.top + scrollY, w: b.width, h: b.bottom - a.top };`);
  await shot('home-dash', dh, 18);

  // 14. Владелец: добавить человека
  await go('admin');
  await js(`[...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Добавить человека'))?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  const r = await js(`const h = [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Добавить человека')).parentElement.getBoundingClientRect(); return { x: h.left + scrollX, y: h.top + scrollY, w: h.width, h: h.height };`);
  await shot('admin-add', r, 16);
} catch (e) { console.error('ОШИБКА:', (e as Error).message); process.exitCode = 1; } finally {
  rmSync(new URL('../public/_help-demo.xlsx', import.meta.url), { force: true });
  ws.close(); chrome.kill(); await sleep(500); try { rmSync(profile, { recursive: true, force: true }); } catch { /* ничего */ }
}
