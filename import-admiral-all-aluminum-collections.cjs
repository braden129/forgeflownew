const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://admiral-outdoor.com';
const ALUMINUM_FILTER_URL = 'https://admiral-outdoor.com/pages/collection-filter-aluminum';

// These are the aluminum collections shown on the Admiral Outdoor aluminum collection filter page.
// Material is intentionally hardcoded to Aluminum for every product.
const COLLECTIONS = [
  { name: 'Destin II', slug: 'destin-ii' },
  { name: 'Aria', slug: 'aria' },
  { name: 'Saratoga', slug: 'saratoga' },
  { name: 'Curv', slug: 'curv' },
  { name: 'Bel Air', slug: 'bel-air' },
  { name: 'Essential', slug: 'essential' },
  { name: 'Astoria', slug: 'astoria' },
  { name: 'Luxe', slug: 'luxe' },
  { name: 'Alante', slug: 'alante' },
  { name: 'Tuscany', slug: 'tuscany' },
  { name: 'Classic', slug: 'classic' },
  { name: 'Kiawah', slug: 'kiawah' },
];

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

  text = text
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u0022/gi, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ');

  text = text.replace(/<[^>]*>/g, ' ');

  text = text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  text = text.replace(/^[:\s-]+/, '').replace(/[",]+$/g, '').trim();

  return text;
}

function cleanSpecValue(value, label) {
  let text = decodeEscapedText(value);
  if (!text) return '';

  if (label) {
    text = text.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*`, 'i'), '').trim();
  }

  // Remove website/JSON leftovers that sometimes wrap Shopify metafields.
  text = text
    .replace(/^value\s*:?\s*/i, '')
    .replace(/^custom\s*/i, '')
    .replace(/^auto\s*/i, '')
    .replace(/^tag\s*/i, '')
    .replace(/^source[-\s_]*metafield\s*/i, '')
    .replace(/^source[-\s_]*tag\s*/i, '')
    .replace(/[",;]+$/g, '')
    .trim();

  return text;
}

function getSpecFromVisiblePage($, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  let found = '';

  $('tr, .specs-table-row, .product__info-container div, li, p, div').each((_, el) => {
    if (found) return;

    const clean = decodeEscapedText($(el).text());
    const lower = clean.toLowerCase();

    for (const label of labelList) {
      const labelLower = label.toLowerCase();
      if (lower.includes(labelLower)) {
        let value = clean.replace(new RegExp(label, 'i'), '').replace(/^[:\s-]+/, '').trim();
        value = cleanSpecValue(value, label);

        if (value && value.toLowerCase() !== labelLower && !value.toLowerCase().includes('specs-table')) {
          found = value;
          return;
        }
      }
    }
  });

  return found;
}

function findEmbeddedSpec(html, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];

  for (const label of labelList) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const regexes = [
      new RegExp(`${escapedLabel}[\\s\\S]{0,500}?class=\\\\?"specs-table-value[^>]*>([\\s\\S]*?)<\\/td>`, 'i'),
      new RegExp(`${escapedLabel}[\\s\\S]{0,500}?\\\\u003e([^<]*?)\\\\u003c`, 'i'),
      new RegExp(`${escapedLabel}[\\s\\S]{0,250}?value\\\\?"?\\s*[:=]\\s*\\\\?"([^"\\n<]+)`, 'i'),
    ];

    for (const regex of regexes) {
      const match = html.match(regex);
      if (match && match[1]) {
        const cleaned = cleanSpecValue(match[1], label);
        if (cleaned && !cleaned.toLowerCase().includes('specs-table')) return cleaned;
      }
    }
  }

  return '';
}

function getSkuFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const script of scripts) {
    const text = $(script).contents().text();
    if (!text) continue;

    try {
      const parsed = JSON.parse(text);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of candidates) {
        if (item && item.sku) return decodeEscapedText(item.sku);
        if (item && item.offers && item.offers.sku) return decodeEscapedText(item.offers.sku);
      }
    } catch (_) {}
  }

  return '';
}

function normalizeSpecs($, html) {
  return {
    sku:
      cleanSpecValue(getSkuFromJsonLd($), 'SKU') ||
      cleanSpecValue(getSpecFromVisiblePage($, ['SKU', 'Sku']), 'SKU') ||
      cleanSpecValue(findEmbeddedSpec(html, ['SKU', 'Sku']), 'SKU'),
    dimensions:
      cleanSpecValue(getSpecFromVisiblePage($, ['Dimensions', 'Dimension']), 'Dimensions') ||
      cleanSpecValue(findEmbeddedSpec(html, ['Dimensions', 'Dimension']), 'Dimensions'),
    seatHeight:
      cleanSpecValue(getSpecFromVisiblePage($, ['Seat Height']), 'Seat Height') ||
      cleanSpecValue(findEmbeddedSpec(html, ['Seat Height']), 'Seat Height'),
    seatWidth:
      cleanSpecValue(getSpecFromVisiblePage($, ['Seat Width']), 'Seat Width') ||
      cleanSpecValue(findEmbeddedSpec(html, ['Seat Width']), 'Seat Width'),
    seatDepth:
      cleanSpecValue(getSpecFromVisiblePage($, ['Seat Depth']), 'Seat Depth') ||
      cleanSpecValue(findEmbeddedSpec(html, ['Seat Depth']), 'Seat Depth'),
    stackable:
      cleanSpecValue(getSpecFromVisiblePage($, ['Stackable']), 'Stackable') ||
      cleanSpecValue(findEmbeddedSpec(html, ['Stackable']), 'Stackable'),
    material: 'Aluminum',
  };
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 30000,
  });

  return data;
}

async function getProductLinksForCollection(collection) {
  const url = `${BASE_URL}/collections/${collection.slug}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const links = new Set();

  $(`a[href*="/collections/${collection.slug}/products/"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.add(absoluteUrl(href.split('?')[0]));
  });

  // Fallback: sometimes Shopify links products without the collection slug.
  if (links.size === 0) {
    $('a[href*="/products/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) links.add(absoluteUrl(href.split('?')[0]));
    });
  }

  return [...links];
}

async function scrapeProduct(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let name = decodeEscapedText($('h1').first().text());
  if (!name) name = decodeEscapedText($('meta[property="og:title"]').attr('content'));
  if (!name) name = decodeEscapedText($('title').text()).replace(/– Admiral Outdoor/i, '').trim();

  let image = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
  image = absoluteUrl(image);

  return {
    id: makeId(),
    name,
    image,
    parts: [],
    specs: normalizeSpecs($, html),
    sourceUrl: url,
  };
}

async function main() {
  console.log('Starting Admiral Outdoor aluminum collection import...');
  console.log(`Source: ${ALUMINUM_FILTER_URL}`);
  console.log(`Collections to import: ${COLLECTIONS.length}`);

  const models = [];
  const seenProducts = new Set();

  for (const collection of COLLECTIONS) {
    console.log(`\nScanning collection: ${collection.name}`);

    let links = [];

    try {
      links = await getProductLinksForCollection(collection);
    } catch (error) {
      console.log(`  Could not scan ${collection.name}: ${error.message}`);
      continue;
    }

    console.log(`  Found ${links.length} product links.`);

    const types = [];

    for (const link of links) {
      const productKey = link.replace(/\/$/, '');
      if (seenProducts.has(`${collection.slug}|${productKey}`)) continue;
      seenProducts.add(`${collection.slug}|${productKey}`);

      try {
        console.log(`  Importing: ${link}`);
        const product = await scrapeProduct(link);
        if (product.name) types.push(product);
      } catch (error) {
        console.log(`  Failed product: ${link}`);
        console.log(`  ${error.message}`);
      }
    }

    models.push({
      id: makeId(),
      name: collection.name,
      types,
    });
  }

  const backup = {
    appName: 'Admiral Outdoor Production App',
    exportedAt: new Date().toISOString(),
    sourceUrl: ALUMINUM_FILTER_URL,
    models,
    schedule: [],
    liveJobs: [],
    scheduleWeeks: ['Week of', 'Week of', 'Week of', 'Week of', 'Week of'],
  };

  const outputFile = 'admiral-all-aluminum-collections-import.json';
  fs.writeFileSync(outputFile, JSON.stringify(backup, null, 2));

  const totalProducts = models.reduce((sum, model) => sum + model.types.length, 0);

  console.log('\nDone.');
  console.log(`Imported collections: ${models.length}`);
  console.log(`Imported furniture pieces: ${totalProducts}`);
  console.log(`Created file: ${outputFile}`);
  console.log('\nBefore importing into the app, click Export Backup first.');
}

main().catch((error) => {
  console.error('Import failed:');
  console.error(error.message);
  process.exit(1);
});
