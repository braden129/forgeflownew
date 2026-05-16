// Admiral Outdoor website importer - Saratoga starter version
// Run with: node import-admiral-saratoga.cjs
// Output: admiral-saratoga-import.json

const fs = require('fs');

const BASE_URL = 'https://admiral-outdoor.com';
const COLLECTION_SLUG = 'saratoga';
const COLLECTION_NAME = 'Saratoga';

function makeId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMatch(html, regex) {
  const match = html.match(regex);
  return match ? stripHtml(match[1]) : '';
}

function absoluteUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${BASE_URL}${url}`;
  return url;
}

function extractProductLinks(collectionHtml) {
  const links = new Set();
  const regex = new RegExp(`href=["']([^"']*/collections/${COLLECTION_SLUG}/products/[^"'#?]+)["']`, 'gi');
  let match;

  while ((match = regex.exec(collectionHtml))) {
    links.add(absoluteUrl(match[1]));
  }

  return [...links].sort();
}

function extractProductData(html, url) {
  const title =
    getMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    getMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i).replace(/\s*[–|-]\s*Admiral Outdoor.*/i, '');

  const sku = getMatch(html, new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,200}?<[^>]*>\\s*([^<]*\\d{3,}[^<]*)`, 'i')) ||
    getMatch(html, /"sku"\s*:\s*"([^"]+)"/i);

  const material = getMatch(html, /Material:\s*([^<\n\r]+)/i);
  const dimensions = getMatch(html, /Dimensions:\s*([^<\n\r]+)/i);
  const seatHeight = getMatch(html, /Seat Height:\s*([^<\n\r]+)/i);
  const seatDepth = getMatch(html, /Seat Depth:\s*([^<\n\r]+)/i);
  const seatWidth = getMatch(html, /Seat Width:\s*([^<\n\r]+)/i);
  const stackable = getMatch(html, /Stackable:\s*([^<\n\r]+)/i);

  const ogImage = getMatch(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    getMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  const notes = [
    sku ? `SKU: ${sku}` : '',
    material ? `Material: ${material}` : '',
    dimensions ? `Dimensions: ${dimensions}` : '',
    seatHeight ? `Seat Height: ${seatHeight}` : '',
    seatDepth ? `Seat Depth: ${seatDepth}` : '',
    seatWidth ? `Seat Width: ${seatWidth}` : '',
    stackable ? `Stackable: ${stackable}` : '',
    `Source: ${url}`,
  ].filter(Boolean).join('\n');

  return {
    id: makeId('furniture'),
    name: title || url.split('/').pop().replace(/-/g, ' '),
    image: absoluteUrl(ogImage),
    parts: [],
    notes,
    importedFromWebsite: true,
    sourceUrl: url,
    sku,
    specs: { material, dimensions, seatHeight, seatDepth, seatWidth, stackable },
  };
}

async function main() {
  console.log(`Fetching ${COLLECTION_NAME} collection...`);
  const collectionUrl = `${BASE_URL}/collections/${COLLECTION_SLUG}`;
  const collectionHtml = await fetch(collectionUrl).then((res) => {
    if (!res.ok) throw new Error(`Could not fetch collection page: ${res.status}`);
    return res.text();
  });

  const productLinks = extractProductLinks(collectionHtml);
  console.log(`Found ${productLinks.length} product links.`);

  const types = [];

  for (const productUrl of productLinks) {
    console.log(`Importing ${productUrl}`);
    const html = await fetch(productUrl).then((res) => {
      if (!res.ok) throw new Error(`Could not fetch product page: ${res.status} ${productUrl}`);
      return res.text();
    });

    types.push(extractProductData(html, productUrl));
  }

  const backup = {
    appName: 'Admiral Outdoor Production App',
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    models: [
      {
        id: makeId('collection'),
        name: COLLECTION_NAME,
        types,
      },
    ],
    schedule: [],
    liveJobs: [],
    scheduleWeeks: ['Week of', 'Week of', 'Week of', 'Week of', 'Week of'],
  };

  const outputFile = 'admiral-saratoga-import.json';
  fs.writeFileSync(outputFile, JSON.stringify(backup, null, 2));
  console.log(`Done. Created ${outputFile}`);
  console.log('Open your app, click Import Backup, and choose that JSON file.');
}

main().catch((error) => {
  console.error('Import failed:');
  console.error(error);
  process.exit(1);
});
