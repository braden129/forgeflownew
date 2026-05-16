/*
  Admiral Outdoor - STRICT 12 aluminum collection importer CLEAN SPECS

  What this does:
  - Imports ONLY the 12 intended aluminum collections.
  - Hardcodes Material as "Aluminum" for every furniture item.
  - Adds slow delays and retries to avoid 429 rate-limit errors.
  - Creates a JSON file that can be loaded with your app's Import Backup button.

  Run:
    node import-admiral-all-aluminum-collections-strict-12.cjs

  Output:
    admiral-all-aluminum-collections-clean-specs-import.json
*/

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://admiral-outdoor.com";
const OUTPUT_FILE = "admiral-all-aluminum-collections-clean-specs-import.json";

const COLLECTIONS = [
  { name: "Destin II", slug: "destin-ii" },
  { name: "Aria", slug: "aria-1" },
  { name: "Saratoga", slug: "saratoga" },
  { name: "Curv", slug: "curv" },
  { name: "Bel Air", slug: "bel-air" },
  { name: "Essential", slug: "essential" },
  { name: "Astoria", slug: "astoria" },
  { name: "Luxe", slug: "luxe" },
  { name: "Alante", slug: "alante" },
  { name: "Tuscany", slug: "tuscany" },
  { name: "Classic", slug: "classic" },
  { name: "Kiawah", slug: "kiawah" },
];

function makeId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `${BASE_URL}${url}`;
  return `${BASE_URL}/${url}`;
}

async function fetchHtml(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    return response.data;
  } catch (error) {
    const status = error?.response?.status;

    if ((status === 429 || status === 503 || status === 502) && attempt < 5) {
      const waitMs = 8000 * attempt;
      console.log(`    Rate limited / temporary error (${status}). Waiting ${waitMs / 1000}s then retrying...`);
      await sleep(waitMs);
      return fetchHtml(url, attempt + 1);
    }

    throw error;
  }
}

function getProductLinksFromCollectionHtml(html, collectionSlug) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href*="/products/"]').each((_, element) => {
    const href = $(element).attr("href") || "";
    if (!href.includes("/products/")) return;
    if (href.includes("#")) return;

    // Keep product links for this collection, but allow all-products fallbacks if a site card uses that path.
    if (
      href.includes(`/collections/${collectionSlug}/products/`) ||
      href.includes(`/collections/all-products/products/`) ||
      href.startsWith("/products/")
    ) {
      const cleanHref = href.split("?")[0].split("#")[0];
      links.add(absoluteUrl(cleanHref));
    }
  });

  return [...links];
}

async function getAllProductLinksForCollection(collection) {
  const allLinks = new Set();
  let emptyPagesInRow = 0;

  for (let page = 1; page <= 6; page++) {
    const url = `${BASE_URL}/collections/${collection.slug}${page === 1 ? "" : `?page=${page}`}`;

    try {
      const html = await fetchHtml(url);
      const links = getProductLinksFromCollectionHtml(html, collection.slug);

      links.forEach((link) => allLinks.add(link));

      if (links.length === 0) emptyPagesInRow += 1;
      else emptyPagesInRow = 0;

      if (page === 1) {
        console.log(`  Found ${links.length} product links on first page.`);
      } else if (links.length > 0) {
        console.log(`  Found ${links.length} more product links on page ${page}.`);
      }

      if (emptyPagesInRow >= 2) break;

      await sleep(1200);
    } catch (error) {
      console.log(`  Could not scan page ${page} for ${collection.name}: ${error.message}`);
      break;
    }
  }

  return [...allLinks];
}

function getMetaContent($, selector) {
  return cleanText($(selector).attr("content") || "");
}

const SPEC_LABELS = [
  "SKU",
  "Material",
  "Dimensions",
  "Dimension",
  "Total Weight",
  "Seat Height",
  "Seat Depth",
  "Seat Width",
  "Arm Height",
  "Back Height",
  "Base",
  "Stackable",
];

function normalizeLabel(value) {
  return cleanText(value)
    .replace(/:$/, "")
    .toLowerCase();
}

function looksLikeBadSpecValue(value) {
  const text = cleanText(value);
  if (!text) return true;

  // This catches the bad values like:
  // ","Arm Height","Back Height","Base
  if (text.includes('","') || text.includes("','") || text.startsWith('",')) return true;

  // If a value contains several other spec labels, it probably came from website JS/CSV text.
  const labelHits = SPEC_LABELS.filter((label) =>
    new RegExp(`\\b${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(text)
  ).length;

  if (labelHits >= 2) return true;

  return false;
}

function getVisibleTextChunks($) {
  const clone = cheerio.load($.html());

  // Remove JavaScript/style content so we do not accidentally read product-table code.
  clone("script, style, noscript, svg").remove();

  const chunks = [];

  clone("body")
    .find("*")
    .contents()
    .each((_, node) => {
      if (node.type !== "text") return;

      const parentName = node.parent?.name || "";
      if (["script", "style", "noscript", "svg"].includes(parentName)) return;

      const text = cleanText(node.data || "");
      if (text) chunks.push(text);
    });

  return chunks;
}

function findSpecValue($, labels) {
  const wanted = labels.map(normalizeLabel);

  // 1) Look through real table rows first.
  let value = "";
  $("tr").each((_, row) => {
    if (value) return;

    const cells = $(row)
      .find("th, td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);

    if (cells.length >= 2) {
      const label = normalizeLabel(cells[0]);
      const candidate = cleanText(cells[1]);

      if (wanted.includes(label) && !looksLikeBadSpecValue(candidate)) {
        value = candidate;
      }
    }
  });

  if (value) return value;

  // 2) Look through visible text chunks. This avoids script/CSV data.
  const chunks = getVisibleTextChunks($);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const normalizedChunk = normalizeLabel(chunk);

    // Case A: separate label and value chunks, like: ["Seat Height", "16.00\""]
    if (wanted.includes(normalizedChunk)) {
      for (let j = i + 1; j < Math.min(i + 6, chunks.length); j++) {
        const candidate = cleanText(chunks[j]);
        const candidateAsLabel = normalizeLabel(candidate);

        if (SPEC_LABELS.map(normalizeLabel).includes(candidateAsLabel)) break;
        if (!looksLikeBadSpecValue(candidate)) return candidate;
      }
    }

    // Case B: one chunk contains both, like: "Seat Height: 16.00\""
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = chunk.match(new RegExp(`^${escaped}\\s*:?\\s*(.+)$`, "i"));

      if (match && match[1] && !looksLikeBadSpecValue(match[1])) {
        return cleanText(match[1]);
      }
    }
  }

  return "";
}

function parseProductJsonLd($) {
  let product = null;

  $('script[type="application/ld+json"]').each((_, script) => {
    if (product) return;

    const raw = $(script).contents().text();
    if (!raw) return;

    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      product = items.find((item) => item && item["@type"] === "Product") || null;
    } catch (_) {
      // ignore malformed json-ld blocks
    }
  });

  return product || {};
}

async function scrapeProduct(productUrl, collectionName) {
  const html = await fetchHtml(productUrl);
  const $ = cheerio.load(html);
  const jsonLd = parseProductJsonLd($);

  const title =
    cleanText(jsonLd.name) ||
    cleanText($("h1").first().text()) ||
    cleanText($("title").text()).replace(/\s*[-–|]\s*Admiral Outdoor.*/i, "");

  let image = "";
  if (Array.isArray(jsonLd.image) && jsonLd.image[0]) image = absoluteUrl(jsonLd.image[0]);
  else if (typeof jsonLd.image === "string") image = absoluteUrl(jsonLd.image);
  else image = absoluteUrl(getMetaContent($, 'meta[property="og:image"]'));

  const sku =
    cleanText(jsonLd.sku) ||
    findSpecValue($, ["SKU", "Sku", "Item", "Item #", "Product Code"]);

  const specs = {
    sku,
    dimensions: findSpecValue($, ["Dimensions", "Dimension"]),
    seatHeight: findSpecValue($, ["Seat Height"]),
    seatWidth: findSpecValue($, ["Seat Width"]),
    seatDepth: findSpecValue($, ["Seat Depth"]),
    stackable: findSpecValue($, ["Stackable"]),
    material: "Aluminum",
    sourceUrl: productUrl,
  };

  return {
    id: makeId("type"),
    name: title || "Unnamed Furniture",
    image,
    specs,
    parts: [],
  };
}

async function main() {
  console.log("Starting Admiral Outdoor STRICT 12 aluminum collection import...");
  console.log("Collections to import:", COLLECTIONS.length);
  console.log("This version is intentionally slow to avoid 429 rate limits.\n");

  const models = [];
  const failedProducts = [];
  const failedCollections = [];

  for (const collection of COLLECTIONS) {
    console.log(`Scanning collection: ${collection.name}`);

    const productLinks = await getAllProductLinksForCollection(collection);

    if (productLinks.length === 0) {
      failedCollections.push(collection.name);
      console.log(`  No product links found for ${collection.name}.`);
      console.log("");
      await sleep(4000);
      continue;
    }

    const types = [];

    for (let index = 0; index < productLinks.length; index++) {
      const productUrl = productLinks[index];
      console.log(`  Importing ${index + 1}/${productLinks.length}: ${productUrl}`);

      try {
        const item = await scrapeProduct(productUrl, collection.name);
        types.push(item);
      } catch (error) {
        console.log(`    Failed product: ${productUrl}`);
        console.log(`    ${error.message}`);
        failedProducts.push({ collection: collection.name, url: productUrl, error: error.message });
      }

      // Slow down between products. This is what prevents most 429 errors.
      await sleep(3500);
    }

    models.push({
      id: makeId("model"),
      name: collection.name,
      types,
    });

    console.log(`  Finished ${collection.name}: ${types.length}/${productLinks.length} imported.`);
    console.log("");

    await sleep(6000);
  }

  const backup = {
    appName: "Admiral Outdoor Production App",
    backupVersion: 2,
    exportedAt: new Date().toISOString(),
    source: "Admiral Outdoor strict 12 aluminum collections importer",
    models,
    schedule: [],
    liveJobs: [],
    scheduleWeeks: ["Week of", "Week of", "Week of", "Week of", "Week of"],
    importReport: {
      intendedCollections: COLLECTIONS.map((item) => item.name),
      importedCollections: models.length,
      importedFurniturePieces: models.reduce((sum, model) => sum + model.types.length, 0),
      failedCollections,
      failedProducts,
    },
  };

  fs.writeFileSync(path.join(process.cwd(), OUTPUT_FILE), JSON.stringify(backup, null, 2));

  console.log("Done.");
  console.log(`Imported collections: ${backup.importReport.importedCollections}`);
  console.log(`Imported furniture pieces: ${backup.importReport.importedFurniturePieces}`);
  console.log(`Failed collections: ${failedCollections.length}`);
  console.log(`Failed products: ${failedProducts.length}`);
  console.log(`Created file: ${OUTPUT_FILE}`);
  console.log("\nBefore importing into the app, click Export Backup first.");
}

main().catch((error) => {
  console.error("Importer crashed:", error.message);
  process.exit(1);
});
