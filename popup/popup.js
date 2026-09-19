/**
 * BulkGrab - Popup Script
 * Connects with Service Worker for license/quota and Content Script for live tab file stats.
 */

import { MESSAGE_ACTIONS, STRIPE_PAYMENT_URL, FREE_DOWNLOAD_LIMIT } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', async () => {
  const tierBadge = document.getElementById('tier-badge');
  const fileCountEl = document.getElementById('file-count');
  const downloadQuotaEl = document.getElementById('download-quota');
  const btnOptions = document.getElementById('btn-options');
  const btnUpgrade = document.getElementById('btn-upgrade');
  const btnTogglePanel = document.getElementById('btn-toggle-panel');

  // Open options page
  btnOptions?.addEventListener('click', (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options/options.html'));
    }
  });

  // 1. Fetch license and session quota status from Service Worker
  let isPro = false;
  try {
    const response = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_STATUS });
    if (response && response.status === 'ok') {
      isPro = response.licenseStatus === 'pro';
      
      if (isPro) {
        tierBadge.textContent = 'PRO Active';
        tierBadge.className = 'badge badge-pro';
        downloadQuotaEl.textContent = 'Unlimited (Pro)';
        if (btnUpgrade) btnUpgrade.style.display = 'none';
      } else {
        tierBadge.textContent = 'Free Plan';
        tierBadge.className = 'badge badge-free';
        const used = response.sessionDownloads || 0;
        downloadQuotaEl.textContent = `${used} / ${FREE_DOWNLOAD_LIMIT} used`;
        if (btnUpgrade) btnUpgrade.href = STRIPE_PAYMENT_URL;
      }
    }
  } catch (err) {
    console.warn('[BulkGrab Popup] Could not retrieve status from SW:', err);
  }

  // 2. Query active tab for detected downloadable files
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  // Guard against non-scriptable URLs
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
    fileCountEl.textContent = 'Unavailable on system page';
    if (btnTogglePanel) {
      btnTogglePanel.disabled = true;
      btnTogglePanel.title = 'BulkGrab cannot run on browser system pages or Chrome Web Store';
    }
    return;
  }

  // Helper to ensure content script is injected using activeTab permission
  async function ensureContentScriptInjected() {
    try {
      // 1. Test if content script is already answering
      const ping = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.PING });
      if (ping && ping.status === 'alive') {
        return { success: true, count: ping.fileCount };
      }
    } catch (_) {
      // Not yet injected or page was loaded before extension was loaded
    }

    try {
      // 2. Dynamically inject via scripting API granted by activeTab user gesture
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content/content-script.js']
      });

      // Allow a brief moment for DOM scan & Shadow DOM mount
      await new Promise(r => setTimeout(r, 100));

      const pageInfo = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.GET_PAGE_FILES });
      return { success: true, count: pageInfo?.count || 0 };
    } catch (err) {
      console.warn('[BulkGrab Popup] Could not inject content script:', err);
      return { success: false, error: err.message };
    }
  }

  const result = await ensureContentScriptInjected();
  if (result.success) {
    const count = result.count || 0;
    fileCountEl.textContent = `${count} file${count === 1 ? '' : 's'} found`;
  } else {
    fileCountEl.textContent = 'Cannot scan this page';
    if (btnTogglePanel) btnTogglePanel.disabled = true;
  }

  // 3. Toggle/Open panel on active tab
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
