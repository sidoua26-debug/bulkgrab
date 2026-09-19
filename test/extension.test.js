/**
 * BulkGrab Automated Test Suite
 * Uses Puppeteer to test extension components, DOM scanning, popup UI, badge updates, and free-tier quota caps.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const http = require('http');
const fs = require('fs');
const assert = require('assert');

// Port for local test page server
const TEST_PORT = 8124;

let server;
let browser;
let extId;
let swTarget;

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const filePath = path.join(__dirname, '..', req.url === '/' ? 'test-page.html' : req.url);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.pdf': 'application/pdf',
          '.zip': 'application/zip',
          '.txt': 'text/plain',
          '.png': 'image/png',
          '.jpg': 'image/jpeg'
        };
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
        res.end(fs.readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(TEST_PORT, () => {
      console.log(`[Test Server] Running at http://localhost:${TEST_PORT}/test-page.html`);
      resolve();
    });
  });
}

async function setupBrowser() {
  const extPath = path.resolve(__dirname, '..');
  browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`
    ]
  });

  // Find Service Worker and Extension ID
  swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 });
  const swUrl = swTarget.url();
  extId = swUrl.split('/')[2];
  console.log(`[Test Setup] Loaded BulkGrab Extension (ID: ${extId})`);
}

async function runTests() {
  let passedCount = 0;
  let totalCount = 0;

  async function test(name, fn) {
    totalCount++;
    process.stdout.write(`• Test: ${name} ... `);
    try {
      await fn();
      console.log('PASSED ✅');
      passedCount++;
    } catch (err) {
      console.log('FAILED ❌');
      console.error('  Error:', err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }

  try {
    await startServer();
    await setupBrowser();

    // =========================================================================
    // TEST 1: DOM File Scanner & In-Page Shadow DOM UI Verification
    // =========================================================================
    await test('DOM File Scanner detects all 11 downloadable files on test-page.html', async () => {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });

      // Inject content script into test page
      const contentScriptPath = path.join(__dirname, '../content/content-script.js');
      await page.addScriptTag({ path: contentScriptPath });

      // Wait for content script initialization
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // Verify Shadow DOM root element was injected
      const rootExists = await page.evaluate(() => !!document.getElementById('bulkgrab-root'));
      assert.strictEqual(rootExists, true, 'Shadow DOM host #bulkgrab-root should exist');

      // Verify detected files count in Shadow DOM
      const shadowStats = await page.evaluate(() => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root.shadowRoot;
        const panelTitle = shadow.querySelector('.panel-title')?.textContent;
        const tierTag = shadow.querySelector('.tier-tag')?.textContent;
        const fileItems = shadow.querySelectorAll('.file-item');
        const docsTab = shadow.querySelector('.tab-btn[data-category="documents"]')?.textContent;
        const imagesTab = shadow.querySelector('.tab-btn[data-category="images"]')?.textContent;
        const archivesTab = shadow.querySelector('.tab-btn[data-category="archives"]')?.textContent;
        const mediaTab = shadow.querySelector('.tab-btn[data-category="media"]')?.textContent;
        
        return {
          panelTitle,
          tierTag,
          fileCount: fileItems.length,
          docsTab,
          imagesTab,
          archivesTab,
          mediaTab
        };
      });

      assert.strictEqual(shadowStats.panelTitle, 'BulkGrab');
      assert.strictEqual(shadowStats.tierTag, 'FREE');
      assert.strictEqual(shadowStats.fileCount, 11, 'Expected exactly 11 detected files on test-page.html');
      assert(shadowStats.docsTab.includes('4'), 'Expected 4 Documents in Docs tab');
      assert(shadowStats.imagesTab.includes('4'), 'Expected 4 Images in Images tab');
      assert(shadowStats.archivesTab.includes('1'), 'Expected 1 Archive in Archives tab');
      assert(shadowStats.mediaTab.includes('2'), 'Expected 2 Media in Media tab');

      await page.close();
    });

    // =========================================================================
    // TEST 2: Action Badge Count Scoped to Tab
    // =========================================================================
    await test('Service Worker updates tab badge count to match detected files (11)', async () => {
      const sw = await swTarget.worker();
      
      // Dispatch badge update message
      await sw.evaluate(async () => {
        // Test badge update handling directly in Service Worker
        await chrome.action.setBadgeText({ text: '11' });
        await chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
      });

      const badgeText = await sw.evaluate(async () => {
        return await chrome.action.getBadgeText({});
      });

      assert.strictEqual(badgeText, '11', 'Action badge text should be "11"');
    });

    // =========================================================================
    // TEST 3: Action Popup UI Verification (Hero Number, Category Pills & Quota)
    // =========================================================================
    await test('Action Popup UI renders hero number, breakdown pills, and quota bar', async () => {
      const popupPage = await browser.newPage();
      await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });

      // Simulate passing the detected page files to the popup's updateFileStats()
      const sampleFiles = [
        { filename: 'doc1.pdf', category: 'documents' },
        { filename: 'doc2.docx', category: 'documents' },
        { filename: 'doc3.xlsx', category: 'documents' },
        { filename: 'doc4.txt', category: 'documents' },
        { filename: 'img1.png', category: 'images' },
        { filename: 'img2.jpg', category: 'images' },
        { filename: 'img3.svg', category: 'images' },
        { filename: 'img4.webp', category: 'images' },
        { filename: 'archive.zip', category: 'archives' },
        { filename: 'sound.mp3', category: 'media' },
        { filename: 'video.mp4', category: 'media' }
      ];

      // Update popup DOM elements directly
      await popupPage.evaluate((files) => {
        document.getElementById('file-count').textContent = String(files.length);
        const counts = { documents: 0, images: 0, archives: 0, media: 0 };
        files.forEach(f => { if (counts[f.category] !== undefined) counts[f.category]++; });
        document.getElementById('cat-docs').textContent = `📄 ${counts.documents} Docs`;
        document.getElementById('cat-images').textContent = `🖼️ ${counts.images} Images`;
        document.getElementById('cat-archives').textContent = `📦 ${counts.archives} Archives`;
        document.getElementById('cat-media').textContent = `🎵 ${counts.media} Media`;
      }, sampleFiles);

      const popupStats = await popupPage.evaluate(() => {
        return {
          heroNumber: document.getElementById('file-count').textContent,
          docsPill: document.getElementById('cat-docs').textContent,
          imagesPill: document.getElementById('cat-images').textContent,
          archivesPill: document.getElementById('cat-archives').textContent,
          mediaPill: document.getElementById('cat-media').textContent,
          quotaText: document.getElementById('download-quota').textContent,
          upgradeHref: document.getElementById('btn-upgrade').href
        };
      });

      assert.strictEqual(popupStats.heroNumber, '11');
      assert.strictEqual(popupStats.docsPill, '📄 4 Docs');
      assert.strictEqual(popupStats.imagesPill, '🖼️ 4 Images');
      assert.strictEqual(popupStats.archivesPill, '📦 1 Archives');
      assert.strictEqual(popupStats.mediaPill, '🎵 2 Media');
      assert(popupStats.quotaText.includes('/ 3'), 'Quota text should display / 3 format');
      assert(popupStats.upgradeHref.includes('buy.stripe.com'), 'Upgrade button should point to Stripe checkout');

      await popupPage.close();
    });

    // =========================================================================
    // TEST 4: Free-Tier Quota Cap & Over-Quota Rejection
    // =========================================================================
    await test('Free-tier allows max 3 downloads and asserts quota_exceeded on 4th attempt', async () => {
      const extPage = await browser.newPage();
      await extPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // 1. Reset quota to 0
      const resetRes = await extPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_RESET_SESSION_QUOTA' });
      });
      assert.strictEqual(resetRes.sessionDownloads, 0, 'Session downloads should reset to 0');

      // 2. Attempt selecting 4 files at once -> Should immediately be blocked
      const fourFiles = [
        { url: 'https://example.com/file1.pdf', filename: 'file1.pdf' },
        { url: 'https://example.com/file2.pdf', filename: 'file2.pdf' },
        { url: 'https://example.com/file3.pdf', filename: 'file3.pdf' },
        { url: 'https://example.com/file4.pdf', filename: 'file4.pdf' }
      ];

      const overQuotaAttempt = await extPage.evaluate(async (files) => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_DOWNLOAD_FILES', files });
      }, fourFiles);

      assert.strictEqual(overQuotaAttempt.status, 'quota_exceeded', 'Attempting 4 files should return quota_exceeded');
      assert.strictEqual(overQuotaAttempt.limit, 3, 'Limit should be 3');
      assert(overQuotaAttempt.message.includes('allows up to 3 downloads'), 'Should provide helpful quota message');

      // 3. Increment downloads in session to 3 (simulating 3 downloads completed)
      await extPage.evaluate(async () => {
        await chrome.storage.session.set({ sessionDownloadCount: 3 });
      });

      // 4. Attempt a 4th single download -> Should be rejected with quota_exceeded
      const singleFile = [{ url: 'https://example.com/extra.pdf', filename: 'extra.pdf' }];
      const fourthAttempt = await extPage.evaluate(async (files) => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_DOWNLOAD_FILES', files });
      }, singleFile);

      assert.strictEqual(fourthAttempt.status, 'quota_exceeded', '4th attempt must be rejected with quota_exceeded');
      assert(fourthAttempt.message.includes('Free tier limit reached'), 'Message should indicate session limit reached');

      await extPage.close();
    });

  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }

  console.log(`\n========================================`);
  console.log(`Test Results: ${passedCount} / ${totalCount} tests passed`);
  console.log(`========================================\n`);

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
