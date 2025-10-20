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

async function initDatabase(resourcesPath) {
  console.log("Initializing database...");

  const dbPath = path.join(resourcesPath, "docSet.dsidx");

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

  // Filter out external URLs (only keep paths that start with /providers/)
  const filteredLinks = docLinks.filter(link => {
    const isInternal = link.path.startsWith('/providers/terraform-routeros/routeros');
    if (!isInternal) {
      console.log(`Skipping external link: ${link.name} (${link.path})`);
    }
    return isInternal;
  });

  console.log(`Filtered to ${filteredLinks.length} internal documentation pages`);

  return filteredLinks;
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

      // Wait for the documentation content to be rendered
      try {
        await page.waitForSelector('article', { timeout: 10000 });
      } catch (e) {
        console.error(`Timeout waiting for content on ${link.name}`);
      }

      // Extract just the documentation content and sections
      const docContent = await page.evaluate(() => {
        const article = document.querySelector('article');
        const markdown = document.querySelector('.markdown, #provider-doc');

        // Get the main content
        let content = '';
        if (markdown) {
          content = markdown.innerHTML;
        } else if (article) {
          content = article.innerHTML;
        }

        // Get the page title
        const title = document.title.split('|')[0].trim();

        // Get any stylesheets we need
        const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
          .map(link => link.outerHTML)
          .join('\n');

        // Extract sections (h2 and h3 headings with IDs)
        const sections = [];
        const contentContainer = markdown || article;
        if (contentContainer) {
          const headings = contentContainer.querySelectorAll('h2[id], h3[id]');
          headings.forEach(heading => {
            const id = heading.getAttribute('id');
            let text = heading.textContent.trim();
            const level = heading.tagName.toLowerCase(); // h2 or h3

            // Clean up text - remove leading # symbols and extra whitespace
            text = text.replace(/^#+\s*/, '').trim();

            if (id && text) {
              sections.push({ id, text, level });
            }
          });
        }

        return { content, title, styles, sections };
      });

      // Create a standalone HTML document with the extracted content
      const htmlDocument = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${docContent.title}</title>
  ${docContent.styles}
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding: 20px;
      max-width: 980px;
      margin: 0 auto;
    }
    pre {
      background-color: #f6f8fa;
      padding: 16px;
      overflow: auto;
      border-radius: 6px;
    }
    code {
      background-color: #f6f8fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    }
    pre code {
      background-color: transparent;
      padding: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
    }
    a {
      color: #0969da;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  ${docContent.content}
</body>
</html>`;

      // Create a relative path for the file
      const relativePath = link.path.replace(/^\//, "");
      const filePath = path.join(documentsPath, relativePath + ".html");

      // Ensure directory exists
      await fs.ensureDir(path.dirname(filePath));

      // Save the page
      await fs.writeFile(filePath, htmlDocument);

      // Update the link with the local path and sections
      link.localPath = relativePath + ".html";
      link.sections = docContent.sections;

      completed++;
      console.log(`Downloaded [${completed}/${docLinks.length}]: ${link.name} (${docContent.sections.length} sections)`);
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

async function createIndexPage(documentsPath, docLinks) {
  console.log("Creating index page...");

  // Group links by type
  const grouped = {
    resources: [],
    dataSources: [],
    guides: [],
    functions: [],
  };

  for (const link of docLinks) {
    if (!link.localPath) continue;

    if (link.path.includes("/resources/")) {
      grouped.resources.push(link);
    } else if (link.path.includes("/data-sources/")) {
      grouped.dataSources.push(link);
    } else if (link.path.includes("/guides/")) {
      grouped.guides.push(link);
    } else if (link.path.includes("/functions/")) {
      grouped.functions.push(link);
    }
  }

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>RouterOS Terraform Provider Documentation</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding: 20px;
      max-width: 980px;
      margin: 0 auto;
    }
    h1 {
      border-bottom: 2px solid #e1e4e8;
      padding-bottom: 10px;
    }
    h2 {
      margin-top: 30px;
      color: #24292e;
    }
    ul {
      list-style: none;
      padding-left: 0;
    }
    li {
      padding: 5px 0;
    }
    a {
      color: #0969da;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .section {
      margin-bottom: 40px;
    }
  </style>
</head>
<body>
  <h1>RouterOS Terraform Provider Documentation</h1>
  <p>Offline documentation for the Terraform RouterOS Provider</p>

  ${grouped.guides.length > 0 ? `
  <div class="section">
    <h2>Guides</h2>
    <ul>
      ${grouped.guides.map(link => `<li><a href="${link.localPath}">${link.name}</a></li>`).join('\n      ')}
    </ul>
  </div>
  ` : ''}

  ${grouped.resources.length > 0 ? `
  <div class="section">
    <h2>Resources</h2>
    <ul>
      ${grouped.resources.map(link => `<li><a href="${link.localPath}">${link.name}</a></li>`).join('\n      ')}
    </ul>
  </div>
  ` : ''}

  ${grouped.dataSources.length > 0 ? `
  <div class="section">
    <h2>Data Sources</h2>
    <ul>
      ${grouped.dataSources.map(link => `<li><a href="${link.localPath}">${link.name}</a></li>`).join('\n      ')}
    </ul>
  </div>
  ` : ''}

  ${grouped.functions.length > 0 ? `
  <div class="section">
    <h2>Functions</h2>
    <ul>
      ${grouped.functions.map(link => `<li><a href="${link.localPath}">${link.name}</a></li>`).join('\n      ')}
    </ul>
  </div>
  ` : ''}
</body>
</html>`;

  const indexPath = path.join(documentsPath, "index.html");
  await fs.writeFile(indexPath, indexHtml);
  console.log("Created index.html");
}

async function buildIndex(db, docLinks) {
  console.log("Building search index...");

  for (const link of docLinks) {
    if (!link.localPath) continue;

    const entryType = await determineEntryType(link.name, link.path);

    // Add the main page entry
    console.log(`Indexing: ${link.name} (${entryType})`);
    addToIndex(db, link.name, entryType, link.localPath);

    // Add section entries
    if (link.sections && link.sections.length > 0) {
      for (const section of link.sections) {
        // Use 'Section' type for h2 headings, 'Entry' for h3
        const sectionType = section.level === 'h2' ? 'Section' : 'Entry';
        const sectionPath = `${link.localPath}#${section.id}`;

        console.log(`  - ${section.text} (${sectionType})`);
        addToIndex(db, section.text, sectionType, sectionPath);
      }
    }
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
    const { contentsPath, resourcesPath, documentsPath } = await createDocsetStructure();

    // Initialize database
    const db = await initDatabase(resourcesPath);

    // Scrape documentation links
    const docLinks = await scrapeDocumentation();

    // Download all pages
    await downloadPages(docLinks, documentsPath);

    // Create index page
    await createIndexPage(documentsPath, docLinks);

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
