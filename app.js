'use strict';

/* ============================================================
   UA Tracker — клієнтська логіка
   ============================================================ */

const KYIV_TZ = 'Europe/Kyiv';
const STORAGE = {
  city: 'ua-tracker:city',
  region: 'ua-tracker:region',
  queue: 'ua-tracker:queue',
};

const CITIES = Array.isArray(window.UA_CITIES) && window.UA_CITIES.length
  ? window.UA_CITIES
  : [{ id: 'kyiv', name: 'Київ', oblast: 'м. Київ', lat: 50.4501, lon: 30.5234, region: 'kyiv' }];

const CITY_BY_ID = new Map(CITIES.map((city) => [city.id, city]));

const REGION_CITY = CITIES.reduce((acc, city) => {
  if (city.region) acc[city.region] = city.id;
  return acc;
}, {});

const state = {
  city: load(STORAGE.city) || 'kyiv',
  region: load(STORAGE.region) || 'kyiv',
  queue: load(STORAGE.queue) || null,
  day: 'today',
  newsFilter: 'all',
  weather: null,
  alerts: null,
  outages: null,
  news: null,
  currency: null,
  timers: [],
};

const els = {};

/* ------------------------------------------------------------------ */
/*  Утиліти                                                            */
/* ------------------------------------------------------------------ */

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function $(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '#';
}

function getCity(id) {
  return CITY_BY_ID.get(id) || CITY_BY_ID.get('kyiv') || CITIES[0];
}

function kyivNow() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: KYIV_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [hour, minute] = time.split(':').map(Number);
  return { date, hour, minute, minutes: hour * 60 + minute };
}

function formatKyivTime(value, withSeconds = false) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: KYIV_TZ,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(date);
}

function formatKyivDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: KYIV_TZ,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(minutes) {
  if (!minutes) return '0 хв';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} хв`;
  if (!rest) return `${hours} год`;
  return `${hours} год ${rest} хв`;
}

function formatShortDate(iso) {
  const [year, month, day] = String(iso || '').split('-');
  return day && month ? `${day}.${month}` : '—';
}

function shortRegionName(name) {
  return String(name || '')
    .replace(/\s*область$/i, '')
    .replace(/^м\.\s*/i, '')
    .replace(/^Автономна Республіка\s*/i, '');
}

function slotLabel(index) {
  const hour = String(Math.floor(index / 2)).padStart(2, '0');
  return `${hour}:${index % 2 === 0 ? '00' : '30'}`;
}

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
  return data;
}

let toastTimer = null;

function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 3400);
}

function markRefresh() {
  if (els.lastRefresh) {
    els.lastRefresh.textContent = `Останнє оновлення: ${formatKyivTime(new Date(), true)}`;
  }
}

/* ------------------------------------------------------------------ */
/*  Погода                                                             */
/* ------------------------------------------------------------------ */

const WEATHER_CODES = {
  0: ['Ясно', 'sun'],
  1: ['Переважно ясно', 'partly'],
  2: ['Мінлива хмарність', 'partly'],
  3: ['Похмуро', 'cloud'],
  45: ['Туман', 'fog'],
  48: ['Паморозь', 'fog'],
  51: ['Слабка мряка', 'drizzle'],
  53: ['Мряка', 'drizzle'],
  55: ['Сильна мряка', 'drizzle'],
  56: ['Крижана мряка', 'drizzle'],
  57: ['Сильна крижана мряка', 'drizzle'],
  61: ['Невеликий дощ', 'rain'],
  63: ['Дощ', 'rain'],
  65: ['Сильний дощ', 'rain'],
  66: ['Крижаний дощ', 'rain'],
  67: ['Сильний крижаний дощ', 'rain'],
  71: ['Невеликий сніг', 'snow'],
  73: ['Сніг', 'snow'],
  75: ['Сильний сніг', 'snow'],
  77: ['Снігові зерна', 'snow'],
  80: ['Невеликі зливи', 'rain'],
  81: ['Зливи', 'rain'],
  82: ['Сильні зливи', 'rain'],
  85: ['Снігові зливи', 'snow'],
  86: ['Сильні снігові зливи', 'snow'],
  95: ['Гроза', 'thunder'],
  96: ['Гроза з градом', 'thunder'],
  99: ['Сильна гроза з градом', 'thunder'],
};

function weatherInfo(code, isDay = 1) {
  const [label, icon] = WEATHER_CODES[code] || ['Мінлива хмарність', 'partly'];
  if (code === 0 && !isDay) return ['Ясно', 'moon'];
  if ((code === 1 || code === 2) && !isDay) return [label, 'partly-night'];
  return [label, icon];
}

const CLOUD = `<path d="M19 47h25a10 10 0 0 0 1.6-19.9A14 14 0 0 0 18 30.2 9 9 0 0 0 19 47Z" fill="#cfe3ff" stroke="#eaf3ff" stroke-width="2" stroke-linejoin="round"/>`;

const WEATHER_ICONS = {
  sun: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="12" fill="#ffd60a"/><g stroke="#ffd60a" stroke-width="3.4" stroke-linecap="round"><path d="M32 6v7M32 51v7M6 32h7M51 32h7M13.6 13.6l5 5M45.4 45.4l5 5M13.6 50.4l5-5M45.4 18.6l5-5"/></g></svg>`,
  moon: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M42 8a24 24 0 1 0 14 41A26 26 0 0 1 42 8Z" fill="#dbe7ff"/><circle cx="22" cy="18" r="2" fill="#9fb6d9"/><circle cx="16" cy="30" r="1.4" fill="#9fb6d9"/><circle cx="27" cy="42" r="1.6" fill="#9fb6d9"/></svg>`,
  partly: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="21" cy="20" r="8.5" fill="#ffd60a"/><g stroke="#ffd60a" stroke-width="2.4" stroke-linecap="round"><path d="M21 5v4M21 30v3M6 20h4M32 20h4M10.4 9.4l2.8 2.8M28.8 27.8l2.8 2.8M10.4 30.6l2.8-2.8M28.8 12.2l2.8-2.8"/></g><path d="M23 52h25a10 10 0 0 0 1.6-19.9A14 14 0 0 0 22 35.2 9 9 0 0 0 23 52Z" fill="#cfe3ff" stroke="#eaf3ff" stroke-width="2" stroke-linejoin="round"/></svg>`,
  'partly-night': `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M31 4a13 13 0 1 0 8 22A14 14 0 0 1 31 4Z" fill="#dbe7ff"/><path d="M23 52h25a10 10 0 0 0 1.6-19.9A14 14 0 0 0 22 35.2 9 9 0 0 0 23 52Z" fill="#b9cbe6" stroke="#eaf3ff" stroke-width="2" stroke-linejoin="round"/></svg>`,
  cloud: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 44h30a11 11 0 0 0 1.7-21.9A15 15 0 0 0 19 25.4 10 10 0 0 0 16 44Z" fill="#cfe3ff" stroke="#eaf3ff" stroke-width="2" stroke-linejoin="round"/></svg>`,
  fog: `<svg viewBox="0 0 64 64" aria-hidden="true">${CLOUD}<g stroke="#8fb2e0" stroke-width="2.6" stroke-linecap="round"><path d="M14 53h30M20 59h28M10 47h10"/></g></svg>`,
  drizzle: `<svg viewBox="0 0 64 64" aria-hidden="true">${CLOUD}<g stroke="#78a9ff" stroke-width="2.8" stroke-linecap="round"><path d="M22 52v4M32 51v6M42 52v4"/></g></svg>`,
  rain: `<svg viewBox="0 0 64 64" aria-hidden="true">${CLOUD}<g stroke="#78a9ff" stroke-width="3" stroke-linecap="round"><path d="M20 51l-3 7M31 51l-3 7M42 51l-3 7M26 50v4M37 50v4"/></g></svg>`,
  snow: `<svg viewBox="0 0 64 64" aria-hidden="true">${CLOUD}<g stroke="#bfe0ff" stroke-width="2.4" stroke-linecap="round"><path d="M22 52v6M19 55h6M32 51v7M28.8 54.5h6.4M42 53v6M39 56h6"/></g></svg>`,
  thunder: `<svg viewBox="0 0 64 64" aria-hidden="true">${CLOUD}<path d="M33 46l-7 11h7l-4 8 12-13h-7l5-6Z" fill="#ffd60a"/><g stroke="#78a9ff" stroke-width="2.6" stroke-linecap="round"><path d="M17 55l-2 4M49 54l2 4"/></g></svg>`,
};

function renderWeather(data, city) {
  const current = data.forecast.current;
  const [label, iconKey] = weatherInfo(current.weather_code, current.is_day);
  const daily = data.forecast.daily;
  const todayMax = Math.round(daily.temperature_2m_max[0]);
  const todayMin = Math.round(daily.temperature_2m_min[0]);
  const pressure = Math.round(current.pressure_msl * 0.750062);
  const windDir = compass(current.wind_direction_10m);
  const air = data.air ? data.air.current : null;

  els.weatherNow.innerHTML = `
    <div class="weather-now__icon">${WEATHER_ICONS[iconKey] || WEATHER_ICONS.partly}</div>
    <div class="weather-now__temp">
      <strong>${Math.round(current.temperature_2m)}</strong><span>°</span>
    </div>
    <div class="weather-now__info">
      <div class="weather-now__city">${esc(city.name)}</div>
      <div class="weather-now__desc">${esc(label)} · ${todayMax > 0 ? '+' : ''}${todayMax}° / ${todayMin > 0 ? '+' : ''}${todayMin}°</div>
      <div class="weather-now__feels">Відчувається як ${Math.round(current.apparent_temperature)}° · вітер ${windDir}, ${Math.round(current.wind_speed_10m)} м/с</div>
    </div>
    <div class="weather-metrics">
      <div class="metric"><small>Вологість</small><strong>${Math.round(current.relative_humidity_2m)}%</strong></div>
      <div class="metric"><small>Вітер</small><strong>${Math.round(current.wind_speed_10m)} м/с</strong></div>
      <div class="metric"><small>Тиск</small><strong>${pressure} мм</strong></div>
      <div class="metric"><small>Опади</small><strong>${Number(current.precipitation || 0).toFixed(1)} мм</strong></div>
    </div>
  `;

  renderWeatherChart(data.forecast.hourly);
  renderForecast(daily);
  renderAir(air);
  renderSun(daily);
}

function compass(degrees) {
  const directions = ['Пн', 'Пн-Сх', 'Сх', 'Пд-Сх', 'Пд', 'Пд-Зх', 'Зх', 'Пн-Зх'];
  return directions[Math.round(Number(degrees) / 45) % 8];
}

function renderWeatherChart(hourly) {
  const now = kyivNow();
  let start = hourly.time.findIndex(
    (time) => time.slice(0, 10) === now.date && Number(time.slice(11, 13)) >= now.hour,
  );
  if (start < 0) start = 0;

  const times = hourly.time.slice(start, start + 24);
  const temps = hourly.temperature_2m.slice(start, start + 24);
  const probs = hourly.precipitation_probability.slice(start, start + 24);

  if (times.length < 2) {
    els.weatherChart.innerHTML = '<div class="chart-empty">Немає даних для графіка</div>';
    return;
  }

  const W = 720;
  const H = 182;
  const padL = 12;
  const padR = 12;
  const top = 30;
  const lineBottom = 126;
  const barBase = 163;

  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = Math.max(max - min, 4);
  const lo = min - span * 0.18;
  const hi = max + span * 0.18;
  const stepX = (W - padL - padR) / (times.length - 1);
  const x = (index) => padL + index * stepX;
  const y = (value) => top + ((hi - value) / (hi - lo)) * (lineBottom - top);

  const points = temps.map((value, index) => ({ x: x(index), y: y(value) }));
  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${lineBottom} L ${points[0].x} ${lineBottom} Z`;

  const grid = [0.25, 0.5, 0.75]
    .map((part) => {
      const gy = top + (lineBottom - top) * part;
      return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(255,255,255,.06)" stroke-dasharray="3 6"/>`;
    })
    .join('');

  const maxProb = Math.max(...probs, 1);
  const bars = probs
    .map((prob, index) => {
      if (!prob) return '';
      const height = Math.max(2, (prob / maxProb) * 25);
      return `<rect x="${x(index) - 5}" y="${barBase - height}" width="10" height="${height}" rx="2.5" fill="rgba(120,169,255,.32)"><title>${prob}% опадів о ${times[index].slice(11, 16)}</title></rect>`;
    })
    .join('');

  const dots = points
    .map((point, index) =>
      index % 4 === 0 || index === points.length - 1
        ? `<circle cx="${point.x}" cy="${point.y}" r="3.2" fill="#0a1120" stroke="#78a9ff" stroke-width="2"/>`
        : '',
    )
    .join('');

  const labels = times
    .map((time, index) => {
      if (index % 4 !== 0 && index !== times.length - 1) return '';
      const anchor = index === 0 ? 'start' : index === times.length - 1 ? 'end' : 'middle';
      return `<text x="${x(index)}" y="${H - 26}" text-anchor="${anchor}" fill="#6c7a94" font-size="10.5" font-family="Inter, sans-serif">${time.slice(11, 16)}</text>`;
    })
    .join('');

  const tempLabels = points
    .map((point, index) => {
      if (index % 4 !== 0 && index !== points.length - 1) return '';
      const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      return `<text x="${point.x}" y="${point.y - 11}" text-anchor="${anchor}" fill="#dfe8f7" font-size="11.5" font-weight="600" font-family="Inter, sans-serif">${Math.round(temps[index])}°</text>`;
    })
    .join('');

  els.weatherChart.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Температура на найближчі 24 години">
      <defs>
        <linearGradient id="tempArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(96,165,250,.35)"/>
          <stop offset="100%" stop-color="rgba(96,165,250,0)"/>
        </linearGradient>
        <linearGradient id="tempLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#60a5fa"/>
          <stop offset="60%" stop-color="#ffd60a"/>
          <stop offset="100%" stop-color="#ffb347"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaPath}" fill="url(#tempArea)"/>
      <path d="${linePath}" fill="none" stroke="url(#tempLine)" stroke-width="2.6" stroke-linecap="round"/>
      ${dots}
      ${tempLabels}
      ${bars}
      <text x="${padL}" y="${H - 8}" fill="#4f5d75" font-size="9.5" font-family="Inter, sans-serif">опади, %</text>
      ${labels}
    </svg>
  `;
}

function smoothPath(points) {
  if (!points.length) return '';
  if (points.length < 3) return `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`;

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] || points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return path;
}

function renderForecast(daily) {
  const days = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  els.forecast.innerHTML = daily.time
    .map((date, index) => {
      const [, icon] = weatherInfo(daily.weather_code[index], 1);
      const dayName = index === 0 ? 'Сьогодні' : days[new Date(`${date}T12:00:00`).getDay()];
      const max = Math.round(daily.temperature_2m_max[index]);
      const min = Math.round(daily.temperature_2m_min[index]);
      const rain = Math.round(daily.precipitation_probability_max[index] || 0);

      return `
        <div class="forecast__day ${index === 0 ? 'is-today' : ''}" title="${esc(date)}">
          <small>${dayName}</small>
          ${WEATHER_ICONS[icon] || WEATHER_ICONS.partly}
          <div class="forecast__temps"><b>${max > 0 ? '+' : ''}${max}°</b><span>${min > 0 ? '+' : ''}${min}°</span></div>
          <div class="forecast__rain">${rain}%</div>
        </div>
      `;
    })
    .join('');
}

function renderAir(air) {
  if (!air || air.european_aqi === null || air.european_aqi === undefined) {
    els.airQuality.innerHTML = '<div class="empty">Даних про якість повітря немає</div>';
    return;
  }

  const aqi = Math.round(air.european_aqi);
  const level = aqiLevel(aqi);
  const percent = Math.max(3, Math.min(100, aqi));

  els.airQuality.innerHTML = `
    <div class="air">
      <div class="aqi-ring" style="--aqi:${percent};--aqi-color:${level.color}">
        <strong>${aqi}</strong>
      </div>
      <div class="air__info">
        <b style="color:${level.color}">${level.label}</b>
        <small>PM2.5 · ${Math.round(air.pm2_5 ?? 0)} мкг/м³ · PM10 · ${Math.round(air.pm10 ?? 0)} мкг/м³${air.nitrogen_dioxide !== undefined ? `<br />NO₂ · ${Math.round(air.nitrogen_dioxide)} · O₃ · ${Math.round(air.ozone ?? 0)} мкг/м³` : ''}</small>
      </div>
    </div>
    <div class="air-extra">
      <div class="air-scale"><span class="air-scale__marker" style="left:${percent}%"></span></div>
      <p class="air-tip">${level.tip}</p>
    </div>
  `;
}

function aqiLevel(aqi) {
  if (aqi <= 20) return { label: 'Добре', color: '#37d99b', tip: 'Ідеально для прогулянки надворі.' };
  if (aqi <= 40) return { label: 'Помірно', color: '#a8e05f', tip: 'Прийнятно для більшості людей.' };
  if (aqi <= 60) return { label: 'Середньо', color: '#ffd60a', tip: 'Чутливим людям варто скоротити час на вулиці.' };
  if (aqi <= 80) return { label: 'Погано', color: '#ff9f43', tip: 'Обмежте тривалі прогулянки, особливо дітям.' };
  if (aqi <= 100) return { label: 'Дуже погано', color: '#ff5674', tip: 'Рекомендовано залишатися в приміщенні.' };
  return { label: 'Надзвичайно погано', color: '#b388ff', tip: 'Уникайте перебування на вулиці.' };
}

function renderSun(daily) {
  if (!daily.sunrise || !daily.sunrise.length) {
    els.sunInfo.innerHTML = '<div class="empty">Немає даних</div>';
    return;
  }

  const sunrise = daily.sunrise[0];
  const sunset = daily.sunset[0];
  const riseMinutes = toMinutes(sunrise.slice(11, 16));
  const setMinutes = toMinutes(sunset.slice(11, 16));
  const dayLength = Math.max(0, setMinutes - riseMinutes);
  const now = kyivNow().minutes;
  const progress = Math.max(0, Math.min(1, (now - riseMinutes) / (dayLength || 1)));

  const angle = Math.PI * progress;
  const cx = 100 - 88 * Math.cos(angle);
  const cy = 44 - 33 * Math.sin(angle);
  const isNight = now < riseMinutes || now > setMinutes;
  const moon = moonPhase();

  els.sunInfo.innerHTML = `
    <div class="sun-times">
      <div class="sun-time">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v12M12 16l-4-4M12 16l4-4M4 20h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${sunrise.slice(11, 16)}<small>схід</small></span>
      </div>
      <div class="sun-time" style="color:${isNight ? '#93a2bd' : '#ffd60a'}">
        <span>${isNight ? '🌙' : '☀️'}</span>
        <span>${Math.round(progress * 100)}%<small>дня</small></span>
      </div>
      <div class="sun-time">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20V8M12 8l-4 4M12 8l4 4M4 4h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${sunset.slice(11, 16)}<small>захід</small></span>
      </div>
    </div>
    <div class="sun-arc">
      <svg viewBox="0 0 200 50" aria-hidden="true">
        <path d="M12 44 A88 33 0 0 1 188 44" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2" stroke-dasharray="3 5"/>
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.6" fill="${isNight ? '#6c7a94' : '#ffd60a'}"/>
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="${isNight ? 'rgba(108,122,148,.18)' : 'rgba(255,214,10,.22)'}"/>
      </svg>
    </div>
    <div class="sun-arc__hint"><span>Тривалість дня · ${formatDuration(dayLength)}</span><span>${isNight ? 'зараз ніч' : 'зараз день'}</span></div>
    <div class="sun-moon"><span>${moon.emoji} ${moon.name}</span><span>освітленість ${moon.illumination}%</span></div>
  `;
}

function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const reference = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - reference) / 86400000;
  const phase = (((days % synodic) + synodic) % synodic) / synodic;
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100);
  const phases = [
    ['Молодик', '🌑'],
    ['Молодий місяць', '🌒'],
    ['Перша чверть', '🌓'],
    ['Прибуває', '🌔'],
    ['Повня', '🌕'],
    ['Спадає', '🌖'],
    ['Остання чверть', '🌗'],
    ['Старий місяць', '🌘'],
  ];
  const [name, emoji] = phases[Math.round(phase * 8) % 8];
  return { name, emoji, illumination };
}

function toMinutes(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return hour * 60 + minute;
}

async function loadWeather() {
  const city = getCity(state.city);

  try {
    const data = await getJSON(`/api/weather?lat=${city.lat}&lon=${city.lon}`);
    state.weather = data;
    renderWeather(data, city);
    markRefresh();
  } catch (error) {
    els.weatherNow.innerHTML = `
      <div class="empty">Не вдалося завантажити погоду.<br /><small>${esc(error.message)}</small><br />
        <button class="retry" data-retry="weather" type="button">Спробувати ще раз</button>
      </div>`;
    els.weatherChart.innerHTML = '';
    els.forecast.innerHTML = '';
    els.airQuality.innerHTML = '<div class="empty">—</div>';
    els.sunInfo.innerHTML = '<div class="empty">—</div>';
  }
}

/* ------------------------------------------------------------------ */
/*  Тривоги                                                            */
/* ------------------------------------------------------------------ */

async function loadAlerts() {
  try {
    const data = await getJSON('/api/alerts');
    state.alerts = data;
    renderAlerts(data);
    markRefresh();
  } catch {
    if (!state.alerts) {
      els.alertHeadline.textContent = 'Не вдалося перевірити тривоги';
      els.alertSub.textContent = 'Джерело alerts.in.ua тимчасово недоступне';
      els.alertsMap.innerHTML = '<div class="empty">Немає зв’язку з джерелом тривог</div>';
    }
  }
}

function renderAlerts(data) {
  const active = data.states.filter((region) => region.alert && !region.nominal);
  const nominal = data.states.filter((region) => region.nominal);
  const red = Number(data.redCount || active.filter((region) => region.level === 'red').length);
  const yellow = Number(data.yellowCount || active.filter((region) => region.level === 'yellow').length);
  const strip = els.statusStrip;

  strip.classList.remove('is-loading', 'has-alerts');

  if (active.length) {
    strip.classList.add('has-alerts');
    const names = active.slice(0, 3).map((region) => shortRegionName(region.name));
    const rest = active.length - names.length;
    els.alertHeadline.textContent = `Повітряна тривога · ${names.join(', ')}${rest > 0 ? ` та ще ${rest}` : ''}`;
    els.alertHeadline.title = active.map((region) => `${region.name} (${region.level === 'red' ? 'червоний' : 'жовтий'})`).join(', ');
    const parts = [];
    if (red) parts.push(`🔴 ${red} ${plural(red, 'регіон', 'регіони', 'регіонів')} — ракетна загроза`);
    if (yellow) parts.push(`🟡 ${yellow} ${plural(yellow, 'регіон', 'регіони', 'регіонів')} — дрони`);
    els.alertSub.textContent = `${parts.join(' · ')} · натисніть на область для деталей`;
  } else {
    els.alertHeadline.textContent = 'Повітряних тривог немає';
    els.alertHeadline.title = '';
    els.alertSub.textContent = `Усі ${data.states.length} регіонів у спокої · станом на ${formatKyivTime(data.lastUpdate)}`;
  }

  els.alertCount.textContent = active.length;
  els.alertsUpdated.textContent = `оновлено ${formatKyivTime(data.updatedAt)}`;

  els.alertsMap.innerHTML = data.states
    .map((region) => {
      const classes = ['region-chip'];
      if (region.nominal) classes.push('is-nominal');
      else if (region.alert) classes.push(region.level === 'yellow' ? 'is-yellow' : 'is-alert');

      const levelLabel = region.level === 'yellow' ? 'жовтий рівень (дрони)' : 'червоний рівень (ракети)';
      const title = region.nominal
        ? `${region.name} — ${region.note || 'номінальна тривога на окупованій території'}`
        : region.alert
          ? `${region.name} — тривога, ${levelLabel}${region.changed ? `, з ${formatKyivTime(region.changed)}` : ''}`
          : `${region.name} — без тривоги`;

      return `
        <button class="${classes.join(' ')}" type="button"
          data-region="${esc(region.name)}"
          data-active="${region.alert && !region.nominal ? '1' : '0'}"
          data-nominal="${region.nominal ? '1' : '0'}"
          data-level="${esc(region.level || '')}"
          data-note="${esc(region.note || '')}"
          data-changed="${esc(region.changed || '')}"
          title="${esc(title)}">
          <i></i><span>${esc(shortRegionName(region.name))}</span>
        </button>
      `;
    })
    .join('');

  if (nominal.length) {
    els.alertsMap.dataset.nominal = nominal.map((region) => shortRegionName(region.name)).join(', ');
  }
}

function plural(number, one, few, many) {
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/* ------------------------------------------------------------------ */
/*  Відключення                                                        */
/* ------------------------------------------------------------------ */

async function loadOutages() {
  try {
    const data = await getJSON(`/api/outages?region=${encodeURIComponent(state.region)}`);
    state.outages = data;
    state.region = data.region.id;

    const available = data.region.queues.map((queue) => queue.id);
    if (!state.queue || !available.includes(state.queue)) {
      state.queue = available[0] || null;
    }

    populateRegions(data.regions);
    populateQueues(data.region.queues);
    renderOutages();
    markRefresh();
  } catch (error) {
    els.outageSummary.innerHTML = `<div class="empty">Не вдалося завантажити графік.<br /><small>${esc(error.message)}</small><br /><button class="retry" data-retry="outages" type="button">Спробувати ще раз</button></div>`;
    els.outageTimeline.innerHTML = '';
    els.outageStats.innerHTML = '';
  }
}

function populateRegions(regions) {
  if (!els.regionSelect || !Array.isArray(regions)) return;

  const sorted = [...regions].sort((a, b) => {
    if (a.id === 'kyiv') return -1;
    if (b.id === 'kyiv') return 1;
    return a.name.localeCompare(b.name, 'uk');
  });

  els.regionSelect.innerHTML = sorted
    .map((region) => `<option value="${esc(region.id)}">${esc(region.name)}</option>`)
    .join('');

  els.regionSelect.value = state.region;
  // після перебудови списку значення могло не застосуватися
  if (els.regionSelect.value !== state.region && sorted[0]) state.region = sorted[0].id;
  save(STORAGE.region, state.region);
}

function populateQueues(queues) {
  if (!els.queueSelect || !Array.isArray(queues)) return;

  els.queueSelect.innerHTML = queues
    .map((queue) => `<option value="${esc(queue.id)}">${esc(queue.label)}</option>`)
    .join('');

  els.queueSelect.value = state.queue;
  save(STORAGE.queue, state.queue);
}

function analyzeDay(slots, isToday) {
  const keys = Object.keys(slots || {}).sort();
  const values = keys.map((key) => Number(slots[key]));
  const count = values.length;

  const intervals = [];
  let offSlots = 0;

  for (let index = 0; index < count; index += 1) {
    if (values[index] === 2) {
      offSlots += 1;
      const start = index;
      let end = index;
      while (end + 1 < count && values[end + 1] === 2) {
        end += 1;
        offSlots += 1;
      }
      intervals.push({ start, end });
      index = end;
    }
  }

  const nowIndex = Math.min(47, Math.floor(kyivNow().minutes / 30));
  let current = null;
  let nextOff = null;
  let nextOn = null;

  if (isToday) {
    current = values[nowIndex] === 2 ? 'off' : values[nowIndex] === 1 ? 'on' : 'unknown';

    for (let index = nowIndex + 1; index < count; index += 1) {
      const startsOff = values[index] === 2 && values[index - 1] !== 2;
      if (startsOff) {
        nextOff = index;
        break;
      }
    }

    if (current === 'off') {
      for (let index = nowIndex + 1; index < count; index += 1) {
        if (values[index] !== 2) {
          nextOn = index;
          break;
        }
      }
    }
  } else {
    nextOff = intervals.length ? intervals[0].start : null;
  }

  const totalMinutes = offSlots * 30;
  const longest = intervals.reduce((max, interval) => Math.max(max, (interval.end - interval.start + 1) * 30), 0);

  return {
    keys,
    values,
    count,
    intervals,
    offSlots,
    totalMinutes,
    longest,
    current,
    nextOff,
    nextOn,
    nowIndex,
  };
}

function renderOutages() {
  const data = state.outages;
  if (!data) return;

  const region = data.region;
  const queue = region.queues.find((item) => item.id === state.queue) || region.queues[0];
  if (!queue) {
    els.outageSummary.innerHTML = '<div class="empty">Для цієї області немає даних</div>';
    return;
  }

  state.queue = queue.id;
  els.queueSelect.value = queue.id;

  const isToday = state.day === 'today';
  const requestedDate = isToday ? data.dateToday : data.dateTomorrow;

  let date = requestedDate;
  let slots = (queue.days && queue.days[date]) || {};
  let fallbackDate = null;

  if (!Object.keys(slots).length) {
    const available = Object.keys(queue.days || {}).sort();
    if (available.length) {
      fallbackDate = available[available.length - 1];
      date = fallbackDate;
      slots = queue.days[date];
    }
  }

  const usingFallback = Boolean(fallbackDate && fallbackDate !== requestedDate);
  const todayView = isToday && !usingFallback;
  const analysis = analyzeDay(slots, todayView);

  const badge = els.outageBadge;
  if (data.demo) {
    badge.hidden = false;
    badge.textContent = 'Демо-дані';
    badge.className = 'outage-badge outage-badge--demo';
    badge.title = data.demoNote || '';
  } else if (usingFallback) {
    badge.hidden = false;
    badge.textContent = `Дані від ${formatShortDate(fallbackDate)}`;
    badge.className = 'outage-badge';
    badge.title = 'Актуального графіка на цю дату немає — показано останній опублікований варіант';
  } else if (region.emergency) {
    badge.hidden = false;
    badge.textContent = 'Аварійні відключення';
    badge.className = 'outage-badge';
    badge.title = 'У регіоні можливі позапланові аварійні відключення';
  } else {
    badge.hidden = true;
  }

  if (!analysis.count) {
    els.outageSummary.innerHTML = `
      <div class="outage-summary__state"><i class="outage-summary__dot"></i>Немає даних на ${isToday ? 'сьогодні' : 'завтра'}</div>
      <div class="outage-summary__next">Джерело ще не опублікувало графік для цієї області</div>`;
    els.outageTimeline.innerHTML = '<div class="empty">Оновіть пізніше — у джерела поки немає жодного опублікованого графіка для цієї черги</div>';
    els.outageStats.innerHTML = '';
    return;
  }

  let stateTitle = '';
  let stateSub = '';

  if (usingFallback) {
    stateTitle = `Графік станом на ${formatShortDate(fallbackDate)}`;
    stateSub = 'Актуального графіка на цю дату немає — показано останній опублікований';
  } else if (isToday) {
    if (analysis.current === 'off') {
      stateTitle = 'Світла немає за графіком';
      stateSub = analysis.nextOn !== null
        ? `Увімкнення орієнтовно о <b>${slotLabel(analysis.nextOn)}</b>`
        : 'Відключення до кінця доби';
    } else {
      stateTitle = 'Світло є';
      stateSub = analysis.nextOff !== null
        ? `Відключення орієнтовно о <b>${slotLabel(analysis.nextOff)}</b>`
        : 'Наступного відключення за графіком немає';
    }
  } else {
    stateTitle = 'Прогноз на завтра';
    stateSub = analysis.intervals.length
      ? `Відключень: <b>${analysis.intervals.length}</b> · перше о <b>${slotLabel(analysis.intervals[0].start)}</b>`
      : 'Відключень за графіком немає';
  }

  els.outageSummary.innerHTML = `
    <div class="outage-summary__state">
      <i class="outage-summary__dot ${todayView && analysis.current === 'off' ? 'off' : ''}"></i>
      ${stateTitle}
    </div>
    <div class="outage-summary__next">${stateSub}</div>
    <div class="outage-summary__spacer"></div>
    <div class="outage-summary__total">${analysis.totalMinutes ? formatDuration(analysis.totalMinutes) : 'без відключень'}</div>
  `;

  els.outageTimeline.innerHTML = `
    <div class="timeline" role="img" aria-label="Графік відключень на ${date}">
      ${analysis.values
        .map((value, index) => {
          const status = value === 1 ? 'є світло' : value === 2 ? 'відключення' : 'немає даних';
          const classes = ['slot'];
          if (value === 2) classes.push('off');
          if (value !== 1 && value !== 2) classes.push('unknown');
          if (todayView && index === analysis.nowIndex) classes.push('is-now');
          return `<div class="${classes.join(' ')}" title="${slotLabel(index)}–${slotLabel(index + 1)} · ${status}"></div>`;
        })
        .join('')}
    </div>
    <div class="timeline-legend">
      <span>${slotLabel(0)}</span>
      <span class="timeline-legend__mid">
        <span><i class="legend-on"></i>є світло</span>
        <span><i class="legend-off"></i>відключення</span>
      </span>
      <span>24:00</span>
    </div>
  `;

  const nextValue = todayView
    ? analysis.current === 'off'
      ? analysis.nextOn !== null
        ? `о ${slotLabel(analysis.nextOn)}`
        : '—'
      : analysis.nextOff !== null
        ? `о ${slotLabel(analysis.nextOff)}`
        : '—'
    : analysis.nextOff !== null
      ? `о ${slotLabel(analysis.nextOff)}`
      : '—';

  els.outageStats.innerHTML = `
    <div class="outage-stat"><small>Без світла</small><strong class="${analysis.totalMinutes ? 'accent' : ''}">${formatDuration(analysis.totalMinutes)}</strong></div>
    <div class="outage-stat"><small>Відключень</small><strong>${analysis.intervals.length}</strong></div>
    <div class="outage-stat"><small>Найдовше</small><strong>${analysis.longest ? formatDuration(analysis.longest) : '—'}</strong></div>
    <div class="outage-stat"><small>${todayView ? 'Наступне' : 'Перше'}</small><strong class="${nextValue !== '—' ? 'danger' : ''}">${nextValue}</strong></div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Новини                                                             */
/* ------------------------------------------------------------------ */

async function loadNews() {
  try {
    const data = await getJSON('/api/news');
    state.news = data;
    renderNewsFilters(data.sources);
    renderNews();
    markRefresh();
  } catch (error) {
    els.newsList.innerHTML = `<div class="empty">Не вдалося завантажити новини.<br /><small>${esc(error.message)}</small><br /><button class="retry" data-retry="news" type="button">Спробувати ще раз</button></div>`;
  }
}

function renderNewsFilters(sources) {
  const filters = [{ id: 'all', name: 'Усі' }, ...sources];
  els.newsFilters.innerHTML = filters
    .map(
      (source) =>
        `<button class="chip ${state.newsFilter === source.id ? 'is-active' : ''}" type="button" data-filter="${esc(source.id)}">${esc(source.name)}</button>`,
    )
    .join('');
}

function renderNews() {
  if (!state.news) return;

  const filtered =
    state.newsFilter === 'all'
      ? state.news.items
      : state.news.items.filter((item) => item.sourceId === state.newsFilter);

  if (!filtered.length) {
    els.newsList.innerHTML = '<div class="empty">Новин за цим фільтром немає</div>';
    return;
  }

  els.newsList.innerHTML = filtered
    .slice(0, 35)
    .map((item) => {
      const time = newsTime(item.date);
      const image = item.image
        ? `<img class="news-item__thumb" src="${esc(safeUrl(item.image))}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : '';

      return `
        <a class="news-item" href="${esc(safeUrl(item.link))}" target="_blank" rel="noreferrer" data-source="${esc(item.sourceId)}">
          <div class="news-item__meta">
            <span class="news-item__source">${esc(item.source)}</span>
            <span>${time}</span>
          </div>
          ${image}
          <div class="news-item__title">${esc(item.title)}</div>
        </a>
      `;
    })
    .join('');

  if (state.news.failed && state.news.failed.length) {
    els.newsMeta.textContent = `RSS · ${state.news.sources.length - state.news.failed.length} з ${state.news.sources.length} джерел · оновлення кожні 4 хв`;
  } else {
    els.newsMeta.textContent = `RSS · ${state.news.sources.length} джерел · оновлення кожні 4 хв`;
  }
}

function newsTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = kyivNow();
  const itemDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  if (itemDate === now.date) return formatKyivTime(date);

  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: KYIV_TZ,
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/* ------------------------------------------------------------------ */
/*  Валюти                                                             */
/* ------------------------------------------------------------------ */

async function loadCurrency() {
  try {
    const data = await getJSON('/api/currency');
    state.currency = data;
    renderCurrency(data);
    markRefresh();
  } catch {
    els.currencyRates.innerHTML = '<div class="empty">Курс недоступний</div>';
  }
}

function renderCurrency(data) {
  els.currencyRates.innerHTML = data.rates
    .map(
      (rate) => `
        <div class="rate" title="${esc(rate.name)}">
          <b>${esc(rate.code)}</b>
          <span>${rate.rate.toFixed(rate.rate > 10 ? 2 : 3)}</span>
        </div>
      `,
    )
    .join('');

  els.convCurrency.innerHTML = data.rates
    .map((rate) => `<option value="${esc(rate.code)}">${esc(rate.code)}</option>`)
    .join('');
  els.convCurrency.value = 'USD';

  updateConverter();
}

function updateConverter() {
  if (!state.currency) return;

  const amount = Number(els.convAmount.value || 0);
  const code = els.convCurrency.value;
  const rate = state.currency.rates.find((item) => item.code === code);

  if (!rate || !Number.isFinite(amount)) {
    els.convResult.textContent = '—';
    return;
  }

  els.convResult.textContent = new Intl.NumberFormat('uk-UA', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount * rate.rate);
}

/* ------------------------------------------------------------------ */
/*  Ініціалізація та події                                              */
/* ------------------------------------------------------------------ */

function initElements() {
  [
    'statusStrip', 'alertHeadline', 'alertSub', 'alertCount', 'alertsUpdated',
    'citySelect', 'weatherNow', 'weatherChart', 'forecast',
    'regionSelect', 'queueSelect', 'dayTabs', 'outageBadge', 'outageSummary',
    'outageTimeline', 'outageStats', 'outageSource',
    'currencyRates', 'convAmount', 'convCurrency', 'convResult',
    'airQuality', 'sunInfo', 'alertsMap', 'newsFilters', 'newsList', 'newsMeta',
    'clock', 'clockDate', 'refreshAll', 'toast', 'footerYear', 'lastRefresh',
  ].forEach((id) => {
    els[id] = $(id);
  });
}

function initClock() {
  const tick = () => {
    const now = new Date();
    els.clock.textContent = new Intl.DateTimeFormat('uk-UA', {
      timeZone: KYIV_TZ,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);

    els.clockDate.textContent = new Intl.DateTimeFormat('uk-UA', {
      timeZone: KYIV_TZ,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(now);
  };
  tick();
  setInterval(tick, 1000);
}

function initSelects() {
  const groups = new Map();
  for (const city of CITIES) {
    const key = city.oblast || 'Інші';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(city);
  }

  const order = [...groups.keys()].sort((a, b) => {
    const rank = (name) => (name === 'м. Київ' ? 0 : name === 'Київська область' ? 1 : name === 'Автономна Республіка Крим' ? 8 : name === 'Севастополь' ? 9 : 2);
    return rank(a) - rank(b) || a.localeCompare(b, 'uk');
  });

  els.citySelect.innerHTML = order
    .map((oblast) => {
      const options = groups
        .get(oblast)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'uk'))
        .map((city) => `<option value="${esc(city.id)}">${esc(city.name)}</option>`)
        .join('');
      return `<optgroup label="${esc(oblast)}">${options}</optgroup>`;
    })
    .join('');

  if (!CITY_BY_ID.has(state.city)) state.city = 'kyiv';
  els.citySelect.value = state.city;

  els.footerYear.textContent = new Date().getFullYear();
}

function initEvents() {
  els.citySelect.addEventListener('change', () => {
    state.city = els.citySelect.value;
    save(STORAGE.city, state.city);
    loadWeather();

    const city = getCity(state.city);
    if (city.region && state.outages && state.outages.regions.some((region) => region.id === city.region)) {
      state.region = city.region;
      state.queue = null;
      save(STORAGE.region, state.region);
      els.regionSelect.value = state.region;
      loadOutages();
    }
  });

  els.regionSelect.addEventListener('change', () => {
    state.region = els.regionSelect.value;
    state.queue = null;
    save(STORAGE.region, state.region);
    loadOutages();
  });

  els.queueSelect.addEventListener('change', () => {
    state.queue = els.queueSelect.value;
    save(STORAGE.queue, state.queue);
    renderOutages();
  });

  els.dayTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-day]');
    if (!button) return;
    state.day = button.dataset.day;
    els.dayTabs.querySelectorAll('[data-day]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderOutages();
  });

  els.alertsMap.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-region]');
    if (!chip) return;

    const name = chip.dataset.region;
    const isActive = chip.dataset.active === '1';
    const isNominal = chip.dataset.nominal === '1';
    const changed = chip.dataset.changed;
    const level = chip.dataset.level;
    const note = chip.dataset.note;

    if (isNominal) {
      toast(`${name}: ${note || 'номінальна тривога на окупованій території'}`);
    } else if (isActive) {
      const levelLabel = level === 'yellow' ? 'жовтий рівень (дрони)' : 'червоний рівень (ракети)';
      toast(`${name}: ${levelLabel}${changed ? ` · з ${formatKyivTime(changed)}` : ''}`);
    } else {
      toast(`${name}: тривоги немає${note ? ` · ${note}` : ''}`);
    }
  });

  els.newsFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    state.newsFilter = chip.dataset.filter;
    els.newsFilters.querySelectorAll('.chip').forEach((item) => {
      item.classList.toggle('is-active', item === chip);
    });
    renderNews();
  });

  els.convAmount.addEventListener('input', updateConverter);
  els.convCurrency.addEventListener('change', updateConverter);

  document.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry]');
    if (!retry) return;
    const target = retry.dataset.retry;
    if (target === 'weather') loadWeather();
    if (target === 'outages') loadOutages();
    if (target === 'news') loadNews();
  });

  els.refreshAll.addEventListener('click', () => refreshAll(true));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(false);
  });
}

async function refreshAll(notify) {
  els.refreshAll.classList.add('is-spinning');

  const results = await Promise.allSettled([
    loadWeather(),
    loadAlerts(),
    loadOutages(),
    loadNews(),
    loadCurrency(),
  ]);

  els.refreshAll.classList.remove('is-spinning');

  if (notify) {
    const failed = results.filter((result) => result.status === 'rejected').length;
    toast(failed ? `Оновлено, але ${failed} джерело(а) недоступне` : 'Усі дані оновлено');
  }
}

function initAutoRefresh() {
  state.timers.push(setInterval(loadAlerts, 45 * 1000));
  state.timers.push(setInterval(loadWeather, 10 * 60 * 1000));
  state.timers.push(setInterval(loadOutages, 5 * 60 * 1000));
  state.timers.push(setInterval(loadNews, 4 * 60 * 1000));
  state.timers.push(setInterval(loadCurrency, 60 * 60 * 1000));
}

function init() {
  initElements();
  initClock();
  initSelects();
  initEvents();
  initAutoRefresh();

  els.outageSource.textContent = 'Агрегатор svitlo-format · оновлення кожні 15 хв';

  refreshAll(false);
}

document.addEventListener('DOMContentLoaded', init);
