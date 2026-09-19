import { MESSAGE_ACTIONS } from '../utils/constants.js';

let responded = false;

async function notifyResult(granted) {
  if (responded) return;
  responded = true;
  try {
    await chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.PERMISSION_RESPONSE,
      granted: Boolean(granted)
    });
  } catch (err) {
    console.warn('[BulkGrab Permission] Failed to send response:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const allowBtn = document.getElementById('btn-allow');
  const cancelBtn = document.getElementById('btn-cancel');

  allowBtn?.addEventListener('click', async () => {
    try {
      // Must be called within direct user gesture on extension page
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      await notifyResult(granted);
    } catch (err) {
      console.error('[BulkGrab Permission] Request error:', err);
      await notifyResult(false);
    } finally {
      window.close();
    }
  });

  cancelBtn?.addEventListener('click', async () => {
    await notifyResult(false);
    window.close();
  });

  window.addEventListener('beforeunload', () => {
    if (!responded) {
      notifyResult(false);
    }
  });
});
