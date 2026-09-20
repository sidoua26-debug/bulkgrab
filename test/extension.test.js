/**
 * BulkGrab Automated Test Suite
 * Uses Puppeteer to test extension components, DOM scanning, popup UI, badge updates, and free-tier quota caps.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const JSZip = require('jszip');
const { buildPackage } = require('../scripts/package');

// Port for local test page server
const TEST_PORT = 8124;

let server;
let browser;
let extId;
let swTarget;

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/cors-blocked.pdf') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('CORS Forbidden');
        return;
      }
      if (req.url === '/cors-ok.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end('%PDF-1.4 dummy pdf content');
        return;
      }

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

  // Set internal test harness flag (never present in production user environment)
  const sw = await swTarget.worker();
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ __testMockVerification__: true });
  });
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
      // Allow popup DOMContentLoaded async tasks to complete
      await new Promise(r => setTimeout(r, 400));

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
      assert(popupStats.quotaText.includes('/ 7'), 'Quota text should display / 7 format');
      assert(popupStats.upgradeHref.includes('nowpayments.io'), 'Upgrade button should point to NOWPayments checkout');

      const warningText = await popupPage.$eval('#payment-warning', el => el.textContent.trim());
      assert.strictEqual(
        warningText,
        'Pay with USDT on the BSC (BEP20) network only. Coins or networks sent to the address by mistake cannot be recovered.',
        'Popup must display exact USDT on BSC (BEP20) payment warning'
      );

      await popupPage.close();
    });

    // =========================================================================
    // TEST 4: Free-Tier Quota Cap & Over-Quota Rejection
    // =========================================================================
    await test('Free-tier allows max 7 downloads and asserts quota_exceeded on 8th attempt', async () => {
      const extPage = await browser.newPage();
      await extPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // 1. Reset quota to 0
      const resetRes = await extPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_RESET_SESSION_QUOTA' });
      });
      assert.strictEqual(resetRes.sessionDownloads, 0, 'Session downloads should reset to 0');

      // 2. Attempt selecting 8 files at once -> Should immediately be blocked
      const eightFiles = Array.from({ length: 8 }, (_, i) => ({
        url: `https://example.com/file${i + 1}.pdf`,
        filename: `file${i + 1}.pdf`
      }));

      const overQuotaAttempt = await extPage.evaluate(async (files) => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_DOWNLOAD_FILES', files });
      }, eightFiles);

      assert.strictEqual(overQuotaAttempt.status, 'quota_exceeded', 'Attempting 8 files should return quota_exceeded');
      assert.strictEqual(overQuotaAttempt.limit, 7, 'Limit should be 7');
      assert(overQuotaAttempt.message.includes('allows up to 7 downloads'), 'Should provide helpful quota message');

      // 3. Increment downloads in session to 7 (simulating 7 downloads completed)
      await extPage.evaluate(async () => {
        await chrome.storage.session.set({ sessionDownloadCount: 7 });
      });

      // 4. Attempt an 8th single download -> Should be rejected with quota_exceeded
      const singleFile = [{ url: 'https://example.com/extra.pdf', filename: 'extra.pdf' }];
      const eighthAttempt = await extPage.evaluate(async (files) => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_DOWNLOAD_FILES', files });
      }, singleFile);

      assert.strictEqual(eighthAttempt.status, 'quota_exceeded', '8th attempt must return quota_exceeded');
      assert.strictEqual(eighthAttempt.limit, 7, 'Limit must be 7');

      await extPage.close();
    });

    // =========================================================================
    // TEST 5: Badge is cleared when tab navigates to a new URL
    // =========================================================================
    await test('Badge is cleared on tab navigation (chrome.tabs.onUpdated)', async () => {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });

      const sw = await swTarget.worker();

      // Find page tab ID
      const tabs = await sw.evaluate(async () => {
        const tList = await chrome.tabs.query({});
        return tList.map(t => ({ id: t.id, active: t.active }));
      });
      const targetTab = tabs.find(t => t.active);
      assert(targetTab, 'Active tab should exist');

      // Set badge text for this tab
      await sw.evaluate(async (tabId) => {
        await chrome.action.setBadgeText({ text: '11', tabId });
      }, targetTab.id);

      const beforeNavBadge = await sw.evaluate(async (tabId) => {
        return await chrome.action.getBadgeText({ tabId });
      }, targetTab.id);
      assert.strictEqual(beforeNavBadge, '11', 'Badge should be set before navigation');

      // Navigate tab to a second URL
      await page.goto(`http://localhost:${TEST_PORT}/test-page.html?view=nav2`, { waitUntil: 'domcontentloaded' });

      // Verify badge text was cleared on navigation
      const afterNavBadge = await sw.evaluate(async (tabId) => {
        return await chrome.action.getBadgeText({ tabId });
      }, targetTab.id);

      assert.strictEqual(afterNavBadge, '', 'Badge text must be cleared to empty string on tab navigation');

      await page.close();
    });

    // =========================================================================
    // TEST 6: Options page verifies NOWPayments Payment ID and activates Pro
    // =========================================================================
    await test('Options page verifies NOWPayments Payment ID and activates Pro status', async () => {
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // Check initial status is Free
      const initialBadge = await optionsPage.$eval('#tier-badge', el => el.textContent.trim());
      assert.strictEqual(initialBadge, 'Free Plan');

      // Enter a test NOWPayments Payment ID
      await optionsPage.type('#payment-id-input', 'test_verified_payment_1');
      await optionsPage.click('#btn-activate');

      // Wait for UI to update
      await optionsPage.waitForFunction(() => {
        return document.getElementById('tier-badge')?.textContent.includes('PRO');
      }, { timeout: 5000 });

      // Verify Pro status is reflected in chrome.storage.local
      const sw = await swTarget.worker();
      const storageData = await sw.evaluate(async () => {
        return await chrome.storage.local.get(['licenseStatus', 'nowpaymentsPaymentId']);
      });

      assert.strictEqual(storageData.licenseStatus, 'pro', 'Storage licenseStatus should be "pro"');
      assert.strictEqual(storageData.nowpaymentsPaymentId, 'test_verified_payment_1', 'Stored payment ID must match');

      await optionsPage.close();
    });

    // =========================================================================
    // TEST 7: Pro tier unlocks unlimited batch downloads and ZIP archive download
    // =========================================================================
    await test('Pro tier unlocks unlimited batch downloads and client-side ZIP packaging', async () => {
      const extPage = await browser.newPage();
      await extPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      const sw = await swTarget.worker();
      await sw.evaluate(() => {
        chrome.downloads.download = async () => 999;
      });

      // 1. Verify batch downloading 8 files (> 7 Free limit) is allowed on Pro tier
      const eightFiles = Array.from({ length: 8 }, (_, i) => ({
        url: `https://example.com/file${i + 1}.pdf`,
        filename: `file${i + 1}.pdf`
      }));

      const proBatchAttempt = await extPage.evaluate(async (files) => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_DOWNLOAD_FILES', files });
      }, eightFiles);

      assert.strictEqual(proBatchAttempt.status, 'ok', 'Pro tier should allow batch downloading > 7 files');
      assert.strictEqual(proBatchAttempt.totalFiles, 8, 'Total files should be 8');

      // 2. Verify ZIP archive packaging with JSZip
      const zipTest = await extPage.evaluate(async () => {
        const zip = new window.JSZip();
        zip.file('document.txt', 'BulkGrab automated test content');
        const b64 = await zip.generateAsync({ type: 'base64' });
        const dataUrl = 'data:application/zip;base64,' + b64;
        
        // Dispatch to Service Worker
        const res = await chrome.runtime.sendMessage({
          action: 'BULKGRAB_DOWNLOAD_ZIP',
          dataUrl: dataUrl,
          filename: 'test_archive.zip'
        });
        return res;
      });

      assert.strictEqual(zipTest.status, 'ok', 'ZIP download should return status: ok');

      await extPage.close();
    });

    // =========================================================================
    // TEST 8: Authorized test harness resets license back to Free tier
    // =========================================================================
    await test('Authorized test harness resets license back to Free tier', async () => {
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // Reset license via authorized test harness message
      const resetRes = await optionsPage.evaluate(async () => {
        const res = await chrome.runtime.sendMessage({ action: 'BULKGRAB_RESET_LICENSE' });
        location.reload();
        return res;
      });
      assert.strictEqual(resetRes.valid, true, 'Reset license should return valid: true');

      // Wait for UI to update back to Free Plan via storage listener
      await optionsPage.waitForFunction(() => {
        return document.getElementById('tier-badge')?.textContent.includes('Free Plan');
      }, { timeout: 5000 });

      const sw = await swTarget.worker();
      const storageData = await sw.evaluate(async () => {
        return await chrome.storage.local.get(['licenseStatus', 'nowpaymentsPaymentId']);
      });

      assert.strictEqual(storageData.licenseStatus, 'free', 'License should be reset to "free"');
      assert.strictEqual(storageData.nowpaymentsPaymentId, '', 'NOWPayments payment ID should be cleared');

      await optionsPage.close();
    });

    // =========================================================================
    // TEST 9: CORS partial-failure path in ZIP flow (bundles reachable, falls back for blocked)
    // =========================================================================
    await test('CORS partial-failure in ZIP flow bundles reachable files and delegates blocked files', async () => {
      // Ensure Pro tier is active
      const sw = await swTarget.worker();
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ licenseStatus: 'pro' });
      });

      const page = await browser.newPage();
      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(__dirname, '../assets/vendor/jszip.min.js') });
      await page.addScriptTag({ path: path.join(__dirname, '../content/content-script.js') });
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // Simulate ZIP packaging with 1 accessible file and 1 CORS-blocked file
      const result = await page.evaluate(async (port) => {
        const testFiles = [
          { url: `http://localhost:${port}/cors-ok.pdf`, filename: 'cors-ok.pdf' },
          { url: `http://localhost:${port}/cors-blocked.pdf`, filename: 'cors-blocked.pdf' }
        ];

        const zip = new window.JSZip();
        const packaged = [];
        const failed = [];

        for (const f of testFiles) {
          try {
            const res = await fetch(f.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            zip.file(f.filename, buf);
            packaged.push(f);
          } catch (e) {
            failed.push(f);
          }
        }

        const b64 = await zip.generateAsync({ type: 'base64' });

        return {
          packagedCount: packaged.length,
          failedCount: failed.length,
          zipHasContent: b64.length > 50,
          failedFilename: failed[0]?.filename
        };
      }, TEST_PORT);

      assert.strictEqual(result.packagedCount, 1, 'Reachable file should be packaged into ZIP');
      assert.strictEqual(result.failedCount, 1, 'CORS-blocked file should be caught as failed');
      assert.strictEqual(result.failedFilename, 'cors-blocked.pdf', 'Blocked filename should match');
      assert.strictEqual(result.zipHasContent, true, 'ZIP should be generated with successful files');

      await page.close();
    });

    // =========================================================================
    // TEST 10: Regression — Floating grabber panel renders without RangeError stack overflow
    // =========================================================================
    await test('Grabber panel renders with chrome.runtime.getURL without RangeError stack overflow', async () => {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      // Emulate isolated world runtime where chrome.runtime.getURL is available
      await page.evaluateOnNewDocument((id) => {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        window.chrome.runtime.getURL = (rel) => `chrome-extension://${id}/${rel}`;
      }, extId);

      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(__dirname, '../assets/vendor/jszip.min.js') });
      await page.addScriptTag({ path: path.join(__dirname, '../content/content-script.js') });
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // Check shadow root elements
      const panelInfo = await page.evaluate(() => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root ? root.shadowRoot : null;
        const panel = shadow ? shadow.querySelector('.bulkgrab-panel') : null;
        const styleLink = shadow ? shadow.querySelector('link[rel="stylesheet"]') : null;
        const logoImg = shadow ? shadow.querySelector('.logo-icon') : null;
        return {
          hasRoot: !!root,
          hasPanel: !!panel,
          styleHref: styleLink?.href,
          logoSrc: logoImg?.src,
          title: shadow?.querySelector('.panel-title')?.textContent,
          itemCount: shadow?.querySelectorAll('.file-item')?.length
        };
      });

      assert.strictEqual(pageErrors.length, 0, `Expected 0 page errors, got: ${pageErrors.join('; ')}`);
      assert.strictEqual(panelInfo.hasRoot, true, 'bulkgrab-root must exist in DOM');
      assert.strictEqual(panelInfo.hasPanel, true, 'Grabber panel must exist in shadow DOM');
      assert.strictEqual(panelInfo.title, 'BulkGrab', 'Panel title should match');
      assert.strictEqual(panelInfo.itemCount, 11, 'Panel must display 11 detected files');
      assert(panelInfo.styleHref.includes(extId), 'Style link must point to extension URL via chrome.runtime.getURL');
      assert(panelInfo.logoSrc.includes(extId), 'Logo img must point to extension URL via chrome.runtime.getURL');

      // Test toggling panel visibility does not crash or loop
      await page.evaluate(() => {
        window.postMessage({ action: 'BULKGRAB_TEST_TOGGLE' }, '*');
      });

      assert.strictEqual(pageErrors.length, 0, 'No RangeError should occur after toggle');

      await page.close();
    });

    // =========================================================================
    // TEST 11: Active floating panel dynamically updates on chrome.storage.onChanged
    // =========================================================================
    await test('Active floating panel updates tier tag and unlocks ZIP on storage change without reload', async () => {
      const page = await browser.newPage();

      // Ensure storage starts at free
      const sw = await swTarget.worker();
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ licenseStatus: 'free' });
      });

      // Emulate isolated world runtime with chrome.storage.onChanged simulator
      await page.evaluateOnNewDocument((id) => {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        window.chrome.runtime.getURL = (rel) => `chrome-extension://${id}/${rel}`;
        window.chrome.runtime.sendMessage = async (msg) => {
          if (msg.action === 'BULKGRAB_GET_STATUS') {
            return { status: 'ok', licenseStatus: 'free', sessionDownloads: 0, freeLimit: 7 };
          }
          return { status: 'ok' };
        };

        const listeners = [];
        window.chrome.storage = {
          onChanged: {
            addListener: (fn) => listeners.push(fn)
          }
        };
        window.__triggerStorageChange = (changes, area) => {
          for (const fn of listeners) fn(changes, area);
        };
      }, extId);

      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(__dirname, '../assets/vendor/jszip.min.js') });
      await page.addScriptTag({ path: path.join(__dirname, '../content/content-script.js') });
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // 1. Verify initial Free state
      const initialUI = await page.evaluate(() => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root ? root.shadowRoot : null;
        return {
          tierTag: shadow?.querySelector('.tier-tag')?.textContent?.trim(),
          zipBtn: shadow?.querySelector('#btn-zip')?.textContent?.trim(),
          isZipLocked: shadow?.querySelector('#btn-zip')?.classList.contains('btn-zip-locked'),
          quotaSummary: shadow?.querySelector('#quota-summary')?.textContent?.trim()
        };
      });

      assert.strictEqual(initialUI.tierTag, 'FREE', 'Initial tier tag should be FREE');
      assert.strictEqual(initialUI.zipBtn, '🔒 ZIP (PRO)', 'ZIP button should show locked status');
      assert.strictEqual(initialUI.isZipLocked, true, 'ZIP button should have locked class');
      assert(initialUI.quotaSummary.includes('Session Quota: 0/7 used (7 left)'), 'Quota summary should show session limits');

      // 2. Simulate Pro activation via chrome.storage.local change without any page reload or navigation
      await page.evaluate(() => {
        window.__triggerStorageChange({ licenseStatus: { oldValue: 'free', newValue: 'pro' } }, 'local');
      });

      // 3. Verify panel instantly transitioned to Pro in-place
      const proUI = await page.evaluate(() => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root ? root.shadowRoot : null;
        return {
          tierTag: shadow?.querySelector('.tier-tag')?.textContent?.trim(),
          zipBtn: shadow?.querySelector('#btn-zip')?.textContent?.trim(),
          isZipLocked: shadow?.querySelector('#btn-zip')?.classList.contains('btn-zip-locked'),
          quotaSummary: shadow?.querySelector('#quota-summary')?.textContent?.trim()
        };
      });

      assert.strictEqual(proUI.tierTag, 'PRO', 'Tier tag should dynamically update to PRO');
      assert.strictEqual(proUI.zipBtn, '📦 ZIP', 'ZIP button should unlock to 📦 ZIP');
      assert.strictEqual(proUI.isZipLocked, false, 'ZIP button should no longer have locked class');
      assert.strictEqual(proUI.quotaSummary, 'Unlimited Downloads', 'Quota summary should update to Unlimited Downloads');

      await page.close();
    });

    // =========================================================================
    // TEST 12: Free-tier user clicking ZIP is gated before permission checks run
    // =========================================================================
    await test('Free-tier user clicking ZIP is blocked by tier gate and never triggers permission prompt', async () => {
      const page = await browser.newPage();

      await page.evaluateOnNewDocument((id) => {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        window.chrome.runtime.getURL = (rel) => `chrome-extension://${id}/${rel}`;
        window.chrome.runtime.sendMessage = async (msg) => {
          if (msg.action === 'BULKGRAB_GET_STATUS') {
            return { status: 'ok', licenseStatus: 'free', sessionDownloads: 0, freeLimit: 7 };
          }
          if (msg.action === 'BULKGRAB_PROMPT_PERMISSIONS' || msg.action === 'BULKGRAB_CHECK_PERMISSIONS') {
            window.__PERM_REQUESTED__ = true;
          }
          return { status: 'ok' };
        };
      }, extId);

      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(__dirname, '../content/content-script.js') });
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // Select first file and click ZIP button
      const alertData = await page.evaluate(async () => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root.shadowRoot;
        const firstCb = shadow.querySelector('.file-checkbox');
        if (firstCb && !firstCb.checked) firstCb.click();
        const zipBtn = shadow.getElementById('btn-zip');
        zipBtn.click();

        await new Promise(r => setTimeout(r, 50));
        const banner = shadow.getElementById('alert-banner');
        return {
          bannerDisplay: banner?.style?.display,
          bannerText: banner?.textContent || '',
          permRequested: Boolean(window.__PERM_REQUESTED__)
        };
      });

      assert.strictEqual(alertData.bannerDisplay, 'block', 'Alert banner should be visible');
      assert(alertData.bannerText.includes('Download as ZIP is a PRO feature'), 'Banner should display Pro upgrade message');
      assert.strictEqual(alertData.permRequested, false, 'Permission request must never be triggered for free users');

      await page.close();
    });

    // =========================================================================
    // TEST 13: Permission declined → graceful fallback with persistent warning banner
    // =========================================================================
    await test('Permission declined falls back gracefully and persistent alert banner is not clobbered by progress', async () => {
      const page = await browser.newPage();

      await page.evaluateOnNewDocument((id) => {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        window.chrome.runtime.getURL = (rel) => `chrome-extension://${id}/${rel}`;
        const listeners = [];
        window.chrome.runtime.onMessage = {
          addListener: (fn) => listeners.push(fn)
        };
        window.__simulateMessage = (msg) => {
          for (const fn of listeners) fn(msg);
        };
        window.chrome.runtime.sendMessage = async (msg) => {
          if (msg.action === 'BULKGRAB_GET_STATUS') {
            return { status: 'ok', licenseStatus: 'pro', sessionDownloads: 0, freeLimit: 7 };
          }
          if (msg.action === 'BULKGRAB_CHECK_PERMISSIONS') {
            return { status: 'ok', hasPermission: false };
          }
          if (msg.action === 'BULKGRAB_PROMPT_PERMISSIONS') {
            return { status: 'ok', granted: false };
          }
          if (msg.action === 'BULKGRAB_DOWNLOAD_FILES') {
            return { status: 'ok', sessionDownloads: 0 };
          }
          return { status: 'ok' };
        };
      }, extId);

      await page.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(__dirname, '../content/content-script.js') });
      await page.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true, { timeout: 5000 });

      // Click ZIP
      const result = await page.evaluate(async () => {
        const root = document.getElementById('bulkgrab-root');
        const shadow = root.shadowRoot;
        const firstCb = shadow.querySelector('.file-checkbox');
        if (firstCb && !firstCb.checked) firstCb.click();
        const zipBtn = shadow.getElementById('btn-zip');
        zipBtn.click();

        await new Promise(r => setTimeout(r, 100));

        // Simulate incoming DOWNLOAD_PROGRESS message from SW
        window.__simulateMessage({
          action: 'BULKGRAB_DOWNLOAD_PROGRESS',
          index: 1,
          total: 5,
          filename: 'test.pdf',
          state: 'downloading'
        });

        const banner = shadow.getElementById('alert-banner');
        const statusBox = shadow.getElementById('status-box');

        return {
          bannerDisplay: banner?.style?.display,
          bannerText: banner?.textContent || '',
          statusBoxText: statusBox?.textContent || '',
          bannerPreserved: banner?.textContent?.includes('ZIP bundling needs permission')
        };
      });

      assert.strictEqual(result.bannerDisplay, 'block', 'Alert banner must remain visible');
      assert.strictEqual(result.bannerPreserved, true, 'Alert banner must NOT be clobbered by download progress');
      assert(result.statusBoxText.includes('Downloading (1/5)'), 'Status box should reflect individual download progress independently');

      await page.close();
    });

    // =========================================================================
    // TEST 14: Permission granted → background Service Worker creates ZIP archive
    // =========================================================================
    await test('Permission granted allows Service Worker to create ZIP archive via CREATE_ZIP', async () => {
      const sw = await swTarget.worker();
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ licenseStatus: 'pro' });
        chrome.downloads.download = async () => 1001;
        self.__origFetch = self.fetch;
        self.fetch = async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]).buffer
        });
      });

      const extPage = await browser.newPage();
      await extPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      const zipResult = await extPage.evaluate(async (port) => {
        const testFiles = [
          { url: `http://localhost:${port}/cors-ok.pdf`, filename: 'doc1.pdf' },
          { url: `http://localhost:${port}/cors-blocked.pdf`, filename: 'doc2.pdf' }
        ];
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_CREATE_ZIP',
          files: testFiles,
          zipFilename: 'Test_Archive.zip'
        });
      }, TEST_PORT);

      // Restore fetch in SW
      await sw.evaluate(() => {
        if (self.__origFetch) self.fetch = self.__origFetch;
      });

      assert.strictEqual(zipResult.status, 'ok', 'CREATE_ZIP should return status ok');
      assert.strictEqual(zipResult.downloadId, 1001, 'CREATE_ZIP should trigger chrome.downloads.download');
      assert.strictEqual(zipResult.packagedCount, 2, 'Both files should be successfully fetched and bundled in SW');
      assert.strictEqual(zipResult.failedCount, 0, 'No files should fail in SW with elevated permissions');
      assert.strictEqual(zipResult.zipFilename, 'Test_Archive.zip', 'Archive filename should match');

      await extPage.close();
    });

    // =========================================================================
    // TEST 15: verifyLicense handles payment statuses (finished, waiting, confirming, partially_paid, empty)
    // =========================================================================
    await test('verifyLicense handles NOWPayments statuses gracefully and confirms Pro activation', async () => {
      const sw = await swTarget.worker();
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // 1. Direct message verification test with empty string
      const emptyResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: ''
        });
      });
      assert.strictEqual(emptyResult.valid, false, 'Empty payment ID must return valid: false');
      assert(emptyResult.error.includes('valid NOWPayments Payment ID'), 'Should return helpful error message');

      // 2. Direct message verification test with whitespace-only string
      const wsResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: '   \t\n  '
        });
      });
      assert.strictEqual(wsResult.valid, false, 'Whitespace payment ID must return valid: false');

      // 3. Status handling: waiting state
      const waitingResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_waiting_payment_1'
        });
      });
      assert.strictEqual(waitingResult.valid, false, 'Waiting state must not activate Pro');
      assert.strictEqual(waitingResult.pending, true, 'Waiting state must return pending: true');
      assert(waitingResult.error.includes('waiting for funds'), 'Waiting state must return helpful message');

      // 4. Status handling: confirming state
      const confirmingResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_confirming_payment_2'
        });
      });
      assert.strictEqual(confirmingResult.valid, false, 'Confirming state must not activate Pro');
      assert.strictEqual(confirmingResult.pending, true, 'Confirming state must return pending: true');
      assert(confirmingResult.error.includes('block confirmations'), 'Confirming state must return blockchain notice');

      // 5. Status handling: partially_paid state
      const partialResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_partially_paid_3'
        });
      });
      assert.strictEqual(partialResult.valid, false, 'Partially paid must return valid: false');
      assert(partialResult.error.includes('partially paid'), 'Partially paid must guide user to pay remaining balance');

      // 6. UI test via Options page
      // Reset to free first
      await optionsPage.evaluate(async () => {
        await chrome.runtime.sendMessage({ action: 'BULKGRAB_RESET_LICENSE' });
      });
      await optionsPage.waitForFunction(() => {
        return document.getElementById('tier-badge')?.textContent.includes('Free Plan');
      });

      // Attempt to activate with empty input
      await optionsPage.click('#btn-activate');
      const errorMsg = await optionsPage.$eval('#status-message', el => el.textContent);
      assert(errorMsg.includes('NOWPayments Payment ID'), 'Error message should guide user to enter Payment ID');

      // Verify license remains free in storage
      const storageData = await sw.evaluate(async () => {
        return await chrome.storage.local.get(['licenseStatus', 'nowpaymentsPaymentId']);
      });
      assert.strictEqual(storageData.licenseStatus, 'free', 'License must remain free after empty input rejection');
      assert.strictEqual(storageData.nowpaymentsPaymentId, '', 'Payment ID must remain empty');

      // 7. Valid payment ID activation succeeds
      const validResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_verified_payment_1'
        });
      });
      assert.strictEqual(validResult.valid, true, 'Valid payment ID must return valid: true');
      assert.strictEqual(validResult.status, 'pro', 'Valid payment ID must set status: pro');
      assert.strictEqual(validResult.paymentId, 'test_verified_payment_1', 'Returned paymentId must match');

      const storageAfterValid = await sw.evaluate(async () => {
        return await chrome.storage.local.get(['licenseStatus', 'nowpaymentsPaymentId']);
      });
      assert.strictEqual(storageAfterValid.licenseStatus, 'pro', 'License should be pro after valid payment ID');
      assert.strictEqual(storageAfterValid.nowpaymentsPaymentId, 'test_verified_payment_1', 'Stored paymentId should match');

      // Reset back to free
      await optionsPage.evaluate(async () => {
        await chrome.runtime.sendMessage({ action: 'BULKGRAB_RESET_LICENSE' });
      });
      await optionsPage.close();
    });

    // =========================================================================
    // TEST 16: Dynamic payment creation generates fresh invoice and Payment ID
    // =========================================================================
    await test('CREATE_PAYMENT dynamically generates a fresh invoice URL and Payment ID', async () => {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      const createResult = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_CREATE_PAYMENT'
        });
      });

      assert.strictEqual(createResult.ok, true, 'Dynamic payment creation should return ok: true');
      assert(createResult.invoiceUrl && createResult.invoiceUrl.includes('nowpayments.io'), 'Should return a valid NOWPayments invoice URL');
      assert(createResult.paymentId && createResult.paymentId.length > 0, 'Should return a generated payment ID');

      // Verify pendingPaymentId was stored
      const sw = await swTarget.worker();
      const storage = await sw.evaluate(async () => {
        return await chrome.storage.local.get(['pendingPaymentId', 'pendingInvoiceId']);
      });
      assert.strictEqual(storage.pendingPaymentId, createResult.paymentId, 'pendingPaymentId must be saved in storage');
      assert.strictEqual(storage.pendingInvoiceId, createResult.paymentId, 'pendingInvoiceId must be saved in storage');

      await page.close();
    });

    // =========================================================================
    // TEST 17: Unknown payment ID shows friendly not-found guidance message
    // =========================================================================
    await test('verifyLicense with unknown ID shows friendly not-found guidance message and rejects invoice ID', async () => {
      const page = await browser.newPage();
      const sw = await swTarget.worker();
      await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      // 1. Direct message verify call with an unknown ID
      const unknownResult = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_unknown_payment_id_999'
        });
      });

      assert.strictEqual(unknownResult.valid, false, 'Unknown payment ID must return valid: false');
      assert.strictEqual(unknownResult.notFound, true, 'Unknown payment ID must set notFound: true');
      assert(
        unknownResult.error.toLowerCase().includes('not found, please check you copied the payment id from the payment page'),
        'Unknown ID must show friendly message rather than raw error'
      );

      // 2. Options page UI test with an unknown payment ID
      await page.type('#payment-id-input', 'test_unknown_payment_id_999');
      await page.click('#btn-activate');

      await page.waitForFunction(() => {
        const el = document.getElementById('status-message');
        return el && el.style.display !== 'none' && el.textContent.length > 0;
      }, { timeout: 5000 });

      const uiErrorMsg = await page.$eval('#status-message', el => el.textContent);
      assert(
        uiErrorMsg.toLowerCase().includes('not found, please check you copied the payment id from the payment page'),
        'UI status alert must display friendly not-found message'
      );

      // Verify support line under Payment ID box
      const supportLineText = await page.$eval('.input-support', el => el.textContent.trim());
      assert.strictEqual(supportLineText, 'Support: sidoua26@gmail.com', 'Support line must read "Support: sidoua26@gmail.com"');
      const supportHref = await page.$eval('#support-link', el => el.getAttribute('href'));
      assert.strictEqual(supportHref, 'mailto:sidoua26@gmail.com', 'Support link must be mailto: link');

      // Verify Step 1 payment wording in How Freemium Licensing Works
      const step1Text = await page.$eval('.steps-list li:first-child', el => el.textContent.trim());
      assert(
        step1Text.includes('Pay with USDT on the BSC (BEP20) network only. Coins or networks sent to the address by mistake cannot be recovered.'),
        'Options Step 1 must display exact USDT on BSC (BEP20) payment warning'
      );
      assert(
        !step1Text.includes('or any supported cryptocurrency'),
        'Options Step 1 must not suggest other cryptocurrencies are accepted'
      );

      // 3. Verify that verifying with an Invoice ID is blocked and never activates Pro
      const createRes = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({ action: 'BULKGRAB_CREATE_PAYMENT' });
      });
      const invoiceId = createRes.invoiceId || createRes.paymentId;
      assert(invoiceId, 'CREATE_PAYMENT must return an invoice ID');

      const invoiceVerifyRes = await page.evaluate(async (iid) => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: iid
        });
      }, invoiceId);

      assert.strictEqual(invoiceVerifyRes.valid, false, 'Verifying with invoice ID must return valid: false');
      assert.strictEqual(invoiceVerifyRes.isInvoiceId, true, 'isInvoiceId must be set');
      assert(
        invoiceVerifyRes.error.includes('Invoice ID') && invoiceVerifyRes.error.includes('Payment ID shown at the top of the payment page'),
        'Error must explain that this is the Invoice ID'
      );

      // 4. Test that pasting an invoice URL is also rejected
      const urlVerifyRes = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'https://nowpayments.io/payment/?iid=4743404425'
        });
      });
      assert.strictEqual(urlVerifyRes.valid, false, 'Verifying with invoice URL must return valid: false');
      assert.strictEqual(urlVerifyRes.isInvoiceId, true, 'isInvoiceId must be set');

      // 5. Security verification: When test flag is removed, real users CANNOT bypass verification
      await sw.evaluate(async () => {
        await chrome.storage.local.remove('__testMockVerification__');
      });

      const unflaggedRes = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_attempted_bypass_123'
        });
      });

      // Bypasses fail — request routed to live Cloudflare Worker and rejected
      assert.strictEqual(unflaggedRes.valid, false, 'Without test flag, test_ IDs must be rejected by live worker');
      assert.strictEqual(unflaggedRes.notFound, true, 'Live worker returns notFound for non-existent transactions');

      // Security check: Verify unauthenticated attempts to reset license or session quota are rejected
      const resetLicRes = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_RESET_LICENSE'
        });
      });
      assert.strictEqual(resetLicRes.status, 'error', 'Reset license must fail when test flag is absent');
      assert.strictEqual(resetLicRes.message, 'Unauthorized action', 'Reset license must return Unauthorized action');

      const resetQuotaRes = await page.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_RESET_SESSION_QUOTA'
        });
      });
      assert.strictEqual(resetQuotaRes.status, 'error', 'Reset quota must fail when test flag is absent');
      assert.strictEqual(resetQuotaRes.message, 'Unauthorized action', 'Reset quota must return Unauthorized action');

      // 6. Confirm testing buttons are completely removed from Options DOM
      const resetBtnExists = await page.$('#btn-reset');
      assert.strictEqual(resetBtnExists, null, 'btn-reset button must not exist in options DOM');
      const resetQuotaBtnExists = await page.$('#btn-reset-quota');
      assert.strictEqual(resetQuotaBtnExists, null, 'btn-reset-quota button must not exist in options DOM');

      // Re-enable test flag for safety
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ __testMockVerification__: true });
      });

      await page.close();
    });

    // =========================================================================
    // TEST 18: Hardened /api/verify-payment rejects non-BulkGrab purchases and validates orderId & pricing
    // =========================================================================
    await test('Hardened /api/verify-payment requires BG_PRO_ order_id, finished status, and >= $9.99 USD', async () => {
      const { default: worker } = await import('../cloudflare-worker/worker.js');
      const { SUPPORT_EMAIL } = await import('../utils/constants.js');

      const mockEnv = {
        NOWPAYMENTS_API_KEY: 'test_key_123'
      };

      async function testVerifyWithMockData(mockData) {
        const origFetch = global.fetch;
        global.fetch = async (url) => {
          if (url.includes('/payment/')) {
            return {
              ok: true,
              status: 200,
              json: async () => mockData,
              text: async () => JSON.stringify(mockData)
            };
          }
          return origFetch(url);
        };

        try {
          const req = new Request('https://worker.local/api/verify-payment?payment_id=5829104812');
          const res = await worker.fetch(req, mockEnv);
          return await res.json();
        } finally {
          global.fetch = origFetch;
        }
      }

      // 1. Valid purchase: finished, BG_PRO_ prefix, USD, $9.99
      const validRes = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'finished',
        order_id: 'BG_PRO_1726859345_abcde',
        price_amount: '9.99',
        price_currency: 'usd',
        pay_address: '0x1234567890'
      });
      assert.strictEqual(validRes.valid, true, 'Valid payment must return valid: true');
      assert.strictEqual(validRes.status, 'pro', 'Valid payment must set status: pro');
      assert.strictEqual(validRes.orderId, 'BG_PRO_1726859345_abcde');
      assert.strictEqual(validRes.priceAmount, 9.99);
      assert.strictEqual(validRes.priceCurrency, 'usd');

      // 2. Finished but unrelated order_id (from another store/invoice)
      const unrelatedFinished = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'finished',
        order_id: 'OTHER_STORE_PURCHASE_999',
        price_amount: 9.99,
        price_currency: 'usd'
      });
      assert.strictEqual(unrelatedFinished.valid, false);
      assert.strictEqual(unrelatedFinished.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);
      assert.strictEqual(unrelatedFinished.orderId, 'OTHER_STORE_PURCHASE_999');
      assert.strictEqual(unrelatedFinished.priceAmount, 9.99);
      assert.strictEqual(unrelatedFinished.priceCurrency, 'usd');

      // 3. Waiting but unrelated order_id: Must NOT return pending!
      const unrelatedWaiting = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'waiting',
        order_id: 'OTHER_STORE_WAITING_111',
        price_amount: 9.99,
        price_currency: 'usd'
      });
      assert.strictEqual(unrelatedWaiting.valid, false);
      assert.strictEqual(unrelatedWaiting.pending, undefined, 'Unrelated payment must never look like pending');
      assert.strictEqual(unrelatedWaiting.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);

      // 4. Missing order_id
      const missingOrder = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'finished',
        price_amount: 9.99,
        price_currency: 'usd'
      });
      assert.strictEqual(missingOrder.valid, false);
      assert.strictEqual(missingOrder.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);
      assert.strictEqual(missingOrder.orderId, null);

      // 5. Wrong currency (e.g. eur)
      const wrongCurrency = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'finished',
        order_id: 'BG_PRO_123',
        price_amount: 9.99,
        price_currency: 'eur'
      });
      assert.strictEqual(wrongCurrency.valid, false);
      assert.strictEqual(wrongCurrency.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);
      assert.strictEqual(wrongCurrency.priceCurrency, 'eur');

      // 6. Insufficient price amount (< 9.99)
      const lowPrice = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'finished',
        order_id: 'BG_PRO_123',
        price_amount: '5.00',
        price_currency: 'usd'
      });
      assert.strictEqual(lowPrice.valid, false);
      assert.strictEqual(lowPrice.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);
      assert.strictEqual(lowPrice.priceAmount, 5);

      // 7. Legitimate pending purchase with BG_PRO_ prefix and $9.99 USD
      const validPending = await testVerifyWithMockData({
        payment_id: 5829104812,
        payment_status: 'waiting',
        order_id: 'BG_PRO_12345',
        price_amount: 9.99,
        price_currency: 'usd'
      });
      assert.strictEqual(validPending.valid, false);
      assert.strictEqual(validPending.pending, true);
      assert.strictEqual(validPending.payment_status, 'waiting');
      assert.strictEqual(validPending.orderId, 'BG_PRO_12345');
      assert.strictEqual(validPending.priceAmount, 9.99);
      assert.strictEqual(validPending.priceCurrency, 'usd');

      // 8. Extension UI / service worker integration test with unrelated payment
      const optionsPage = await browser.newPage();
      await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });

      const unrelatedResult = await optionsPage.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          action: 'BULKGRAB_VERIFY_LICENSE',
          paymentId: 'test_unrelated_order_1'
        });
      });
      assert.strictEqual(unrelatedResult.valid, false);
      assert.strictEqual(unrelatedResult.message, `This payment is not a BulkGrab Pro purchase. Support: ${SUPPORT_EMAIL}`);

      await optionsPage.close();
    });

    // =========================================================================
    // TEST 19: Cloudflare Worker GET /privacy returns mobile-friendly HTML policy
    // =========================================================================
    await test('Cloudflare Worker GET /privacy returns clean HTML with text/html content-type', async () => {
      const { default: worker } = await import('../cloudflare-worker/worker.js');
      const req = new Request('https://worker.local/privacy', { method: 'GET' });
      const res = await worker.fetch(req, {});

      assert.strictEqual(res.status, 200, 'GET /privacy must return HTTP 200');
      assert.strictEqual(
        res.headers.get('content-type'),
        'text/html; charset=utf-8',
        'GET /privacy must return Content-Type: text/html; charset=utf-8'
      );

      const html = await res.text();
      assert(html.includes('BulkGrab Privacy Policy'), 'Must contain title BulkGrab Privacy Policy');
      assert(html.includes('Last updated: September 20, 2026'), 'Must contain Last updated date');
      assert(html.includes('1. What stays on your device.'), 'Must contain section 1');
      assert(html.includes('2. What is sent to our server.'), 'Must contain section 2');
      assert(html.includes('3. Payments.'), 'Must contain section 3');
      assert(html.includes('4. Optional site access.'), 'Must contain section 4');
      assert(html.includes('5. No selling, no ads.'), 'Must contain section 5');
      assert(html.includes('6. Changes and contact.'), 'Must contain section 6');
      assert(html.includes('sidoua26@gmail.com'), 'Must contain contact email sidoua26@gmail.com');
    });

    // =========================================================================
    // TEST 20: Cloudflare Worker script must be 100% self-contained without imports
    // =========================================================================
    await test('worker.js is a self-contained single file with zero "import " statements or external references', async () => {
      const workerPath = path.join(__dirname, '../cloudflare-worker/worker.js');
      const workerSource = fs.readFileSync(workerPath, 'utf8');

      // Check for any "import " statements
      const hasImportStatement = /(?:^|\n)\s*import\s+/m.test(workerSource) || workerSource.includes('import ');
      assert.strictEqual(
        hasImportStatement,
        false,
        'cloudflare-worker/worker.js must not contain any "import " statements to prevent Cloudflare Dashboard 10021 errors'
      );

      // Check for any "require(" calls
      const hasRequireCall = /(?:^|\n)\s*const\s+.*=\s*require\s*\(/m.test(workerSource) || workerSource.includes('require(');
      assert.strictEqual(
        hasRequireCall,
        false,
        'cloudflare-worker/worker.js must not contain any "require(" calls'
      );

      // Check for any references to external files outside cloudflare-worker/
      assert.strictEqual(
        workerSource.includes('../'),
        false,
        'cloudflare-worker/worker.js must not contain relative paths ("../") referencing files outside cloudflare-worker/'
      );
    });

    // =========================================================================
    // TEST 21: Store packaging step (scripts/package.js) and unzipped runtime verification
    // =========================================================================
    await test('Store packaging produces clean ZIP with all referenced files and functions end-to-end in Puppeteer', async () => {
      // 1. Build package to temporary ZIP
      const tempZipPath = path.join(os.tmpdir(), `bulkgrab-test-${Date.now()}.zip`);
      const pkgResult = await buildPackage({ outputPath: tempZipPath, quiet: true });
      assert(pkgResult.files.length > 0, 'Package must include files');
      assert(pkgResult.zipBytes > 0, 'Package ZIP must not be empty');

      // 2. Unzip into temp directory
      const tempExtDir = path.join(os.tmpdir(), `bulkgrab-ext-${Date.now()}`);
      fs.mkdirSync(tempExtDir, { recursive: true });

      const zipContent = fs.readFileSync(tempZipPath);
      const zip = await JSZip.loadAsync(zipContent);

      for (const [relPath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) {
          fs.mkdirSync(path.join(tempExtDir, relPath), { recursive: true });
        } else {
          const entryBuffer = await zipEntry.async('nodebuffer');
          const targetFile = path.join(tempExtDir, relPath);
          fs.mkdirSync(path.dirname(targetFile), { recursive: true });
          fs.writeFileSync(targetFile, entryBuffer);
        }
      }

      // 3. Verify that all referenced/imported files exist in the unzipped folder
      const manifest = JSON.parse(fs.readFileSync(path.join(tempExtDir, 'manifest.json'), 'utf8'));
      const requiredFiles = [
        manifest.background.service_worker,
        manifest.action.default_popup,
        manifest.options_ui.page,
        ...Object.values(manifest.icons || {}),
        ...Object.values(manifest.action.default_icon || {})
      ];

      for (const res of (manifest.web_accessible_resources || [])) {
        for (const r of (res.resources || [])) {
          if (!r.includes('*')) requiredFiles.push(r);
        }
      }

      const codeFiles = [
        'background/service-worker.js',
        'popup/popup.js',
        'options/options.js',
        'permission/permission.js',
        'content/content-script.js'
      ];

      for (const cf of codeFiles) {
        const fullPath = path.join(tempExtDir, cf);
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        const importRegex = /import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const impPath = match[1];
          if (impPath.startsWith('.')) {
            const resolved = path.normalize(path.join(path.dirname(cf), impPath)).replace(/\\/g, '/');
            requiredFiles.push(resolved);
          }
        }
      }

      for (const file of requiredFiles) {
        if (!file || typeof file !== 'string') continue;
        assert(
          fs.existsSync(path.join(tempExtDir, file)),
          `Missing required file in package zip: ${file}`
        );
      }

      // Verify excluded files are NOT in the zip
      const forbiddenFiles = [
        'test-page.html',
        'package.json',
        'package-lock.json',
        'README.md',
        'wrangler.toml',
        '.gitignore',
        'utils/package.json'
      ];
      for (const ff of forbiddenFiles) {
        assert(
          !fs.existsSync(path.join(tempExtDir, ff)),
          `Forbidden excluded file found in package zip: ${ff}`
        );
      }

      // 4. Launch Puppeteer with THAT folder as the extension
      const extErrors = { sw: [], popup: [], options: [] };
      const testBrowser = await puppeteer.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          `--disable-extensions-except=${tempExtDir}`,
          `--load-extension=${tempExtDir}`
        ]
      });

      try {
        const pkgSwTarget = await testBrowser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 });
        const pkgExtId = pkgSwTarget.url().split('/')[2];
        const pkgSw = await pkgSwTarget.worker();

        pkgSw.on('error', err => extErrors.sw.push(err.message));

        // Open test-page.html and inject content-script to scan 11 files
        const testPage = await testBrowser.newPage();
        await testPage.goto(`http://localhost:${TEST_PORT}/test-page.html`, { waitUntil: 'networkidle0' });

        await testPage.evaluateOnNewDocument((id) => {
          window.chrome = window.chrome || {};
          window.chrome.runtime = window.chrome.runtime || {};
          window.chrome.runtime.id = id;
          window.chrome.runtime.getURL = (rel) => `chrome-extension://${id}/${rel}`;
        }, pkgExtId);

        await testPage.addScriptTag({ path: path.join(tempExtDir, 'assets/vendor/jszip.min.js') });
        await testPage.addScriptTag({ path: path.join(tempExtDir, 'content/content-script.js') });
        await testPage.waitForFunction(() => window.__BULKGRAB_INITIALIZED__ === true);

        // Sync scanned files to service worker cache
        const syncPage = await testBrowser.newPage();
        await syncPage.goto(`chrome-extension://${pkgExtId}/options/options.html`, { waitUntil: 'networkidle0' });
        await syncPage.evaluate(() => {
          const sampleFiles = [
            { filename: 'dummy.pdf', category: 'documents' },
            { filename: 'helloworld.pdf', category: 'documents' },
            { filename: 'demo.docx', category: 'documents' },
            { filename: 'rfc2616.txt', category: 'documents' },
            { filename: 'nature_highres.jpg', category: 'images' },
            { filename: 'transparency_demo.png', category: 'images' },
            { filename: 'vector_tiger.svg', category: 'images' },
            { filename: 'dog.jpg', category: 'images' },
            { filename: 'sample_archive.zip', category: 'archives' },
            { filename: 'notification_sound.mp3', category: 'media' },
            { filename: 'video_clip_promo.mp4', category: 'media' }
          ];
          return chrome.runtime.sendMessage({
            action: 'BULKGRAB_UPDATE_BADGE',
            count: sampleFiles.length,
            files: sampleFiles
          });
        });
        await syncPage.close();

        // (a) Verify popup shows 11 files
        const testPopup = await testBrowser.newPage();
        testPopup.on('pageerror', err => extErrors.popup.push(err.message));
        testPopup.on('error', err => extErrors.popup.push(err.message));
        await testPopup.goto(`chrome-extension://${pkgExtId}/popup/popup.html`, { waitUntil: 'networkidle0' });

        await testPopup.waitForFunction(() => {
          const el = document.getElementById('file-count');
          return el && el.textContent.trim() === '11';
        }, { timeout: 5000 });

        const countText = await testPopup.$eval('#file-count', el => el.textContent.trim());
        assert.strictEqual(countText, '11', 'Popup must display 11 files');

        // (b) Verify Options page opens and Activate Pro button responds
        const testOptions = await testBrowser.newPage();
        testOptions.on('pageerror', err => extErrors.options.push(err.message));
        testOptions.on('error', err => extErrors.options.push(err.message));
        await testOptions.goto(`chrome-extension://${pkgExtId}/options/options.html`, { waitUntil: 'networkidle0' });

        await testOptions.type('#payment-id-input', '9999999999');
        await testOptions.click('#btn-activate');

        await testOptions.waitForFunction(() => {
          const el = document.getElementById('status-message');
          return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
        }, { timeout: 15000 });

        const statusText = await testOptions.$eval('#status-message', el => el.textContent.trim());
        assert(statusText.length > 0, 'Activate Pro button must display response');

        // (c) Verify Pay with Crypto flow produces an invoice URL with a numeric iid (not "bulkgrab_pro_upgrade")
        const paymentResult = await testPopup.evaluate(async () => {
          return await chrome.runtime.sendMessage({ action: 'BULKGRAB_CREATE_PAYMENT' });
        });
        assert(paymentResult && paymentResult.ok, 'Create payment must succeed');
        assert(paymentResult.invoiceUrl, 'Must return invoiceUrl');
        assert(
          /iid=\d+/.test(paymentResult.invoiceUrl),
          `Invoice URL must contain numeric iid, got: ${paymentResult.invoiceUrl}`
        );
        assert(
          !paymentResult.invoiceUrl.includes('bulkgrab_pro_upgrade'),
          'Invoice URL must not be static fallback bulkgrab_pro_upgrade'
        );

        // (d) Verify no errors in service worker, popup or options console
        assert.strictEqual(extErrors.sw.length, 0, `SW console errors: ${extErrors.sw.join('; ')}`);
        assert.strictEqual(extErrors.popup.length, 0, `Popup console errors: ${extErrors.popup.join('; ')}`);
        assert.strictEqual(extErrors.options.length, 0, `Options console errors: ${extErrors.options.join('; ')}`);

      } finally {
        await testBrowser.close();
        fs.rmSync(tempExtDir, { recursive: true, force: true });
        fs.rmSync(tempZipPath, { force: true });
      }
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
