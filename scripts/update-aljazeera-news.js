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
  const re = new RegExp(`${name}=["']([^"']+)["']`, 'i');
  const match = tag.match(re);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function getFirstTag(block, tagNames) {
  for (const tagName of tagNames) {
    const re = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
    const match = block.match(re);
    if (match) {
      return match[0];
    }
  }
  return '';
}

function getImageFromHtml(html) {
  const decoded = decodeHtmlEntities(html || '');
  const img = decoded.match(/<img[^>]*src=["']([^"']+)["']/i);
  return img ? img[1].trim() : '';
}

function getPreferredImageFromItemBlock(item) {
  // 1. item.enclosure.url
  const enclosureTag = getFirstTag(item, ['enclosure']);
  const enclosureUrl = getAttributeValue(enclosureTag, 'url');
  if (enclosureUrl) {
    return enclosureUrl;
  }

  // 2. item.mediaContent or item["media:content"]
  const mediaContentTag = getFirstTag(item, ['mediaContent', 'media:content']);
  const mediaContentUrl = getAttributeValue(mediaContentTag, 'url');
  if (mediaContentUrl) {
    return mediaContentUrl;
  }

  // 3. item.mediaThumbnail or item["media:thumbnail"]
  const mediaThumbnailTag = getFirstTag(item, ['mediaThumbnail', 'media:thumbnail']);
  const mediaThumbnailUrl = getAttributeValue(mediaThumbnailTag, 'url');
  if (mediaThumbnailUrl) {
    return mediaThumbnailUrl;
  }

  // 4. item.content or item.description inner <img src="...">
  const contentHtml = getTagValue(item, 'content:encoded') || getTagValue(item, 'content');
  const imageFromContent = getImageFromHtml(contentHtml);
  if (imageFromContent) {
    return imageFromContent;
  }

  const descriptionHtml = getTagValue(item, 'description');
  const imageFromDescription = getImageFromHtml(descriptionHtml);
  if (imageFromDescription) {
    return imageFromDescription;
  }

  return '';
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

async function getOgImageFromArticle(link) {
  if (!link) return '';

  try {
    const response = await fetch(link, {
      headers: {
        'User-Agent': 'zeitoun-news-updater/1.0'
      }
    });
    if (!response.ok) return '';

    const html = await response.text();
    const ogImageMeta = html.match(
      /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
    );
    if (!ogImageMeta) return '';
    return normalizeImageUrl(ogImageMeta[1]);
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
  if (Number.isNaN(date.getTime())) {
    return '';
  }

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
    const description = stripHtml(getTagValue(item, 'description'));
    const pubDateRaw = decodeHtmlEntities(getTagValue(item, 'pubDate'));
    const categories = [...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripHtml(m[1]));

    return {
      title,
      link,
      description,
      pubDateRaw,
      image: normalizeImageUrl(getPreferredImageFromItemBlock(item)),
      categories
    };
  });
}

async function main() {
  const response = await fetch(RSS_URL, {
    headers: {
      'User-Agent': 'zeitoun-news-updater/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed: ${response.status}`);
  }

  const xml = await response.text();
  const filtered = parseRss(xml)
    .filter((entry) => entry.title && entry.link && isRelatedToPalestine(entry))
    .sort((a, b) => new Date(b.pubDateRaw) - new Date(a.pubDateRaw))
    .slice(0, MAX_ITEMS);

  const parsed = await Promise.all(
    filtered.map(async (entry) => {
      const image = entry.image || (await getOgImageFromArticle(entry.link));
      return {
        title: entry.title,
        link: entry.link,
        pubDate: formatPubDate(entry.pubDateRaw),
        image: image || ''
      };
    })
  );

  if (!parsed.length) {
    throw new Error('No Palestine-related items found in RSS feed.');
  }

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  console.log(`Updated ${OUTPUT_FILE} with ${parsed.length} article(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
