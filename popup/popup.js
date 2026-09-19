/**
 * BulkGrab - Popup Script
 * Connects with Service Worker for license/quota and Content Script for file stats.
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
  
  if (!activeTab || !activeTab.id || !activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://')) {
    fileCountEl.textContent = 'Unavailable on system page';
    if (btnTogglePanel) btnTogglePanel.disabled = true;
    return;
  }

  // Helper to ensure content script is injected
  async function ensureContentScriptInjected() {
    try {
      // Test if already responding
      const ping = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.PING });
      if (ping && ping.status === 'alive') return true;
    } catch (_) {
      // Not yet injected, inject via scripting API
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content/content-script.js']
      });
      return true;
    } catch (err) {
      console.warn('[BulkGrab Popup] Could not inject content script:', err);
      return false;
    }
  }

  const injected = await ensureContentScriptInjected();
  if (injected) {
    try {
      const pageInfo = await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.GET_PAGE_FILES });
      if (pageInfo && pageInfo.status === 'ok') {
        const count = pageInfo.count || 0;
        fileCountEl.textContent = `${count} file${count === 1 ? '' : 's'} found`;
      }
    } catch (err) {
      fileCountEl.textContent = 'Detected on page';
    }
  } else {
    fileCountEl.textContent = 'Ready on user tabs';
  }

  // 3. Toggle/Open panel on active tab
  btnTogglePanel?.addEventListener('click', async () => {
    try {
      await ensureContentScriptInjected();
      await chrome.tabs.sendMessage(activeTab.id, { action: MESSAGE_ACTIONS.TOGGLE_PANEL });
      window.close(); // Close popup so user sees the page panel
    } catch (err) {
      console.error('[BulkGrab Popup] Failed to toggle panel:', err);
    }
  });
});
