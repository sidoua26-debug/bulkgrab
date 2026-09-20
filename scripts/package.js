/**
 * BulkGrab - Chrome Web Store Packaging Script
 * Builds dist/bulkgrab-store.zip containing ONLY what the extension needs at runtime.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_ZIP = path.join(DIST_DIR, 'bulkgrab-store.zip');

// Exact inclusion rules per specification:
// - manifest.json
// - folders: background/, content/, popup/, options/, permission/, assets/
// - .js files in utils/
const INCLUDED_FOLDERS = [
  'background',
  'content',
  'popup',
  'options',
  'permission',
  'assets'
];

// Strict exclusions
const EXCLUDED_PATTERNS = [
  /^(test|scripts|cloudflare-worker|node_modules|\.git|dist)(\/|$)/,
  /\.md$/i,
  /package.*\.json$/i, // all package.json and package-lock.json
  /^test-page\.html$/i,
  /wrangler\.toml$/i,
  /\.gitignore$/i,
  /\.DS_Store$/i
];

function shouldExclude(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return EXCLUDED_PATTERNS.some(pat => pat.test(norm));
}

function getAllFiles(dir, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!shouldExclude(relPath + '/')) {
        results = results.concat(getAllFiles(fullPath, baseDir));
      }
    } else if (entry.isFile()) {
      if (!shouldExclude(relPath)) {
        results.push({ fullPath, relPath });
      }
    }
  }
  return results;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = (bytes / 1024).toFixed(2);
  return `${kb} KB`;
}

async function buildPackage(options = {}) {
  const quiet = Boolean(options.quiet);
  const outPath = options.outputPath || OUTPUT_ZIP;

  if (!quiet) {
    console.log('========================================================');
    console.log('📦  Building BulkGrab Chrome Web Store ZIP Archive');
    console.log('========================================================\n');
  }

  const filesToInclude = [];

  // 1. manifest.json
  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    filesToInclude.push({ fullPath: manifestPath, relPath: 'manifest.json' });
  } else {
    throw new Error('manifest.json not found in root directory!');
  }

  // 2. Included runtime folders
  for (const folder of INCLUDED_FOLDERS) {
    const folderPath = path.join(ROOT_DIR, folder);
    const files = getAllFiles(folderPath, ROOT_DIR);
    filesToInclude.push(...files);
  }

  // 3. .js files in utils/
  const utilsPath = path.join(ROOT_DIR, 'utils');
  if (fs.existsSync(utilsPath)) {
    const utilsEntries = fs.readdirSync(utilsPath, { withFileTypes: true });
    for (const entry of utilsEntries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        const fullPath = path.join(utilsPath, entry.name);
        const relPath = path.join('utils', entry.name).replace(/\\/g, '/');
        if (!shouldExclude(relPath)) {
          filesToInclude.push({ fullPath, relPath });
        }
      }
    }
  }

  // Sort files alphabetically
  filesToInclude.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Initialize ZIP
  const zip = new JSZip();
  let totalRawBytes = 0;

  if (!quiet) {
    console.log('Included Files:');
  }

  for (const item of filesToInclude) {
    const content = fs.readFileSync(item.fullPath);
    const size = content.length;
    totalRawBytes += size;
    zip.file(item.relPath, content);
    if (!quiet) {
      console.log(`  ✓  ${item.relPath.padEnd(38)} (${formatBytes(size)})`);
    }
  }

  // Ensure output directory exists
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Generate ZIP buffer with maximum compression
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  fs.writeFileSync(outPath, zipBuffer);

  if (!quiet) {
    console.log('\n--------------------------------------------------------');
    console.log(`Total Files Included : ${filesToInclude.length}`);
    console.log(`Uncompressed Size    : ${formatBytes(totalRawBytes)} (${totalRawBytes} bytes)`);
    console.log(`Final ZIP Size       : ${formatBytes(zipBuffer.length)} (${zipBuffer.length} bytes)`);
    console.log(`Output Location      : ${outPath}`);
    console.log('--------------------------------------------------------\n');
    console.log('✅ Store packaging complete!\n');
  }

  return {
    outputPath: outPath,
    files: filesToInclude.map(f => f.relPath),
    totalFiles: filesToInclude.length,
    uncompressedBytes: totalRawBytes,
    zipBytes: zipBuffer.length
  };
}

// CLI execution
if (require.main === module) {
  buildPackage().catch(err => {
    console.error('❌ Packaging failed:', err.message);
    process.exit(1);
  });
}

module.exports = { buildPackage };
