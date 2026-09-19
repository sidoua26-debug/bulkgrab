/**
 * BulkGrab - Render Master SVG to PNG Icons
 * Uses Puppeteer/Chromium Skia engine for pixel-perfect anti-aliased rendering.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const rootDir = path.resolve(__dirname, '..');
const svgPath = path.join(rootDir, 'assets', 'icons', 'icon-master.svg');
const svgContent = fs.readFileSync(svgPath, 'utf8');

const sizes = [16, 48, 128];

async function renderIcons() {
  console.log('[Render Icons] Launching Puppeteer Chromium...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  for (const size of sizes) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
    svg { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  ${svgContent}
</body>
</html>`);

    const destPath = path.join(rootDir, 'assets', 'icons', `icon-${size}.png`);
    const buffer = await page.screenshot({ omitBackground: true, type: 'png' });
    fs.writeFileSync(destPath, buffer);
    console.log(`[Render Icons] Rendered icon-${size}.png (${size}x${size}, ${buffer.length} bytes)`);
  }

  await browser.close();
  console.log('[Render Icons] All icons successfully rendered and saved.');
}

renderIcons().catch(err => {
  console.error('[Render Icons] Render failed:', err);
  process.exit(1);
});
