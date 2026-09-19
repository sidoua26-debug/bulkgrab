/**
 * BulkGrab - Action Popup Script
 * Manages popup display, tab file counts, category breakdown, and plan/quota status.
 */

import { MESSAGE_ACTIONS, STRIPE_PAYMENT_URL, FREE_DOWNLOAD_LIMIT } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const tierBadge = document.getElementById('tier-badge');
  const activeDomainEl = document.getElementById('active-domain');
  const fileCountEl = document.getElementById('file-count');
  const catDocsEl = document.getElementById('cat-docs');
  const catImagesEl = document.getElementById('cat-images');
  const catArchivesEl = document.getElementById('cat-archives');
  const catMediaEl = document.getElementById('cat-media');

  const quotaSection = document.getElementById('quota-section');
  const quotaTitle = document.getElementById('quota-title');
  const downloadQuotaEl = document.getElementById('download-quota');
  const quotaTrackContainer = document.getElementById('quota-track-container');
  const quotaFill = document.getElementById('quota-fill');
  const quotaNote = document.getElementById('quota-note');

  const btnRescan = document.getElementById('btn-rescan');
  const btnOptions = document.getElementById('btn-options');
  const linkOptions = document.getElementById('link-options');
  const btnUpgrade = document.getElementById('btn-upgrade');
  const btnTogglePanel = document.getElementById('btn-toggle-panel');

  // Open options page helper
  function openOptions() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options/options.html'));
    }
  }

  btnOptions?.addEventListener('click', openOptions);
  linkOptions?.addEventListener('click', (e) => {
    e.preventDefault();
    openOptions();
  });

  // 1. Fetch license and quota status from Service Worker
  let isPro = false;
  let sessionDownloads = 0;
  let freeLimit = FREE_DOWNLOAD_LIMIT;

  try {
    const response = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_STATUS });
    if (response && response.status === 'ok') {
      isPro = response.licenseStatus === 'pro';
      sessionDownloads = response.sessionDownloads || 0;
      freeLimit = response.freeLimit || FREE_DOWNLOAD_LIMIT;
    }
  } catch (err) {
    console.warn('[BulkGrab Popup] Could not retrieve status from SW:', err);
  }

  // Update Plan / Quota UI
  if (isPro) {
    tierBadge.textContent = 'PRO Active';
    tierBadge.className = 'badge badge-pro';
    
    if (quotaSection) {
      quotaSection.className = 'card quota-card pro-card';
      quotaTitle.textContent = 'Pro Plan Unlocked';
      downloadQuotaEl.textContent = '✨ Unlimited';
      if (quotaTrackContainer) quotaTrackContainer.style.display = 'none';
      if (quotaNote) quotaNote.textContent = 'Unlimited batch downloads and client-side ZIP export enabled.';
    }
    if (btnUpgrade) btnUpgrade.style.display = 'none';
  } else {
    tierBadge.textContent = 'Free Plan';
    tierBadge.className = 'badge badge-free';
    
    const used = sessionDownloads;
    downloadQuotaEl.textContent = `${used} / ${freeLimit} used`;
    
    const pct = Math.min(100, Math.round((used / freeLimit) * 100));
    if (quotaFill) {
      quotaFill.style.width = `${pct}%`;
      if (used >= freeLimit) {
        quotaFill.className = 'quota-fill full';
        if (quotaNote) quotaNote.innerHTML = '<strong>Quota reached!</strong> Upgrade to Pro for unlimited downloads.';
      } else if (used >= 2) {
        quotaFill.className = 'quota-fill warn';
        if (quotaNote) quotaNote.textContent = `${freeLimit - used} download remaining in this session.`;
      } else {
        quotaFill.className = 'quota-fill';
      }
    }
    if (btnUpgrade) btnUpgrade.href = STRIPE_PAYMENT_URL;
  }

  // 2. Query and inspect active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Guard against unscriptable URLs
  if (
    !activeTab || 
    !activeTab.id || 
    !activeTab.url || 
    activeTab.url.startsWith('chrome://') || 
    activeTab.url.startsWith('chrome-extension://') || 
    activeTab.url.startsWith('devtools://') || 
    activeTab.url.startsWith('edge://') ||
    activeTab.url.includes('chromewebstore.google.com')
  ) {
    activeDomainEl.textContent = 'Restricted page';
    fileCountEl.textContent = '—';
    if (btnTogglePanel) {
      btnTogglePanel.disabled = true;
      btnTogglePanel.title = 'Cannot run on browser internal or Web Store pages';
    }
    if (btnRescan) btnRescan.disabled = true;
    return;
  }

  // Display domain
  try {
    const tabUrl = new URL(activeTab.url);
    activeDomainEl.textContent = tabUrl.hostname || activeTab.title || 'Current Page';
    activeDomainEl.title = activeTab.url;
  } catch (_) {
    activeDomainEl.textContent = 'Current Page';
  }

  // Helper to ensure content script is injected
  async function ensureContentScriptInjected() {
    try {
      const ping = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.PING });
      if (ping && ping.status === 'alive') {
        return { success: true, count: ping.fileCount };
      }
    } catch (_) {
      // Content script not yet present on tab
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content/content-script.js']
      });

      // Brief delay for initialization
      await new Promise(r => setTimeout(r, 120));

      const ping = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.PING });
      return { success: true, count: ping?.fileCount || 0 };
    } catch (err) {
      console.warn('[BulkGrab Popup] Scripting injection error:', err);
      return { success: false, error: err.message };
    }
  }

  // Helper to update breakdown pills and counts
  function updateFileStats(files = []) {
    const total = files.length;
    fileCountEl.textContent = String(total);

    const counts = { documents: 0, images: 0, archives: 0, media: 0 };
    files.forEach(f => {
      if (counts[f.category] !== undefined) counts[f.category]++;
    });

    if (catDocsEl) catDocsEl.textContent = `📄 ${counts.documents} Docs`;
    if (catImagesEl) catImagesEl.textContent = `🖼️ ${counts.images} Images`;
    if (catArchivesEl) catArchivesEl.textContent = `📦 ${counts.archives} Archives`;
    if (catMediaEl) catMediaEl.textContent = `🎵 ${counts.media} Media`;
  }

  // Query files from page
  async function fetchPageFiles() {
    fileCountEl.textContent = '...';
    const injection = await ensureContentScriptInjected();
    if (injection.success) {
      try {
        const res = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.GET_PAGE_FILES });
        if (res && res.status === 'ok') {
          updateFileStats(res.files || []);
          return;
        }
      } catch (_) {}
    }
    fileCountEl.textContent = '0';
  }

  await fetchPageFiles();

  // 3. Rescan button listener
  btnRescan?.addEventListener('click', async () => {
    btnRescan.disabled = true;
    btnRescan.textContent = 'Scanning...';
    try {
      const res = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.RESCAN });
      if (res && res.status === 'ok') {
        updateFileStats(res.files || []);
      }
    } catch (err) {
      console.warn('[BulkGrab Popup] Rescan error:', err);
    } finally {
      btnRescan.disabled = false;
      btnRescan.innerHTML = '<span>🔄 Rescan</span>';
    }
  });

  // 4. Open / Toggle grabber panel on active tab
  btnTogglePanel?.addEventListener('click', async () => {
    try {
      btnTogglePanel.disabled = true;
      const inj = await ensureContentScriptInjected();
      if (inj.success) {
        await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.TOGGLE_PANEL });
        window.close(); // Close popup once panel is open
      }
    } catch (err) {
      console.error('[BulkGrab Popup] Failed to toggle panel:', err);
      btnTogglePanel.disabled = false;
    }
  });
});
