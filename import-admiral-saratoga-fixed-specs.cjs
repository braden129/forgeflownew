const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

const COLLECTION_URL = 'https://admiral-outdoor.com/collections/saratoga';
const BASE_URL = 'https://admiral-outdoor.com';

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function absoluteUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url}`;
}

function decodeEscapedText(value) {
  if (!value) return '';

  let text = String(value);

  // Convert literal escaped HTML such as \u003cdiv\u003e into real characters.
  text = text
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u0022/gi, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ');

  // Strip HTML tags if the website returned a table cell or metafield markup.
  text = text.replace(/<[^>]*>/g, ' ');

  // Decode common entities and clean whitespace.
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove trailing punctuation left behind by embedded JSON fragments.
  text = text.replace(/^[:\s]+/, '').replace(/[",]+$/g, '').trim();

  return text;
}

function getSpecFromPage($, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  let found = '';

  // Look for rows/cells that contain the label.
  $('tr, .specs-table-row, .product__info-container div, li, p').each((_, el) => {
    if (found) return;
    const raw = $(el).text();
    const clean = decodeEscapedText(raw);
    const lower = clean.toLowerCase();

    for (const label of labelList) {
      const labelLower = label.toLowerCase();
      if (lower.includes(labelLower)) {
        let value = clean.replace(new RegExp(label, 'i'), '').replace(/^[:\s-]+/, '').trim();
        if (value && value.toLowerCase() !== labelLower) {
          found = value;
          return;
        }
      }
    }
  });

  return decodeEscapedText(found);
}

function findEmbeddedSpec(html, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];

  for (const label of labelList) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Handles patterns near Shopify metafields like "Dimensions" ... "18\" W x 17\" H"
    const regexes = [
      new RegExp(`${escapedLabel}[\\s\\S]{0,500}?class=\\\\?"specs-table-value[^>]*>([\\s\\S]*?)<\\/td>`, 'i'),
      new RegExp(`${escapedLabel}[\\s\\S]{0,500}?\\\\u003e([^<]*?)\\\\u003c`, 'i'),
      new RegExp(`${escapedLabel}[\\s\\S]{0,250}?value\\\\?"?\\s*[:=]\\s*\\\\?"([^"\\n<]+)`, 'i'),
    ];

    for (const regex of regexes) {
      const match = html.match(regex);
      if (match && match[1]) {
        const cleaned = decodeEscapedText(match[1]);
        if (cleaned && !cleaned.toLowerCase().includes('specs-table')) return cleaned;
      }
    }
  }

  return '';
}

function normalizeSpecs($, html) {
  const productJsonText = $('script[type="application/ld+json"]').first().contents().text();
  let sku = '';

  try {
    const parsed = JSON.parse(productJsonText);
    sku = parsed.sku || parsed.offers?.sku || '';
  } catch (_) {}

  const specs = {
    sku: decodeEscapedText(sku || getSpecFromPage($, ['SKU', 'Sku']) || findEmbeddedSpec(html, ['SKU', 'Sku'])),
    dimensions: decodeEscapedText(getSpecFromPage($, ['Dimensions', 'Dimension']) || findEmbeddedSpec(html, ['Dimensions', 'Dimension'])),
    seatHeight: decodeEscapedText(getSpecFromPage($, ['Seat Height']) || findEmbeddedSpec(html, ['Seat Height'])),
    seatWidth: decodeEscapedText(getSpecFromPage($, ['Seat Width']) || findEmbeddedSpec(html, ['Seat Width'])),
    seatDepth: decodeEscapedText(getSpecFromPage($, ['Seat Depth']) || findEmbeddedSpec(html, ['Seat Depth'])),
    stackable: decodeEscapedText(getSpecFromPage($, ['Stackable']) || findEmbeddedSpec(html, ['Stackable'])),
    material: decodeEscapedText(getSpecFromPage($, ['Material']) || findEmbeddedSpec(html, ['Material'])),
  };

  return specs;
}

async function getProductLinks() {
  const { data: html } = await axios.get(COLLECTION_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href*="/collections/saratoga/products/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.add(absoluteUrl(href.split('?')[0]));
  });

  return [...links];
}

async function scrapeProduct(url) {
  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const $ = cheerio.load(html);

  let name = decodeEscapedText($('h1').first().text());
  if (!name) name = decodeEscapedText($('meta[property="og:title"]').attr('content'));

  let image = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
  image = absoluteUrl(image);

  const specs = normalizeSpecs($, html);

  return {
    id: makeId(),
    name,
    image,
    parts: [],
    specs,
    sourceUrl: url,
  };
}

async function main() {
  console.log('Scanning Saratoga collection...');
  const links = await getProductLinks();
  console.log(`Found ${links.length} product links.`);

  const types = [];

  for (const link of links) {
    console.log(`Importing ${link}`);
    const product = await scrapeProduct(link);
    types.push(product);
  }

  const backup = {
    appName: 'Admiral Outdoor Production App',
    exportedAt: new Date().toISOString(),
    models: [
      {
        id: makeId(),
        name: 'Saratoga',
        types,
      },
    ],
    schedule: [],
    liveJobs: [],
    scheduleWeeks: ['Week of', 'Week of', 'Week of', 'Week of', 'Week of'],
  };

  const outputFile = 'admiral-saratoga-import-fixed-specs.json';
  fs.writeFileSync(outputFile, JSON.stringify(backup, null, 2));

  console.log(`Done. Created ${outputFile}`);
}

main().catch((error) => {
  console.error('Import failed:');
  console.error(error.message);
  process.exit(1);
});
