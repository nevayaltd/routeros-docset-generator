#!/usr/bin/env node

/**
 * Dash Docset Generator for Terraform RouterOS Provider
 *
 * This script generates a Dash docset for the Terraform RouterOS provider documentation
 * from https://registry.terraform.io/providers/terraform-routeros/routeros/latest/docs
 */

const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const Database = require("better-sqlite3");

const BASE_URL = "https://registry.terraform.io";
const DOCS_URL =
  "https://registry.terraform.io/providers/terraform-routeros/routeros/latest/docs";
const DOCSET_NAME = "RouterOS_Terraform.docset";
const DOCSET_PATH = path.join(__dirname, DOCSET_NAME);

// Entry types mapping for Terraform resources/data sources
const ENTRY_TYPES = {
  resource: "Resource",
  data: "Source",
  guide: "Guide",
  function: "Function",
  provider: "Provider",
};

async function createDocsetStructure() {
  console.log("Creating docset structure...");

  const contentsPath = path.join(DOCSET_PATH, "Contents");
  const resourcesPath = path.join(contentsPath, "Resources");
  const documentsPath = path.join(resourcesPath, "Documents");

  await fs.ensureDir(documentsPath);

  // Create Info.plist
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>terraform-routeros</string>
  <key>CFBundleName</key>
  <string>RouterOS Terraform Provider</string>
  <key>DocSetPlatformFamily</key>
  <string>terraform</string>
  <key>isDashDocset</key>
  <true/>
  <key>dashIndexFilePath</key>
  <string>index.html</string>
  <key>DashDocSetFamily</key>
  <string>dashtoc</string>
</dict>
</plist>`;

  await fs.writeFile(path.join(contentsPath, "Info.plist"), infoPlist);

  return { contentsPath, resourcesPath, documentsPath };
}

async function initDatabase(contentsPath) {
  console.log("Initializing database...");

  const dbPath = path.join(contentsPath, "Resources", "docSet.dsidx");

  // Remove existing database if it exists
  if (await fs.pathExists(dbPath)) {
    await fs.remove(dbPath);
  }

  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);",
  );

  return db;
}

function addToIndex(db, name, type, path) {
  const stmt = db.prepare(
    "INSERT INTO searchIndex(name, type, path) VALUES (?, ?, ?)",
  );
  stmt.run(name, type, path);
}

async function scrapeDocumentation() {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  console.log("Loading documentation page...");
  await page.goto(DOCS_URL, { waitUntil: "networkidle2" });

  console.log("Waiting for page to fully load...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log("Expanding menu sections...");

  // Click on all expandable sections to reveal links
  await page.evaluate(() => {
    // Find all elements that might be expandable headers
    // Look for elements with text like "Resources", "Data Sources", etc.
    const potentialExpanders = Array.from(document.querySelectorAll('a, button, div[role="button"]'));

    potentialExpanders.forEach(element => {
      const text = element.textContent.trim().toLowerCase();
      // Click on common section headers
      if (text === 'resources' ||
          text === 'data sources' ||
          text === 'guides' ||
          text === 'functions' ||
          text.includes('resource') ||
          text.includes('data source')) {
        element.click();
      }
    });
  });

  console.log("Waiting for menu items to appear...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log("Extracting menu items...");

  // Extract all documentation links from the menu
  const docLinks = await page.evaluate(() => {
    const links = [];
    const seen = new Set();

    // Try ember-view links first (these are the menu items)
    const emberLinks = document.querySelectorAll(".menu-list-link a.ember-view");
    emberLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const text = link.textContent.trim();

      if (href && text && href.includes("/docs/") && !seen.has(href)) {
        seen.add(href);
        links.push({
          name: text,
          path: href,
          fullUrl: href.startsWith("http")
            ? href
            : window.location.origin + href,
        });
      }
    });

    // Also get any other /docs/ links we might have missed
    const allDocLinks = document.querySelectorAll("a");
    allDocLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const text = link.textContent.trim();

      if (href && text && href.includes("/docs/") && !seen.has(href)) {
        seen.add(href);
        links.push({
          name: text,
          path: href,
          fullUrl: href.startsWith("http")
            ? href
            : window.location.origin + href,
        });
      }
    });

    return links;
  });

  console.log(`Found ${docLinks.length} documentation pages`);

  await browser.close();

  return docLinks;
}

async function determineEntryType(name, urlPath) {
  // Determine the type based on the URL path or name
  if (urlPath.includes("/resources/")) {
    return ENTRY_TYPES.resource;
  } else if (urlPath.includes("/data-sources/")) {
    return ENTRY_TYPES.data;
  } else if (urlPath.includes("/guides/")) {
    return ENTRY_TYPES.guide;
  } else if (urlPath.includes("/functions/")) {
    return ENTRY_TYPES.function;
  } else if (name.toLowerCase().includes("provider")) {
    return ENTRY_TYPES.provider;
  }

  // Default to Guide for other pages
  return ENTRY_TYPES.guide;
}

async function downloadPages(docLinks, documentsPath) {
  console.log("Downloading documentation pages...");

  const browser = await puppeteer.launch({ headless: "new" });

  // Download in parallel batches
  const BATCH_SIZE = 10;
  let completed = 0;

  async function downloadPage(link) {
    const page = await browser.newPage();

    try {
      await page.goto(link.fullUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Get the page content
      const content = await page.content();

      // Create a relative path for the file
      const relativePath = link.path.replace(/^\//, "");
      const filePath = path.join(documentsPath, relativePath + ".html");

      // Ensure directory exists
      await fs.ensureDir(path.dirname(filePath));

      // Save the page
      await fs.writeFile(filePath, content);

      // Update the link with the local path
      link.localPath = relativePath + ".html";

      completed++;
      console.log(`Downloaded [${completed}/${docLinks.length}]: ${link.name}`);
    } catch (error) {
      console.error(`Error downloading ${link.name}:`, error.message);
    } finally {
      await page.close();
    }
  }

  // Process in batches
  for (let i = 0; i < docLinks.length; i += BATCH_SIZE) {
    const batch = docLinks.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(link => downloadPage(link)));
  }

  await browser.close();
}

async function buildIndex(db, docLinks) {
  console.log("Building search index...");

  for (const link of docLinks) {
    if (!link.localPath) continue;

    const entryType = await determineEntryType(link.name, link.path);

    console.log(`Indexing: ${link.name} (${entryType})`);
    addToIndex(db, link.name, entryType, link.localPath);
  }
}

function closeDatabase(db) {
  db.close();
}

async function main() {
  try {
    console.log(
      "=== Dash Docset Generator for Terraform RouterOS Provider ===\n",
    );

    // Create docset structure
    const { contentsPath, documentsPath } = await createDocsetStructure();

    // Initialize database
    const db = await initDatabase(contentsPath);

    // Scrape documentation links
    const docLinks = await scrapeDocumentation();

    // Download all pages
    await downloadPages(docLinks, documentsPath);

    // Build search index
    await buildIndex(db, docLinks);

    // Close database
    await closeDatabase(db);

    console.log("\n=== Docset generation complete! ===");
    console.log(`Docset location: ${DOCSET_PATH}`);
    console.log(`\nTo use in Dash, open: ${DOCSET_PATH}`);
  } catch (error) {
    console.error("Error generating docset:", error);
    process.exit(1);
  }
}

main();
