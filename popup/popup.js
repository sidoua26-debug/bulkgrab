/**
 * BulkGrab - Popup Script
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

  // Query service worker for license and session status
  try {
    const response = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_STATUS });
    if (response && response.status === 'ok') {
      const isPro = response.licenseStatus === 'pro';
      
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

  // Placeholder file count for Step 1
  fileCountEl.textContent = 'Ready (Step 1)';

  // Open grabber panel button handler
  btnTogglePanel?.addEventListener('click', async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id) return;
    
    // In Step 1, ping or alert that scaffolding is loaded
    alert('BulkGrab is active! Ready to implement DOM scanning and panel in Step 2.');
  });
});
