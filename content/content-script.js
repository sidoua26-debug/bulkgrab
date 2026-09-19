/**
 * BulkGrab - Content Script
 * Scans page DOM for downloadable links and manages the Shadow DOM floating Grabber panel.
 */

(() => {
  // Prevent double injection
  if (window.__BULKGRAB_INITIALIZED__) {
    console.log('[BulkGrab] Already initialized in this frame.');
    return;
  }
  window.__BULKGRAB_INITIALIZED__ = true;
  // Safe chrome.runtime helper (supports isolated world and test environments)
  const isExtensionContext = typeof chrome !== 'undefined' && Boolean(chrome?.runtime);
  const getExtUrl = (relPath) => (isExtensionContext && chrome.runtime.getURL ? getExtUrl(relPath) : relPath);

  // Security Helper: Escape HTML special characters to prevent XSS / template injection
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Security Helper: Validate and sanitize URL protocols
  function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '#';
    try {
      const parsed = new URL(url, document.baseURI);
      if (['http:', 'https:', 'file:'].includes(parsed.protocol)) {
        return escapeHtml(parsed.href);
      }
    } catch (_) {}
    return '#';
  }

  // Configurable file extensions
  const DEFAULT_EXTENSIONS = [
    // Documents
    'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv',
    // Images
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
    // Archives
    'zip', 'tar', 'gz', 'rar', '7z',
    // Media
    'mp3', 'wav', 'mp4', 'webm', 'ogg', 'mkv'
  ];

  const CATEGORY_MAP = {
    documents: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv'],
    images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
    archives: ['zip', 'tar', 'gz', 'rar', '7z'],
    media: ['mp3', 'wav', 'mp4', 'webm', 'ogg', 'mkv']
  };

  function getCategory(ext) {
    const cleanExt = (ext || '').toLowerCase();
    for (const [cat, exts] of Object.entries(CATEGORY_MAP)) {
      if (exts.includes(cleanExt)) return cat;
    }
    return 'other';
  }

  // State
  let detectedFiles = [];
  let selectedUrls = new Set();
  let currentFilter = 'all';
  let searchQuery = '';
  let licenseStatus = 'free';
  let sessionDownloads = 0;
  let freeLimit = 3;
  let isPanelMinimized = false;
  let isPanelVisible = true;

  // Fetch status from Service Worker
  async function refreshStatus() {
    try {
      if (!isExtensionContext || !chrome.runtime.sendMessage) return;
      const res = await chrome.runtime.sendMessage({ action: 'BULKGRAB_GET_STATUS' });
      if (res && res.status === 'ok') {
        licenseStatus = res.licenseStatus || 'free';
        sessionDownloads = res.sessionDownloads || 0;
        freeLimit = res.freeLimit || 3;
        updateStatusInUI();
      }
    } catch (err) {
      console.warn('[BulkGrab] Could not fetch status:', err);
    }
  }

  /**
   * DOM Scanner: Detects downloadable files across links, media tags, and images.
   */
  function scanDOMForFiles() {
    const fileMap = new Map();
    const extensionSet = new Set(DEFAULT_EXTENSIONS);

    function processUrl(rawUrl, hintName, forcedExt) {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('#') || trimmed.startsWith('mailto:')) {
        return;
      }

      let parsed;
      try {
        parsed = new URL(trimmed, document.baseURI);
      } catch (_) {
        return;
      }

      // Filter to http/https/file protocols
      if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
        return;
      }

      const pathname = parsed.pathname;
      const lastSegment = pathname.split('/').pop() || '';
      
      let ext = forcedExt || '';
      if (!ext && lastSegment.includes('.')) {
        ext = lastSegment.split('.').pop().toLowerCase().split(/[?#]/)[0];
      }

      if (!ext && hintName && hintName.includes('.')) {
        ext = hintName.split('.').pop().toLowerCase();
      }

      if (ext && extensionSet.has(ext)) {
        const fullUrl = parsed.href;
        if (!fileMap.has(fullUrl)) {
          let filename = hintName || lastSegment || `file_${fileMap.size + 1}.${ext}`;
          try {
            filename = decodeURIComponent(filename);
          } catch (_) {}

          fileMap.set(fullUrl, {
            url: fullUrl,
            filename: filename,
            ext: ext,
            category: getCategory(ext),
            origin: parsed.hostname
          });
        }
      }
    }

    // 1. Scan anchor & area links
    const links = document.querySelectorAll('a[href], area[href]');
    links.forEach(a => {
      const href = a.getAttribute('href');
      const downloadAttr = a.getAttribute('download');
      const linkText = (a.textContent || '').trim();
      processUrl(href, downloadAttr || (linkText.length < 60 && linkText.includes('.') ? linkText : null));
    });

    // 2. Scan images
    const images = document.querySelectorAll('img[src]');
    images.forEach(img => {
      const src = img.getAttribute('src');
      const alt = img.getAttribute('alt');
      processUrl(src, alt ? `${alt.slice(0, 30)}.jpg` : null);
    });

    // 3. Scan media sources
    const mediaSources = document.querySelectorAll('video[src], audio[src], video > source[src], audio > source[src]');
    mediaSources.forEach(m => {
      processUrl(m.getAttribute('src'));
    });

    detectedFiles = Array.from(fileMap.values());
    console.log(`[BulkGrab] Scanned ${detectedFiles.length} downloadable files on this page.`);
    try {
      if (isExtensionContext && chrome.runtime.sendMessage) chrome.runtime.sendMessage({ action: 'BULKGRAB_UPDATE_BADGE', count: detectedFiles.length });
    } catch (_) {}
    return detectedFiles;
  }

  /**
   * Floating Grabber UI with Shadow DOM encapsulation
   */
  let hostEl = null;
  let shadowRoot = null;

  function createShadowUI() {
    if (document.getElementById('bulkgrab-root')) {
      return;
    }

    hostEl = document.createElement('div');
    hostEl.id = 'bulkgrab-root';
    document.documentElement.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    // Link external CSS
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = getExtUrl('content/content-style.css');
    shadowRoot.appendChild(styleLink);

    // Main markup container
    const container = document.createElement('div');
    container.id = 'bulkgrab-container';
    shadowRoot.appendChild(container);

    renderUI();
  }

  function getFilteredFiles() {
    return detectedFiles.filter(file => {
      const matchesCategory = (currentFilter === 'all') || (file.category === currentFilter);
      const matchesSearch = !searchQuery || file.filename.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }

  function renderUI() {
    const container = shadowRoot.getElementById('bulkgrab-container');
    if (!container) return;

    if (!isPanelVisible) {
      container.innerHTML = `
        <button id="btn-reopen-launcher" class="bulkgrab-launcher" title="Open BulkGrab Panel">
          <img src="${getExtUrl('assets/icons/icon-16.png')}" style="width:16px;height:16px;" alt="" />
          <span>BulkGrab (${detectedFiles.length})</span>
        </button>
      `;
      shadowRoot.getElementById('btn-reopen-launcher')?.addEventListener('click', () => {
        isPanelVisible = true;
        renderUI();
      });
      return;
    }

    const filtered = getFilteredFiles();
    const isPro = licenseStatus === 'pro';
    const remainingFree = Math.max(0, freeLimit - sessionDownloads);

    // Count categories
    const counts = { all: detectedFiles.length, documents: 0, images: 0, archives: 0, media: 0 };
    detectedFiles.forEach(f => {
      if (counts[f.category] !== undefined) counts[f.category]++;
    });

    const isAllSelected = filtered.length > 0 && filtered.every(f => selectedUrls.has(f.url));
    const selectedCount = selectedUrls.size;

    container.innerHTML = `
      <div class="bulkgrab-panel ${isPanelMinimized ? 'minimized' : ''}">
        <!-- Header -->
        <div class="panel-header" id="panel-drag-handle">
          <div class="header-left">
            <img src="${getExtUrl('assets/icons/icon-16.png')}" class="logo-icon" alt="BulkGrab" />
            <span class="panel-title">BulkGrab</span>
            <span class="tier-tag ${isPro ? 'tier-pro' : 'tier-free'}">${isPro ? 'PRO' : 'FREE'}</span>
          </div>
          <div class="header-controls">
            <button id="btn-minimize" class="ctrl-btn" title="${isPanelMinimized ? 'Expand' : 'Minimize'}">
              ${isPanelMinimized ? '▢' : '−'}
            </button>
            <button id="btn-close" class="ctrl-btn" title="Close Panel">×</button>
          </div>
        </div>

        <!-- Body -->
        <div class="panel-body">
          <!-- Category Tabs -->
          <div class="filter-tabs">
            <button class="tab-btn ${currentFilter === 'all' ? 'active' : ''}" data-category="all">
              All (${counts.all})
            </button>
            <button class="tab-btn ${currentFilter === 'documents' ? 'active' : ''}" data-category="documents">
              Docs (${counts.documents})
            </button>
            <button class="tab-btn ${currentFilter === 'images' ? 'active' : ''}" data-category="images">
              Images (${counts.images})
            </button>
            <button class="tab-btn ${currentFilter === 'archives' ? 'active' : ''}" data-category="archives">
              Archives (${counts.archives})
            </button>
            <button class="tab-btn ${currentFilter === 'media' ? 'active' : ''}" data-category="media">
              Media (${counts.media})
            </button>
          </div>

          <!-- Search & Select All Bar -->
          <div class="toolbar">
            <input type="text" class="search-input" id="search-input" placeholder="Filter by name..." value="${escapeHtml(searchQuery)}" />
            <label class="selection-toggle">
              <input type="checkbox" id="checkbox-select-all" ${isAllSelected ? 'checked' : ''} />
              <span>Select All</span>
            </label>
          </div>

          <!-- File List -->
          <div class="file-list" id="file-list-container">
            ${filtered.length === 0 ? `
              <div class="empty-state">No downloadable files matching your filter.</div>
            ` : filtered.map((file) => {
              const isSelected = selectedUrls.has(file.url);
              const badgeClass = 'ext-' + (file.category === 'documents' ? 'doc' : file.category === 'images' ? 'img' : file.category === 'archives' ? 'zip' : file.category === 'media' ? 'media' : 'other');
              const safeUrl = sanitizeUrl(file.url);
              const safeFilename = escapeHtml(file.filename);
              const safeOrigin = escapeHtml(file.origin);
              const safeExt = escapeHtml(file.ext);

              return `
                <div class="file-item ${isSelected ? 'selected' : ''}" data-url="${safeUrl}">
                  <input type="checkbox" class="file-checkbox" data-url="${safeUrl}" ${isSelected ? 'checked' : ''} />
                  <span class="ext-badge ${badgeClass}">${safeExt}</span>
                  <div class="file-details">
                    <span class="file-name" title="${safeFilename}">${safeFilename}</span>
                    <span class="file-sub">${safeOrigin}</span>
                  </div>
                  <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="file-link" title="Open file in new tab">↗</a>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Status / Progress Box -->
          <div id="status-box" class="status-box"></div>
          <div id="progress-container" class="progress-bar-container">
            <div id="progress-fill" class="progress-bar-fill"></div>
          </div>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <div class="footer-meta">
            <span id="selection-summary">${selectedCount} of ${detectedFiles.length} selected</span>
            <span id="quota-summary">${isPro ? 'Unlimited Downloads' : `Session Quota: ${sessionDownloads}/${freeLimit} used (${remainingFree} left)`}</span>
          </div>
          <div class="footer-actions">
            <button id="btn-download" class="btn-download" ${selectedCount === 0 ? 'disabled' : ''}>
              <span>⬇ Download Selected (${selectedCount})</span>
            </button>
            <button id="btn-zip" class="${isPro ? 'btn-zip' : 'btn-zip btn-zip-locked'}" ${selectedCount === 0 ? 'disabled' : ''} title="${isPro ? 'Package selected files as a ZIP archive' : 'Pro Feature: Download as ZIP'}">
              <span>${isPro ? '📦 ZIP' : '🔒 ZIP (PRO)'}</span>
            </button>
          </div>
        </div>
      </div>
    `;

    attachEventListeners();
  }

  function attachEventListeners() {
    // Header controls
    shadowRoot.getElementById('btn-minimize')?.addEventListener('click', () => {
      isPanelMinimized = !isPanelMinimized;
      renderUI();
    });

    shadowRoot.getElementById('btn-close')?.addEventListener('click', () => {
      isPanelVisible = false;
      renderUI();
    });

    // Make header draggable
    setupDraggable(shadowRoot.getElementById('panel-drag-handle'), hostEl);

    // Filter tab buttons
    shadowRoot.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        currentFilter = e.currentTarget.getAttribute('data-category');
        renderUI();
      });
    });

    // Search input
    const searchInput = shadowRoot.getElementById('search-input');
    searchInput?.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderFileListOnly();
    });

    // Select all checkbox
    const selectAllCb = shadowRoot.getElementById('checkbox-select-all');
    selectAllCb?.addEventListener('change', (e) => {
      const filtered = getFilteredFiles();
      if (e.target.checked) {
        filtered.forEach(f => selectedUrls.add(f.url));
      } else {
        filtered.forEach(f => selectedUrls.delete(f.url));
      }
      renderUI();
    });

    // Individual file checkboxes
    shadowRoot.querySelectorAll('.file-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const url = e.target.getAttribute('data-url');
        if (e.target.checked) {
          selectedUrls.add(url);
        } else {
          selectedUrls.delete(url);
        }
        updateSelectionUI();
      });
    });

    // Download button
    shadowRoot.getElementById('btn-download')?.addEventListener('click', startDownloads);

    // ZIP button (Pro)
    shadowRoot.getElementById('btn-zip')?.addEventListener('click', startZipDownload);
  }

  function renderFileListOnly() {
    const listContainer = shadowRoot.getElementById('file-list-container');
    if (!listContainer) {
      renderUI();
      return;
    }
    const filtered = getFilteredFiles();
    if (filtered.length === 0) {
      listContainer.innerHTML = `<div class="empty-state">No downloadable files matching your filter.</div>`;
      return;
    }
    listContainer.innerHTML = filtered.map(file => {
      const isSelected = selectedUrls.has(file.url);
      const badgeClass = 'ext-' + (file.category === 'documents' ? 'doc' : file.category === 'images' ? 'img' : file.category === 'archives' ? 'zip' : file.category === 'media' ? 'media' : 'other');
      const safeUrl = sanitizeUrl(file.url);
      const safeFilename = escapeHtml(file.filename);
      const safeOrigin = escapeHtml(file.origin);
      const safeExt = escapeHtml(file.ext);

      return `
        <div class="file-item ${isSelected ? 'selected' : ''}" data-url="${safeUrl}">
          <input type="checkbox" class="file-checkbox" data-url="${safeUrl}" ${isSelected ? 'checked' : ''} />
          <span class="ext-badge ${badgeClass}">${safeExt}</span>
          <div class="file-details">
            <span class="file-name" title="${safeFilename}">${safeFilename}</span>
            <span class="file-sub">${safeOrigin}</span>
          </div>
          <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="file-link" title="Open in new tab">↗</a>
        </div>
      `;
    }).join('');

    // Reattach checkbox events
    listContainer.querySelectorAll('.file-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const url = e.target.getAttribute('data-url');
        if (e.target.checked) selectedUrls.add(url);
        else selectedUrls.delete(url);
        updateSelectionUI();
      });
    });
  }

  function updateSelectionUI() {
    const filtered = getFilteredFiles();
    const isAllSelected = filtered.length > 0 && filtered.every(f => selectedUrls.has(f.url));
    const selectAllCb = shadowRoot.getElementById('checkbox-select-all');
    if (selectAllCb) selectAllCb.checked = isAllSelected;

    const summaryEl = shadowRoot.getElementById('selection-summary');
    if (summaryEl) summaryEl.textContent = `${selectedUrls.size} of ${detectedFiles.length} selected`;

    const downloadBtn = shadowRoot.getElementById('btn-download');
    if (downloadBtn) {
      downloadBtn.disabled = selectedUrls.size === 0;
      downloadBtn.innerHTML = `<span>⬇ Download Selected (${selectedUrls.size})</span>`;
    }

    const zipBtn = shadowRoot.getElementById('btn-zip');
    if (zipBtn) {
      zipBtn.disabled = selectedUrls.size === 0;
    }

    // Update item highlights
    shadowRoot.querySelectorAll('.file-item').forEach(item => {
      const url = item.getAttribute('data-url');
      if (selectedUrls.has(url)) item.classList.add('selected');
      else item.classList.remove('selected');
    });
  }

  function showStatus(message, type = 'info') {
    const box = shadowRoot.getElementById('status-box');
    if (!box) return;
    box.className = `status-box status-${type}`;
    box.innerHTML = message;
    box.style.display = 'block';
  }

  function hideStatus() {
    const box = shadowRoot.getElementById('status-box');
    if (box) box.style.display = 'none';
  }

  function setProgress(current, total) {
    const container = shadowRoot.getElementById('progress-container');
    const fill = shadowRoot.getElementById('progress-fill');
    if (!container || !fill) return;

    if (total <= 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    const percent = Math.min(100, Math.round((current / total) * 100));
    fill.style.width = `${percent}%`;
  }

  function updateStatusInUI() {
    const quotaSummary = shadowRoot?.getElementById('quota-summary');
    if (quotaSummary) {
      const isPro = licenseStatus === 'pro';
      const remaining = Math.max(0, freeLimit - sessionDownloads);
      quotaSummary.textContent = isPro ? 'Unlimited Downloads' : `Session Quota: ${sessionDownloads}/${freeLimit} used (${remaining} left)`;
    }
  }

  /**
   * Trigger sequential file downloads via background service worker.
   */
  async function startDownloads() {
    if (selectedUrls.size === 0) return;

    const filesToDownload = detectedFiles.filter(f => selectedUrls.has(f.url));
    const isPro = licenseStatus === 'pro';
    const remaining = Math.max(0, freeLimit - sessionDownloads);

    // Pre-flight check on Free tier
    if (!isPro && filesToDownload.length > remaining) {
      showStatus(
        `⚠️ Free tier quota limit! You have <strong>${remaining}</strong> download(s) remaining this session, but selected ${filesToDownload.length}. Please select up to ${remaining} or upgrade to Pro.`,
        'warning'
      );
      return;
    }

    const downloadBtn = shadowRoot.getElementById('btn-download');
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Downloading...';
    }

    showStatus(`Starting download of ${filesToDownload.length} file(s)...`, 'info');
    setProgress(0, filesToDownload.length);

    try {
      if (!isExtensionContext || !chrome.runtime.sendMessage) {
        showStatus('Running in test environment (extension runtime not connected).', 'info');
        return;
      }
      const response = await chrome.runtime.sendMessage({
        action: 'BULKGRAB_DOWNLOAD_FILES',
        files: filesToDownload
      });

      if (response && response.status === 'ok') {
        sessionDownloads = response.sessionDownloads || sessionDownloads;
        updateStatusInUI();
        setProgress(filesToDownload.length, filesToDownload.length);
        showStatus(`✅ Successfully downloaded ${response.downloadedCount} file(s)!`, 'info');
        setTimeout(hideStatus, 5000);
      } else if (response && response.status === 'quota_exceeded') {
        showStatus(`❌ ${escapeHtml(response.message)}`, 'error');
      } else {
        showStatus(`❌ Error: ${escapeHtml(response?.message || 'Download failed')}`, 'error');
      }
    } catch (err) {
      showStatus(`❌ Download error: ${escapeHtml(err.message)}`, 'error');
    } finally {
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `<span>⬇ Download Selected (${selectedUrls.size})</span>`;
      }
    }
  }

  /**
   * Package selected files client-side into a ZIP archive using JSZip (Pro Feature).
   */
  async function startZipDownload() {
    if (selectedUrls.size === 0) return;

    if (licenseStatus !== 'pro') {
      showStatus(
        '⭐ <strong>Download as ZIP is a PRO feature!</strong> Upgrade to Pro to bundle unlimited files into a clean ZIP archive, or use standard download.',
        'warning'
      );
      return;
    }

    const filesToDownload = detectedFiles.filter(f => selectedUrls.has(f.url));
    const zipBtn = shadowRoot.getElementById('btn-zip');
    const downloadBtn = shadowRoot.getElementById('btn-download');

    if (zipBtn) {
      zipBtn.disabled = true;
      zipBtn.innerHTML = '<span>📦 Zipping...</span>';
    }
    if (downloadBtn) {
      downloadBtn.disabled = true;
    }

    showStatus(`Preparing ZIP archive for ${filesToDownload.length} file(s)...`, 'info');
    setProgress(0, filesToDownload.length);

    try {
      const JSZipLib = window.JSZip;
      if (!JSZipLib) {
        throw new Error('JSZip library is not loaded. Please re-open the grabber panel.');
      }

      const zip = new JSZipLib();
      let packagedCount = 0;

      for (let i = 0; i < filesToDownload.length; i++) {
        const file = filesToDownload[i];
        showStatus(`Adding (${i + 1}/${filesToDownload.length}): ${escapeHtml(file.filename)}...`, 'info');
        setProgress(i, filesToDownload.length);

        try {
          const res = await fetch(file.url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await res.arrayBuffer();
          zip.file(file.filename, buffer);
          packagedCount++;
        } catch (fetchErr) {
          console.warn(`[BulkGrab ZIP] Could not fetch ${file.url}:`, fetchErr);
        }
      }

      if (packagedCount === 0) {
        throw new Error('None of the selected files could be retrieved for the archive.');
      }

      showStatus('Compressing ZIP archive...', 'info');
      setProgress(filesToDownload.length, filesToDownload.length);

      const base64Data = await zip.generateAsync({ type: 'base64' });
      const dataUrl = 'data:application/zip;base64,' + base64Data;

      const hostname = window.location.hostname || 'BulkGrab';
      const cleanHost = hostname.replace(/[^a-zA-Z0-9_-]/g, '_');
      const zipFilename = `${cleanHost}_Archive.zip`;

      const response = await chrome.runtime.sendMessage({
        action: 'BULKGRAB_DOWNLOAD_ZIP',
        dataUrl: dataUrl,
        filename: zipFilename
      });

      if (response && response.status === 'ok') {
        showStatus(`✅ ZIP archive (${packagedCount} files) saved as ${escapeHtml(zipFilename)}!`, 'info');
        setTimeout(hideStatus, 6000);
      } else {
        showStatus(`❌ ZIP download error: ${escapeHtml(response?.message || 'Download failed')}`, 'error');
      }
    } catch (err) {
      showStatus(`❌ ZIP packaging error: ${escapeHtml(err.message)}`, 'error');
    } finally {
      if (zipBtn) {
        zipBtn.disabled = selectedUrls.size === 0;
        zipBtn.innerHTML = `<span>📦 ZIP</span>`;
      }
      if (downloadBtn) {
        downloadBtn.disabled = selectedUrls.size === 0;
      }
    }
  }

  /**
   * Draggable panel logic
   */
  function setupDraggable(handle, target) {
    if (!handle || !target) return;
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ctrl-btn')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = target.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      target.style.bottom = 'auto';
      target.style.right = 'auto';
      target.style.left = `${initialLeft}px`;
      target.style.top = `${initialTop}px`;

      const onMouseMove = (ev) => {
        if (!isDragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const newLeft = Math.max(8, Math.min(window.innerWidth - target.offsetWidth - 8, initialLeft + dx));
        const newTop = Math.max(8, Math.min(window.innerHeight - target.offsetHeight - 8, initialTop + dy));
        target.style.left = `${newLeft}px`;
        target.style.top = `${newTop}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Listen for progress updates from Service Worker
  if (isExtensionContext && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

        if (message.action === 'BULKGRAB_RESCAN') {
      scanDOMForFiles();
      renderUI();
      sendResponse({ status: 'ok', count: detectedFiles.length, files: detectedFiles });
      return false;
    }
    if (message.action === 'BULKGRAB_PING') {
      sendResponse({ status: 'alive', fileCount: detectedFiles.length });
      return false;
    }

    if (message.action === 'BULKGRAB_GET_PAGE_FILES') {
      sendResponse({
        status: 'ok',
        count: detectedFiles.length,
        files: detectedFiles
      });
      return false;
    }

    if (message.action === 'BULKGRAB_TOGGLE_PANEL') {
      isPanelVisible = !isPanelVisible;
      renderUI();
      sendResponse({ status: 'ok', isVisible: isPanelVisible });
      return false;
    }

    if (message.action === 'BULKGRAB_DOWNLOAD_PROGRESS') {
      const safeFilename = escapeHtml(message.filename);
      if (message.state === 'downloading') {
        showStatus(`Downloading (${message.index}/${message.total}): ${safeFilename}...`, 'info');
        setProgress(message.index - 1, message.total);
      } else if (message.state === 'completed') {
        setProgress(message.index, message.total);
      } else if (message.state === 'failed') {
        showStatus(`⚠️ Failed to download: ${safeFilename}`, 'warning');
      }
      return false;
    }

    return false;
    });
  }

  // Initialization
  async function init() {
    try {
      await refreshStatus();
    } catch (_) {}
    scanDOMForFiles();
    createShadowUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
