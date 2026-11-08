'use strict';

/**
 * Мінімальний RSS/Atom парсер без зовнішніх залежностей.
 * Достатньо для стрічок українських медіа.
 */

function stripCdata(value) {
  return String(value || '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '');
}

function decodeEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    laquo: '«',
    raquo: '»',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };

  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
    });
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function clean(value) {
  return decodeEntities(stripTags(stripCdata(value)))
    .replace(/\s+/g, ' ')
    .trim();
}

function rawTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function attrFromTag(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*>`, 'i');
  const match = xml.match(re);
  return match ? decodeEntities(match[1]) : '';
}

function firstLink(item) {
  const plain = clean(rawTag(item, 'link'));
  if (plain) return plain;

  const href = attrFromTag(item, 'link', 'href');
  if (href) return href;

  const guid = clean(rawTag(item, 'guid'));
  if (/^https?:\/\//i.test(guid)) return guid;

  return '';
}

function firstImage(item, descriptionHtml) {
  const candidates = [
    attrFromTag(item, 'enclosure', 'url'),
    attrFromTag(item, 'media:content', 'url'),
    attrFromTag(item, 'media:thumbnail', 'url'),
    attrFromTag(item, 'image', 'href'),
  ].filter(Boolean);

  if (candidates.length) return candidates[0];

  const img = String(descriptionHtml || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return img ? decodeEntities(img[1]) : '';
}

function parseDate(item) {
  const candidate =
    clean(rawTag(item, 'pubDate')) ||
    clean(rawTag(item, 'dc:date')) ||
    clean(rawTag(item, 'published')) ||
    clean(rawTag(item, 'updated'));

  const date = candidate ? new Date(candidate) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function cut(value, length) {
  const text = String(value || '').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length).replace(/\s+\S*$/, '')}…`;
}

function parseFeed(xml, source) {
  const text = String(xml || '');
  const blocks = [];

  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRe.exec(text)) !== null) {
    blocks.push(match[0]);
  }

  if (!blocks.length) {
    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    while ((match = entryRe.exec(text)) !== null) {
      blocks.push(match[0]);
    }
  }

  const items = [];

  for (const item of blocks) {
    const descriptionHtml = rawTag(item, 'description') || rawTag(item, 'content:encoded') || rawTag(item, 'summary');
    const title = cut(clean(rawTag(item, 'title')), 180);
    const link = firstLink(item);

    if (!title || !link) continue;

    items.push({
      id: `${source.id}:${link}`,
      title,
      link,
      source: source.name,
      sourceId: source.id,
      description: cut(clean(descriptionHtml), 200),
      image: firstImage(item, descriptionHtml),
      date: parseDate(item).toISOString(),
    });
  }

  return items;
}

module.exports = { parseFeed };
