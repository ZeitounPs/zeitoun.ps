#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const RSS_URL = 'https://www.aljazeera.com/xml/rss/all.xml';
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

function getMediaThumbnail(block) {
  const mediaContent = block.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (mediaContent) return mediaContent[1].trim();

  const mediaThumb = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (mediaThumb) return mediaThumb[1].trim();

  const enclosure = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
  if (enclosure) return enclosure[1].trim();

  const description = getTagValue(block, 'description');
  const imgFromDescription = description.match(/<img[^>]*src=["']([^"']+)["']/i);
  return imgFromDescription ? imgFromDescription[1].trim() : '';
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
      image: getMediaThumbnail(item),
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
  const parsed = parseRss(xml)
    .filter((entry) => entry.title && entry.link && isRelatedToPalestine(entry))
    .sort((a, b) => new Date(b.pubDateRaw) - new Date(a.pubDateRaw))
    .slice(0, MAX_ITEMS)
    .map((entry) => ({
      title: entry.title,
      link: entry.link,
      pubDate: formatPubDate(entry.pubDateRaw),
      image: entry.image || ''
    }));

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
