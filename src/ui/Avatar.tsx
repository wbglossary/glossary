/**
 * Пиксельные аватары-зверята 16×16 в одном стиле (как образец-котик):
 * мордочка анфас, тёплые цвета, тёмный контур, румяные щёчки. Рисуются кодом — без картинок.
 */
type Px = [number, number, string];
type Ears = 'pointy' | 'round' | 'long' | 'floppy' | 'tufts' | 'none';

interface Animal {
  name: string; fur: string; inner?: string; muzzle?: string; ears: Ears; earColor?: string;
  extra?: (put: (x: number, y: number, c: string) => void, A: Animal) => void;
  eyes?: 'dot' | 'big' | 'top';
}

const OUT = '#4a1d2f';
const EYE = '#2a0f1d';
const HI = '#fff5e6';
const NOSE = '#e8607a';
const CHEEK = '#f6a99a';

export const ANIMALS: Record<string, Animal> = {
  cat: { name: 'Котик', fur: '#e69a55', inner: '#f48f9b', muzzle: '#fbe4c6', ears: 'pointy',
    extra: (p) => { [[6, 6], [7, 5], [8, 5], [9, 6], [7, 6], [8, 6]].forEach(([x, y]) => p(x, y, '#8a3d22')); } },
  dog: { name: 'Собачка', fur: '#c98d5a', muzzle: '#f3dcc0', ears: 'floppy', earColor: '#7a4a2a' },
  fox: { name: 'Лисичка', fur: '#ee7a32', inner: '#fbe4c6', muzzle: '#fff3e2', ears: 'pointy' },
  panda: { name: 'Панда', fur: '#f7f4ef', ears: 'round', earColor: '#2b2b2b', inner: '#2b2b2b',
    extra: (p) => { for (let y = 8; y <= 11; y++) for (let x = 3; x <= 6; x++) { p(x, y, '#2b2b2b'); p(15 - x, y, '#2b2b2b'); } } },
  bunny: { name: 'Зайчик', fur: '#ece6f2', inner: '#f6a5c0', muzzle: '#ffffff', ears: 'long' },
  raccoon: { name: 'Енот', fur: '#9d9aa3', ears: 'round', inner: '#4b4852', muzzle: '#ecebef',
    extra: (p) => { for (let x = 2; x <= 13; x++) for (let y = 8; y <= 10; y++) p(x, y, '#3e3b45'); } },
  owl: { name: 'Сова', fur: '#a87a52', muzzle: '#e9d3b0', ears: 'tufts', eyes: 'big',
    extra: (p) => { p(7, 11, '#f0a030'); p(8, 11, '#f0a030'); p(7, 12, '#d8851a'); p(8, 12, '#d8851a'); } },
  frog: { name: 'Лягушонок', fur: '#7cc56a', muzzle: '#bfe6a6', ears: 'none', eyes: 'top' },
  hamster: { name: 'Хомяк', fur: '#f0b878', inner: '#f48f9b', muzzle: '#fff1dc', ears: 'round',
    extra: (p) => { [[2, 11], [2, 12], [3, 12], [13, 11], [13, 12], [12, 12]].forEach(([x, y]) => p(x, y, CHEEK)); } },
  penguin: { name: 'Пингвин', fur: '#3a3f55', ears: 'none',
    extra: (p) => {
      for (let y = 7; y <= 14; y++) for (let x = 3; x <= 12; x++) if (((x - 7.5) / 4.8) ** 2 + ((y - 10.8) / 3.6) ** 2 <= 1) p(x, y, '#fbf7f0');
      p(7, 11, '#f0a030'); p(8, 11, '#f0a030');
    } },
  bear: { name: 'Медвежонок', fur: '#9c6640', inner: '#d9a37a', muzzle: '#e8c7a2', ears: 'round' },
  corgi: { name: 'Корги', fur: '#f09a45', inner: '#fbe4c6', muzzle: '#fff7ec', ears: 'pointy',
    extra: (p) => { for (let y = 5; y <= 9; y++) { p(7, y, '#fff7ec'); p(8, y, '#fff7ec'); } } },
  hedgehog: { name: 'Ёжик', fur: '#8a6a52', muzzle: '#f2dcc0', ears: 'none',
    extra: (p) => { [[2, 4], [4, 3], [6, 2], [8, 2], [10, 3], [12, 4], [1, 6], [14, 6], [3, 4], [5, 3], [9, 2], [11, 3], [7, 2], [13, 5], [2, 5]].forEach(([x, y]) => p(x, y, '#5e4636')); } },
  capybara: { name: 'Капибара', fur: '#b0794e', inner: '#7e5232', muzzle: '#c99268', ears: 'round',
    extra: (p) => { for (let x = 5; x <= 10; x++) p(x, 12, '#9a6640'); } },
  duckling: { name: 'Утёнок', fur: '#ffd84a', ears: 'none',
    extra: (p) => { for (let x = 6; x <= 9; x++) { p(x, 11, '#f39a2a'); p(x, 12, '#e07f16'); } p(7, 3, '#ffd84a'); p(8, 3, '#ffd84a'); p(8, 2, '#ffd84a'); } },
  tiger: { name: 'Тигрёнок', fur: '#f4a23c', inner: '#f48f9b', muzzle: '#fff3e2', ears: 'round', earColor: '#f4a23c',
    extra: (p) => { [[7, 5], [8, 5], [7, 6], [8, 6], [4, 7], [5, 7], [10, 7], [11, 7], [2, 10], [3, 10], [12, 10], [13, 10]].forEach(([x, y]) => p(x, y, '#3a2516')); } }
};

export const AVATAR_KEYS = Object.keys(ANIMALS);

function draw(key: string): Px[] {
  const A = ANIMALS[key] ?? ANIMALS.cat;
  const g: (string | null)[][] = Array.from({ length: 16 }, () => Array(16).fill(null));
  const put = (x: number, y: number, c: string) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y][x] = c; };
  const ear = A.earColor ?? A.fur;
  // уши
  if (A.ears === 'pointy') {
    const L: [number, number][] = [[3, 2], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4], [5, 4], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5]];
    L.forEach(([x, y]) => { put(x, y, ear); put(15 - x, y, ear); });
    [[3, 4], [3, 5], [4, 5]].forEach(([x, y]) => { put(x, y, A.inner ?? ear); put(15 - x, y, A.inner ?? ear); });
  } else if (A.ears === 'round') {
    for (let y = 2; y <= 6; y++) for (let x = 1; x <= 6; x++) if (((x - 3.5) / 2.3) ** 2 + ((y - 4.3) / 2.1) ** 2 <= 1) { put(x, y, ear); put(15 - x, y, ear); }
    [[3, 4], [4, 4], [3, 5]].forEach(([x, y]) => { put(x, y, A.inner ?? ear); put(15 - x, y, A.inner ?? ear); });
  } else if (A.ears === 'long') {
    for (let y = 0; y <= 5; y++) { put(4, y, ear); put(5, y, ear); put(10, y, ear); put(11, y, ear); }
    for (let y = 1; y <= 4; y++) { put(5, y, A.inner ?? ear); put(10, y, A.inner ?? ear); }
  } else if (A.ears === 'tufts') {
    [[3, 3], [3, 4], [4, 4], [12, 3], [12, 4], [11, 4]].forEach(([x, y]) => put(x, y, ear));
  }
  // голова
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (((x - 7.5) / 6.3) ** 2 + ((y - 9.6) / 5.3) ** 2 <= 1) put(x, y, A.fur);
  }
  if (A.ears === 'floppy') {
    for (let y = 5; y <= 10; y++) { put(1, y, ear); put(2, y, ear); put(13, y, ear); put(14, y, ear); }
    put(0, 7, ear); put(0, 8, ear); put(15, 7, ear); put(15, 8, ear);
  }
  // мордочка
  if (A.muzzle) for (let y = 9; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (((x - 7.5) / 3.8) ** 2 + ((y - 12) / 2.2) ** 2 <= 1 && g[y][x]) put(x, y, A.muzzle);
  }
  A.extra?.(put, A);
  // глаза
  if (A.eyes === 'big') {
    for (const cx of [5, 10]) for (let y = 7; y <= 11; y++) for (let x = cx - 2; x <= cx + 2; x++) if (((x - cx) / 2.2) ** 2 + ((y - 9) / 2.2) ** 2 <= 1) put(x, y, '#fdf6e6');
    [[4, 9], [5, 9], [10, 9], [11, 9], [4, 10], [5, 10], [10, 10], [11, 10]].forEach(([x, y]) => put(x, y, EYE));
    put(4, 9, HI); put(10, 9, HI);
  } else if (A.eyes === 'top') {
    for (const cx of [4, 11]) for (let y = 2; y <= 7; y++) for (let x = cx - 2; x <= cx + 2; x++) if (((x - cx) / 2.3) ** 2 + ((y - 4.6) / 2.3) ** 2 <= 1) put(x, y, A.fur);
    for (const cx of [4, 11]) { put(cx, 4, '#fdf6e6'); put(cx, 5, EYE); put(cx - 1, 4, '#fdf6e6'); put(cx - 1, 5, EYE); put(cx - 1, 4, HI); }
    [[5, 11], [10, 11]].forEach(([x, y]) => put(x, y, EYE));
    for (let x = 6; x <= 9; x++) put(x, 12, EYE);
  } else {
    [[4, 9], [5, 9], [4, 10], [5, 10], [10, 9], [11, 9], [10, 10], [11, 10]].forEach(([x, y]) => put(x, y, EYE));
    put(4, 9, HI); put(10, 9, HI);
  }
  if (A.eyes !== 'top' && key !== 'owl' && key !== 'penguin' && key !== 'duckling') {
    put(7, 11, NOSE); put(8, 11, NOSE);
    put(6, 12, EYE); put(9, 12, EYE); put(7, 13, EYE); put(8, 13, EYE);
  }
  if (key !== 'hamster') { put(3, 11, CHEEK); put(12, 11, CHEEK); }
  // контур
  const px: Px[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (g[y][x]) { px.push([x, y, g[y][x]!]); continue; }
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx]);
    if (n) px.push([x, y, OUT]);
  }
  return px;
}

const cache = new Map<string, Px[]>();

export function Avatar({ name, size = 32, title }: { name: string | null | undefined; size?: number; title?: string }) {
  const key = name && ANIMALS[name] ? name : 'cat';
  if (!cache.has(key)) cache.set(key, draw(key));
  const px = cache.get(key)!;
  return (
    <svg width={size} height={size} viewBox="-1 -1 18 18" shapeRendering="crispEdges" className="avatar" role="img"
      aria-label={title ?? ANIMALS[key].name}>
      <title>{title ?? ANIMALS[key].name}</title>
      {px.map(([x, y, c], i) => <rect key={i} x={x} y={y} width={1.02} height={1.02} fill={c} />)}
    </svg>
  );
}
