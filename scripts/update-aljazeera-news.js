#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const RSS_URL = 'https://www.aljazeera.com/xml/rss/all.xml';
const AL_JAZEERA_BASE_URL = 'https://www.aljazeera.com';
const OUTPUT_FILE = path.resolve(__dirname, '..', 'news.json');
const MAX_ITEMS = 4;

const KEYWORDS = [
  'palestine',
  'palestinian',
  'gaza',
  'west bank',
  'israel-palestine',
  'israel palestine conflict',
  'israel-gaza',
  'occupied territories'
];

const USER_AGENT = 'zeitoun-news-updater/2.0';

function decodeHtmlEntities(input) {
  return (input || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripHtml(input) {
  return decodeHtmlEntities(input).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTagValue(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(re);
  return match ? match[1].trim() : '';
}

function getAttributeValue(tag, name) {
  if (!tag) return '';
  const re = new RegExp(`${name}=["']([^"']+)["']`, 'i');
  const match = tag.match(re);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function getFirstTag(block, tagNames) {
  for (const tagName of tagNames) {
    const re = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
    const match = block.match(re);
    if (match) return match[0];
  }
  return '';
}

function getImageFromHtml(html) {
  const decoded = decodeHtmlEntities(html || '');
  const img = decoded.match(/<img[^>]*src=["']([^"']+)["']/i);
  return img ? img[1].trim() : '';
}

function normalizeImageUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return '';

  try {
    if (raw.startsWith('//')) {
      return `https:${raw}`;
    }

    if (raw.startsWith('/')) {
      return new URL(raw, AL_JAZEERA_BASE_URL).toString();
    }

    const url = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : new URL(raw, AL_JAZEERA_BASE_URL);

    if (url.protocol === 'http:') {
      url.protocol = 'https:';
    }

    return url.toString();
  } catch {
    return '';
  }
}

function isRelatedToPalestine(entry) {
  const haystack = [
    entry.title,
    entry.link,
    entry.description,
    ...(entry.categories || [])
  ]
    .join(' ')
    .toLowerCase();

  return KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function formatPubDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);

  return items.map((item) => {
    const title = stripHtml(getTagValue(item, 'title'));
    const link = decodeHtmlEntities(getTagValue(item, 'link'));
    const descriptionRaw = getTagValue(item, 'description');
    const description = stripHtml(descriptionRaw);
    const pubDateRaw = decodeHtmlEntities(getTagValue(item, 'pubDate'));
    const categories = [...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripHtml(m[1]));

    const rssCandidates = [
      { name: 'enclosure.url', value: getAttributeValue(getFirstTag(item, ['enclosure']), 'url') },
      { name: 'media:content', value: getAttributeValue(getFirstTag(item, ['media:content', 'mediaContent']), 'url') },
      { name: 'media:thumbnail', value: getAttributeValue(getFirstTag(item, ['media:thumbnail', 'mediaThumbnail']), 'url') },
      { name: 'content img', value: getImageFromHtml(getTagValue(item, 'content:encoded') || getTagValue(item, 'content')) },
      { name: 'description img', value: getImageFromHtml(descriptionRaw) }
    ];

    return {
      title,
      link,
      description,
      pubDateRaw,
      categories,
      rssCandidates
    };
  });
}

async function fetchArticleHtml(link) {
  try {
    const response = await fetch(link, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (!response.ok) {
      return { html: '', note: `article fetch failed: ${response.status}` };
    }

    return { html: await response.text(), note: 'article fetched' };
  } catch (error) {
    return { html: '', note: `article fetch error: ${error.message}` };
  }
}

function getMetaContent(html, propertyOrName) {
  if (!html) return '';
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propertyOrName}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const match = html.match(re);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function getFirstImageFromHtml(html) {
  if (!html) return '';
  const imgMatch = html.match(/<img[^>]*src=["']([^"']+)["']/i);
  return imgMatch ? decodeHtmlEntities(imgMatch[1]) : '';
}

async function selectBestImage(entry) {
  const attempts = [];

  for (const candidate of entry.rssCandidates) {
    const normalized = normalizeImageUrl(candidate.value);
    attempts.push(`${candidate.name}: ${normalized || 'empty'}`);
    if (normalized) {
      return { image: normalized, attempts, selectedFrom: `RSS ${candidate.name}` };
    }
  }

  const { html, note } = await fetchArticleHtml(entry.link);
  attempts.push(note);

  const ogImage = normalizeImageUrl(getMetaContent(html, 'og:image'));
  attempts.push(`article og:image: ${ogImage || 'empty'}`);
  if (ogImage) {
    return { image: ogImage, attempts, selectedFrom: 'article og:image' };
  }

  const twitterImage = normalizeImageUrl(getMetaContent(html, 'twitter:image'));
  attempts.push(`article twitter:image: ${twitterImage || 'empty'}`);
  if (twitterImage) {
    return { image: twitterImage, attempts, selectedFrom: 'article twitter:image' };
  }

  const firstImg = normalizeImageUrl(getFirstImageFromHtml(html));
  attempts.push(`article first <img>: ${firstImg || 'empty'}`);

  if (firstImg) {
    return { image: firstImg, attempts, selectedFrom: 'article first <img>' };
  }

  return { image: '', attempts, selectedFrom: 'none' };
}

async function main() {
  const response = await fetch(RSS_URL, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed: ${response.status}`);
  }

  const xml = await response.text();
  const candidates = parseRss(xml)
    .filter((entry) => entry.title && entry.link && isRelatedToPalestine(entry))
    .sort((a, b) => new Date(b.pubDateRaw) - new Date(a.pubDateRaw))
    .slice(0, MAX_ITEMS);

  if (!candidates.length) {
    throw new Error('No Palestine-related items found in RSS feed.');
  }

  const output = [];

  for (const entry of candidates) {
    const imageResult = await selectBestImage(entry);

    const item = {
      title: entry.title,
      link: entry.link,
      pubDate: formatPubDate(entry.pubDateRaw),
      image: imageResult.image
    };

    output.push(item);

    console.log('--- Al Jazeera news item ---');
    console.log(`title: ${item.title}`);
    console.log(`link: ${item.link}`);
    console.log(`pubDate: ${item.pubDate}`);
    console.log(`image: ${item.image || '(empty)'}`);
    console.log(`image_source: ${imageResult.selectedFrom}`);

    if (!item.image) {
      console.warn(`WARNING: image missing for article: ${item.link}`);
      console.warn(`Fallback trace: ${imageResult.attempts.join(' | ')}`);
    }
  }

  const emptyImages = output.filter((item) => !item.image).length;
  if (emptyImages === output.length) {
    throw new Error('All fetched items have empty image values. Aborting update to keep existing news.json intact.');
  }

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Updated ${OUTPUT_FILE} with ${output.length} article(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
