'use strict';

const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const { parseFeed } = require('./lib/rss');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const OUTAGES_URL =
  'https://raw.githubusercontent.com/chaichuk/UA-power-outages-monitor/main/artifacts/last-message.json';
const ALERTS_URL = 'https://alerts.in.ua/llm';
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';

const NEWS_SOURCES = [
  { id: 'pravda', name: 'Українська правда', url: 'https://www.pravda.com.ua/rss/' },
  { id: 'ukrinform', name: 'Укрінформ', url: 'https://www.ukrinform.ua/rss/block-lastnews' },
  { id: 'tsn', name: 'ТСН', url: 'https://tsn.ua/rss' },
  { id: 'unian', name: 'УНІАН', url: 'https://rss.unian.net/site/news_ukr.rss' },
  { id: 'epravda', name: 'Економічна правда', url: 'https://www.epravda.com.ua/rss/' },
  { id: 'nv', name: 'NV', url: 'https://nv.ua/rss/all.xml' },
];

const CURRENCIES = ['USD', 'EUR', 'PLN', 'GBP', 'CHF', 'CNY', 'JPY', 'TRY'];

/* ------------------------------------------------------------------ */
/*  Кеш і мережа                                                       */
/* ------------------------------------------------------------------ */

const cache = new Map();

async function cached(key, ttl, loader) {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && now - entry.ts < ttl) return entry.data;

  try {
    const data = await loader();
    cache.set(key, { ts: now, data });
    return data;
  } catch (error) {
    if (entry) return entry.data; // віддаємо застарілі дані, якщо джерело впало
    throw error;
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'UA-Tracker/1.0 (local dashboard; educational project)',
        accept: '*/*',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeout) {
  const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, timeout);
  if (!response.ok) throw new Error(`HTTP ${response.status} для ${url}`);
  return response.json();
}

async function fetchText(url, timeout) {
  const response = await fetchWithTimeout(url, {}, timeout);
  if (!response.ok) throw new Error(`HTTP ${response.status} для ${url}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder('utf-8').decode(buffer);
}

/* ------------------------------------------------------------------ */
/*  Погода (Open-Meteo — безкоштовно, без ключа)                       */
/* ------------------------------------------------------------------ */

async function getWeather(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw Object.assign(new Error('Некоректні координати'), { status: 400 });
  }

  return cached(`weather:${latitude.toFixed(2)}:${longitude.toFixed(2)}`, 10 * 60 * 1000, async () => {
    const forecastUrl =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${latitude}&longitude=${longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
      '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max,wind_speed_10m_max' +
      '&timezone=Europe%2FKyiv&forecast_days=7';

    const airUrl =
      'https://air-quality-api.open-meteo.com/v1/air-quality' +
      `?latitude=${latitude}&longitude=${longitude}` +
      '&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,uv_index' +
      '&timezone=Europe%2FKyiv';

    const [forecast, air] = await Promise.allSettled([
      fetchJson(forecastUrl, 15000),
      fetchJson(airUrl, 15000),
    ]);

    if (forecast.status !== 'fulfilled') throw forecast.reason;

    return {
      forecast: forecast.value,
      air: air.status === 'fulfilled' ? air.value : null,
      updatedAt: new Date().toISOString(),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Повітряні тривоги (alerts.in.ua SITREP — без ключа, live-дані)     */
/* ------------------------------------------------------------------ */

const UA_REGIONS = [
  { name: 'Вінницька область', nameEn: 'Vinnytska oblast' },
  { name: 'Волинська область', nameEn: 'Volynska oblast' },
  { name: 'Дніпропетровська область', nameEn: 'Dnipropetrovska oblast' },
  { name: 'Донецька область', nameEn: 'Donetska oblast' },
  { name: 'Житомирська область', nameEn: 'Zhytomyrska oblast' },
  { name: 'Закарпатська область', nameEn: 'Zakarpatska oblast' },
  { name: 'Запорізька область', nameEn: 'Zaporizka oblast' },
  { name: 'Івано-Франківська область', nameEn: 'Ivano-Frankivska oblast' },
  { name: 'Київська область', nameEn: 'Kyivska oblast' },
  { name: 'Кіровоградська область', nameEn: 'Kirovohradska oblast' },
  { name: 'Луганська область', nameEn: 'Luhanska oblast' },
  { name: 'Львівська область', nameEn: 'Lvivska oblast' },
  { name: 'Миколаївська область', nameEn: 'Mykolaivska oblast' },
  { name: 'Одеська область', nameEn: 'Odeska oblast' },
  { name: 'Полтавська область', nameEn: 'Poltavska oblast' },
  { name: 'Рівненська область', nameEn: 'Rivnenska oblast' },
  { name: 'Сумська область', nameEn: 'Sumska oblast' },
  { name: 'Тернопільська область', nameEn: 'Ternopilska oblast' },
  { name: 'Харківська область', nameEn: 'Kharkivska oblast' },
  { name: 'Херсонська область', nameEn: 'Khersonska oblast' },
  { name: 'Хмельницька область', nameEn: 'Khmelnytska oblast' },
  { name: 'Черкаська область', nameEn: 'Cherkaska oblast' },
  { name: 'Чернівецька область', nameEn: 'Chernivetska oblast' },
  { name: 'Чернігівська область', nameEn: 'Chernihivska oblast' },
  { name: 'м. Київ', nameEn: 'Kyiv city' },
  { name: 'Автономна Республіка Крим', nameEn: 'Autonomous Republic of Crimea' },
];

const ALERT_MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function normalizeRegionKey(value) {
  return String(value || '')
    .replace(/[’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const REGION_ALIASES = {
  'київ': 'м. київ',
  'київ city': 'м. київ',
  'kyiv': 'м. київ',
  'крим': 'автономна республіка крим',
};

function resolveRegion(name) {
  const key = normalizeRegionKey(name);
  const alias = REGION_ALIASES[key] || key;
  return UA_REGIONS.find((region) => normalizeRegionKey(region.name) === alias) || null;
}

function parseSitrepTime(token, baseIso) {
  const base = new Date(baseIso || Date.now());
  const offset = (String(baseIso || '').match(/[+-]\d{2}:\d{2}$/) || ['+02:00'])[0];
  const withDate = String(token).match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{2}):(\d{2})/);

  let year;
  let monthIndex;
  let day;
  let hour;
  let minute;
  let explicitDate = false;

  if (withDate) {
    explicitDate = true;
    year = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric' }).format(base),
    );
    monthIndex = ALERT_MONTHS[withDate[1]];
    day = Number(withDate[2]);
    hour = Number(withDate[3]);
    minute = Number(withDate[4]);
    if (monthIndex === undefined) return null;
  } else {
    const timeOnly = String(token).match(/(\d{2}):(\d{2})/);
    if (!timeOnly) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(base);
    const [y, m, d] = parts.split('-').map(Number);
    year = y;
    monthIndex = m - 1;
    day = d;
    hour = Number(timeOnly[1]);
    minute = Number(timeOnly[2]);
  }

  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
  let date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  // Час без дати, що "в майбутньому" — насправді вчорашній.
  if (!explicitDate && date.getTime() > base.getTime() + 5 * 60 * 1000) {
    date = new Date(date.getTime() - 86400000);
  }

  return date.toISOString();
}

function parseSitrep(markdown) {
  const text = String(markdown || '').replace(/\r/g, '');

  const localTime = text.match(/LOCAL TIME[^\n]*\(Europe\/Kyiv,\s*([0-9T:+\-]+)\)/);
  const lastUpdate = localTime ? new Date(localTime[1]).toISOString() : new Date().toISOString();

  const sectionRaw = text.split(/^##\s*3\.[^\n]*$/m)[1];
  if (!sectionRaw) throw new Error('Не вдалося розпізнати формат SITREP alerts.in.ua');
  const section = sectionRaw.split(/^##\s+\d+\./m)[0] || '';
  const states = new Map(
    UA_REGIONS.map((region) => [
      normalizeRegionKey(region.name),
      {
        id: normalizeRegionKey(region.name).replace(/[^a-zа-яіїєґ0-9]+/gi, '-'),
        name: region.name,
        nameEn: region.nameEn,
        alert: false,
        nominal: false,
        level: null,
        changed: null,
        areas: 0,
        ongoing: '',
        note: '',
      },
    ]),
  );

  const entries = [
    ...section.matchAll(/\*\*([^*\n]+)\*\*\s*—\s*([\s\S]*?)(?=\n\s*\n\*\*|\n\s*$)/g),
  ];

  for (const [, label, body] of entries) {
    const ukr = label.match(/\(([^()]+)\)\s*$/)?.[1] || label;
    const region = resolveRegion(ukr);
    if (!region) continue; // російські регіони та окуповані номінальні — окремо

    const state = states.get(normalizeRegionKey(region.name));
    if (!state) continue;

    const redCount = (body.match(/\bred\s*\((?:[^()]|\([^()]*\))*\)/gi) || []).length;
    const yellowCount = (body.match(/\byellow\s*\((?:[^()]|\([^()]*\))*\)/gi) || []).length;
    const levelWord = body.match(/Alert level:\s*(red|yellow)/i)?.[1]?.toLowerCase();

    state.alert = true;
    state.level = redCount || levelWord === 'red' ? 'red' : yellowCount || levelWord === 'yellow' ? 'yellow' : 'red';
    state.areas = Number(body.match(/(\d+)\s+areas? affected/i)?.[1] || 1);
    state.ongoing = (body.match(/ongoing for ([^.\n]+)/i)?.[1] || '').trim();
    state.note = body.match(/artillery shelling threat/i)
      ? 'Загроза артилерійського обстрілу та повітряна тривога'
      : state.level === 'red'
        ? 'Червоний рівень — ракетна загроза / масований удар'
        : 'Жовтий рівень — загроза дронів';

    const since = body.match(/\bsince\s+((?:[A-Z][a-z]{2}\s+\d{1,2},\s*)?\d{2}:\d{2})/);
    if (since) state.changed = parseSitrepTime(since[1], lastUpdate);
  }

  // Номінальні тривоги на окупованій території: показуємо, але не рахуємо.
  const nominalBlock = text.match(/Nominal alerts in occupied territory[^\n]*/i)?.[0] || '';
  for (const match of nominalBlock.matchAll(/\(([^()]+)\)/g)) {
    const region = resolveRegion(match[1]);
    if (!region) continue;
    const state = states.get(normalizeRegionKey(region.name));
    if (!state) continue;
    state.alert = true;
    state.nominal = true;
    state.level = 'red';
    state.areas = state.areas || 1;
    state.note = 'Номінальна тривога на окупованій території — не відображає поточної загрози';
  }

  const list = [...states.values()];
  const live = list.filter((state) => state.alert && !state.nominal);
  const red = live.filter((state) => state.level === 'red').length;
  const yellow = live.filter((state) => state.level === 'yellow').length;

  return {
    states: list,
    activeCount: live.length,
    redCount: red,
    yellowCount: yellow,
    areas: live.reduce((sum, state) => sum + (state.areas || 1), 0),
    nominalCount: list.filter((state) => state.nominal).length,
    total: list.length,
    lastUpdate,
    updatedAt: new Date().toISOString(),
    source: 'alerts.in.ua',
    sourceUrl: 'https://alerts.in.ua/',
    levels: { red, yellow },
  };
}

async function getAlerts() {
  return cached('alerts', 45 * 1000, async () => {
    const markdown = await fetchText(ALERTS_URL, 15000);
    const data = parseSitrep(markdown);
    if (!data.activeCount && !data.states.length) throw new Error('Порожній SITREP alerts.in.ua');
    return data;
  });
}

/* ------------------------------------------------------------------ */
/*  Графіки відключень (агрегатор svitlo-format, оновлюється ~15 хв)   */
/* ------------------------------------------------------------------ */

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeRegion(region) {
  const schedule = region.schedule && typeof region.schedule === 'object' ? region.schedule : {};
  const queues = Object.keys(schedule)
    .sort(naturalCompare)
    .map((queue) => ({
      id: queue,
      label: queue.includes('.') ? `Черга ${queue}` : `Черга ${queue}`,
      days: schedule[queue],
    }));

  const dates = [
    ...new Set(queues.flatMap((queue) => Object.keys(queue.days || {}))),
  ].sort();

  return {
    id: region.cpu,
    name: region.name_ua || region.name_en || region.cpu,
    emergency: Boolean(region.emergency),
    queues,
    dates,
  };
}

function demoOutages() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const iso = (date) => date.toISOString().slice(0, 10);
  const queueKeys = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2'];

  const buildDay = (seed) => {
    const slots = {};
    for (let i = 0; i < 48; i += 1) {
      const hour = String(Math.floor(i / 2)).padStart(2, '0');
      const minute = i % 2 === 0 ? '00' : '30';
      const block = Math.floor(i / 6);
      const off = (block + seed) % 4 === 1;
      slots[`${hour}:${minute}`] = off ? 2 : 1;
    }
    return slots;
  };

  const queues = queueKeys.map((queue, index) => ({
    id: queue,
    label: `Черга ${queue}`,
    days: {
      [iso(today)]: buildDay(index),
      [iso(tomorrow)]: buildDay(index + 1),
    },
  }));

  return {
    id: 'demo',
    name: 'Демонстраційна область',
    emergency: false,
    queues,
  };
}

async function getOutages(regionId) {
  let data;
  let demo = false;

  try {
    data = await cached('outages', 5 * 60 * 1000, async () => {
      const payload = await fetchJson(OUTAGES_URL, 20000);
      const regions = (Array.isArray(payload.regions) ? payload.regions : [])
        .map(normalizeRegion)
        .filter((region) => region.id && region.queues.length);

      return {
        regions,
        dateToday: payload.date_today || new Date().toISOString().slice(0, 10),
        dateTomorrow:
          payload.date_tomorrow || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        updatedAt: new Date().toISOString(),
        source: 'UA-power-outages-monitor (svitlo format)',
        demo: false,
      };
    });
  } catch {
    const demoRegion = demoOutages();
    const today = new Date();
    data = {
      regions: [demoRegion],
      dateToday: today.toISOString().slice(0, 10),
      dateTomorrow: new Date(today.getTime() + 86400000).toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
      source: 'демонстраційні дані',
      demo: true,
    };
    demo = true;
  }

  const selected =
    data.regions.find((region) => region.id === regionId) ||
    data.regions.find((region) => region.id === 'kyiv') ||
    data.regions[0] ||
    demoOutages();

  return {
    region: selected,
    regions: data.regions.map((region) => ({ id: region.id, name: region.name })),
    dateToday: data.dateToday,
    dateTomorrow: data.dateTomorrow,
    updatedAt: data.updatedAt,
    source: data.source,
    demo: demo || Boolean(data.demo),
    demoNote:
      'Джерело графіків тимчасово недоступне — показано демонстраційні дані. Не використовуйте їх для планування.',
  };
}

/* ------------------------------------------------------------------ */
/*  Новини (RSS)                                                       */
/* ------------------------------------------------------------------ */

async function getNews() {
  return cached('news', 4 * 60 * 1000, async () => {
    const results = await Promise.allSettled(
      NEWS_SOURCES.map(async (source) => {
        const xml = await fetchText(source.url, 15000);
        return parseFeed(xml, source);
      }),
    );

    const failed = [];
    const items = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        items.push(...result.value.slice(0, 12));
      } else {
        failed.push(NEWS_SOURCES[index].id);
      }
    });

    const seen = new Set();
    const unique = items
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .filter((item) => {
        const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 70);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 45);

    if (!unique.length) throw new Error('Не вдалося завантажити жодної новини');

    return {
      items: unique,
      sources: NEWS_SOURCES.map(({ id, name }) => ({ id, name })),
      failed,
      updatedAt: new Date().toISOString(),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Курс валют (НБУ — безкоштовно, без ключа)                          */
/* ------------------------------------------------------------------ */

async function getCurrency() {
  return cached('currency', 60 * 60 * 1000, async () => {
    const rows = await fetchJson(NBU_URL, 15000);
    const list = Array.isArray(rows) ? rows : [];

    const rates = CURRENCIES.map((code) => {
      const row = list.find((item) => item.cc === code);
      return row
        ? { code: row.cc, name: row.txt, rate: row.rate, date: row.exchangedate }
        : null;
    }).filter(Boolean);

    if (!rates.length) throw new Error('НБУ не повернув курс валют');

    return {
      base: 'UAH',
      rates,
      updatedAt: new Date().toISOString(),
      source: 'Національний банк України',
    };
  });
}

/* ------------------------------------------------------------------ */
/*  HTTP-сервер                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: 'Заборонено' });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');

    const ext = path.extname(filePath).toLowerCase();
    const body = await fsp.readFile(filePath);

    response.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'content-length': body.length,
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('404 — файл не знайдено');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, uptime: process.uptime(), now: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/api/weather') {
      const data = await getWeather(url.searchParams.get('lat'), url.searchParams.get('lon'));
      sendJson(response, 200, data);
      return;
    }

    if (url.pathname === '/api/alerts') {
      sendJson(response, 200, await getAlerts());
      return;
    }

    if (url.pathname === '/api/outages') {
      sendJson(response, 200, await getOutages(url.searchParams.get('region') || 'kyiv'));
      return;
    }

    if (url.pathname === '/api/news') {
      sendJson(response, 200, await getNews());
      return;
    }

    if (url.pathname === '/api/currency') {
      sendJson(response, 200, await getCurrency());
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Невідомий метод API' });
      return;
    }

    await serveStatic(request, response, url.pathname);
  } catch (error) {
    const status = error.status || 502;
    console.error(`[${new Date().toISOString()}] ${url.pathname}:`, error.message);
    sendJson(response, status, {
      error: error.status === 400 ? error.message : 'Джерело даних тимчасово недоступне',
      detail: error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🇺🇦  UA Tracker запущено');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Погода      · Open-Meteo');
  console.log('  Тривоги     · alerts.in.ua (live SITREP)');
  console.log('  Відключення · UA-power-outages-monitor');
  console.log('  Новини      · RSS (УП, Укрінформ, ТСН, УНІАН, ЕП, NV)');
  console.log('  Валюти      · НБУ');
  console.log('');
  console.log('  Ctrl+C — зупинити сервер');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nСервер зупинено.');
  process.exit(0);
});
