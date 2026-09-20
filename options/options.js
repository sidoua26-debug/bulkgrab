/**
 * BulkGrab - Options Page Script
 * Manages license activation stub, tier inspection, and reset controls.
 */

import { MESSAGE_ACTIONS, FREE_DOWNLOAD_LIMIT } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', async () => {
  const tierBadge = document.getElementById('tier-badge');
  const tierDescription = document.getElementById('tier-description');
  const sessionInfoBox = document.getElementById('session-info-box');
  const activeSessionId = document.getElementById('active-session-id');
  const paymentIdInput = document.getElementById('payment-id-input') || document.getElementById('charge-id-input') || document.getElementById('session-id-input');
  const btnActivate = document.getElementById('btn-activate');
  const btnReset = document.getElementById('btn-reset');
  const btnResetQuota = document.getElementById('btn-reset-quota');
  const statusMsg = document.getElementById('status-message');

  function showMessage(text, type = 'success') {
    statusMsg.className = `status-alert ${type}`;
    statusMsg.textContent = text;
    statusMsg.style.display = 'block';
  }

  function hideMessage() {
    statusMsg.style.display = 'none';
  }

  const permBadge = document.getElementById('perm-badge');
  const btnTogglePerm = document.getElementById('btn-toggle-perm');

  // Render status in UI
  async function refreshUI() {
    hideMessage();
    try {
      const res = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_STATUS });
      if (res && res.status === 'ok') {
        const isPro = res.licenseStatus === 'pro';

        if (isPro) {
          tierBadge.textContent = 'PRO Active';
          tierBadge.className = 'badge badge-pro';
          tierDescription.textContent = 'You have unlocked BulkGrab PRO. Unlimited batch downloads and client-side ZIP packaging are enabled!';
          
          const paymentId = res.nowpaymentsPaymentId || res.paymentId || res.coinbaseChargeId || res.chargeId;
          if (paymentId) {
            sessionInfoBox.style.display = 'flex';
            activeSessionId.textContent = paymentId;
            if (paymentIdInput) paymentIdInput.value = paymentId;
          } else {
            sessionInfoBox.style.display = 'none';
          }
          btnActivate.textContent = 'Re-verify License';
        } else {
          tierBadge.textContent = 'Free Plan';
          tierBadge.className = 'badge badge-free';
          const used = res.sessionDownloads || 0;
          tierDescription.textContent = `You are on the Free Plan. Quota: ${used} / ${res.freeLimit || FREE_DOWNLOAD_LIMIT} downloads used this session. Single-file sequential downloading only.`;
          sessionInfoBox.style.display = 'none';
          if (paymentIdInput) paymentIdInput.value = '';
          btnActivate.textContent = 'Activate Pro';
        }
      }

      // Check optional permissions state
      if (chrome.permissions && chrome.permissions.contains) {
        const hasPerm = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        if (hasPerm) {
          permBadge.textContent = 'Granted';
          permBadge.className = 'badge badge-pro';
          btnTogglePerm.textContent = 'Revoke Access';
        } else {
          permBadge.textContent = 'Not Granted';
          permBadge.className = 'badge badge-free';
          btnTogglePerm.textContent = 'Grant Cross-Site Access';
        }
      }
    } catch (err) {
      console.warn('[BulkGrab Options] Could not get status:', err);
    }
  }

  // Toggle optional permissions
  btnTogglePerm?.addEventListener('click', async () => {
    try {
      const hasPerm = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      if (hasPerm) {
        await chrome.permissions.remove({ origins: ['<all_urls>'] });
        showMessage('Cross-site permission revoked.', 'info');
      } else {
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        if (granted) {
          showMessage('Cross-site ZIP access granted!', 'success');
        } else {
          showMessage('Permission was not granted.', 'error');
        }
      }
      await refreshUI();
    } catch (err) {
      showMessage(`Permission error: ${err.message}`, 'error');
    }
  });

  await refreshUI();

  // Activate Pro button
  btnActivate.addEventListener('click', async () => {
    const paymentId = paymentIdInput ? paymentIdInput.value.trim() : '';
    if (!paymentId) {
      showMessage('Please enter your NOWPayments Payment ID (e.g. 5829104812).', 'error');
      return;
    }

    btnActivate.disabled = true;
    btnActivate.textContent = 'Verifying with NOWPayments...';

    try {
      const response = await chrome.runtime.sendMessage({
        action: MESSAGE_ACTIONS.VERIFY_LICENSE,
        paymentId: paymentId
      });

      if (response && response.valid) {
        showMessage(response.message || 'Pro license activated successfully!', 'success');
        await refreshUI();
      } else if (response && response.pending) {
        showMessage(response.error || 'Payment detected on blockchain but awaiting confirmation. Please try again in 2-5 minutes.', 'info');
      } else {
        showMessage(response?.error || 'License verification failed.', 'error');
      }
    } catch (err) {
      showMessage(`Verification error: ${err.message}`, 'error');
    } finally {
      btnActivate.disabled = false;
      btnActivate.textContent = 'Activate Pro';
    }
  });

  // Reset to Free Tier button
  btnReset.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.RESET_LICENSE });
      if (res && res.valid) {
        showMessage('License successfully reset to Free tier.', 'success');
        await refreshUI();
      }
    } catch (err) {
      showMessage(`Reset error: ${err.message}`, 'error');
    }
  });

  // Reset session quota button
  btnResetQuota.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.RESET_SESSION_QUOTA });
      if (res && res.status === 'ok') {
        showMessage('Session download count reset to 0.', 'success');
        await refreshUI();
      }
    } catch (err) {
      showMessage(`Quota reset error: ${err.message}`, 'error');
    }
  });
});
