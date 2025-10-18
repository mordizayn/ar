import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DreamRequest = z.object({
  text: z.string().min(5, 'Metin en az 5 karakter olmalıdır'),
  seed: z.string().optional(),
  paletteSize: z.number().int().min(3).max(8).optional(),
  numShapes: z.number().int().min(3).max(32).optional(),
  width: z.number().int().min(200).max(1000).optional(),
  height: z.number().int().min(200).max(1600).optional(),
});

function hashStringToUint32(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t |= 0; // ensure 32-bit
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function generatePaletteFromText(text, count = 5) {
  const seed = hashStringToUint32(text);
  const rand = mulberry32(seed);
  const palette = [];
  const baseHue = Math.floor(rand() * 360);
  for (let i = 0; i < count; i += 1) {
    const hue = (baseHue + Math.floor((360 / count) * i) + Math.floor(rand() * 20) - 10) % 360;
    const sat = 0.55 + rand() * 0.3; // 55% - 85%
    const light = 0.35 + rand() * 0.3; // 35% - 65%
    palette.push(hslToHex(hue, sat, light));
  }
  return { palette, seed };
}

function analyzeDreamHeuristics(text) {
  const lower = text.toLowerCase('tr');
  const hits = [];
  const rules = [
    { key: 'deniz', emotion: 'sakinlik', weight: 0.7 },
    { key: 'su', emotion: 'arınma', weight: 0.5 },
    { key: 'ateş', emotion: 'tutku', weight: 0.8 },
    { key: 'yılan', emotion: 'kaygı', weight: 0.8 },
    { key: 'uçmak', emotion: 'özgürlük', weight: 0.9 },
    { key: 'karanlık', emotion: 'belirsizlik', weight: 0.7 },
    { key: 'ışık', emotion: 'umut', weight: 0.6 },
    { key: 'yağmur', emotion: 'arınma', weight: 0.6 },
    { key: 'ev', emotion: 'güvenlik', weight: 0.5 },
    { key: 'dağ', emotion: 'güçlük', weight: 0.6 },
  ];
  for (const rule of rules) {
    if (lower.includes(rule.key)) hits.push(rule);
  }
  const emotions = hits.map((h) => ({ name: h.emotion, intensity: h.weight }));
  const summary =
    emotions.length > 0
      ? `Metin, ${emotions.map((e) => e.name).join(', ')} temalarını çağrıştırıyor.`
      : 'Metin, sakin ve soyut bir his veriyor.';
  return { emotions, summary };
}

function generateShapes(text, palette, width = 360, height = 560, numShapes = 12) {
  const seed = hashStringToUint32(text + '::shapes');
  const rand = mulberry32(seed);
  const shapes = [];
  for (let i = 0; i < numShapes; i += 1) {
    const isCircle = rand() > 0.5;
    const color = palette[Math.floor(rand() * palette.length)];
    const opacity = 0.35 + rand() * 0.5; // 0.35 - 0.85
    if (isCircle) {
      const r = 10 + rand() * Math.min(width, height) * 0.15;
      const cx = r + rand() * (width - 2 * r);
      const cy = r + rand() * (height - 2 * r);
      shapes.push({ type: 'circle', cx, cy, r, fill: color, opacity });
    } else {
      const w = 20 + rand() * (width * 0.35);
      const h = 20 + rand() * (height * 0.25);
      const x = rand() * (width - w);
      const y = rand() * (height - h);
      shapes.push({ type: 'rect', x, y, width: w, height: h, fill: color, opacity, rx: 8 });
    }
  }
  return shapes;
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', name: 'dreamviz-server' });
});

app.post('/api/generate', async (req, res) => {
  const parse = DreamRequest.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Geçersiz istek', details: parse.error.issues });
  }
  const { text, seed, paletteSize = 5, numShapes = 12, width = 360, height = 560 } = parse.data;

  const { palette } = generatePaletteFromText(text + (seed || '')); // seed karışımı
  const limitedPalette = palette.slice(0, Math.max(3, Math.min(8, paletteSize)));
  const shapes = generateShapes(text + (seed || ''), limitedPalette, width, height, numShapes);
  const { summary, emotions } = analyzeDreamHeuristics(text);

  return res.json({
    summary,
    emotions,
    palette: limitedPalette,
    shapes,
    canvas: { width, height },
    seed: seed || String(hashStringToUint32(text)),
  });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`dreamviz server listening on http://localhost:${port}`);
});
