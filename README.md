# BulkGrab — Bulk File Downloader Chrome Extension (Manifest V3)

BulkGrab is a lightweight, privacy-focused Chrome Extension (Manifest V3) that detects, filters, and bulk-downloads downloadable files from webpages with a freemium model.

---

## Architecture & Features

- **DOM File Scanner (`content/content-script.js`)**:
  - Scans `<a>`, `<area>`, `<img>`, `<video>`, `<audio>`, and `<source>` tags for downloadable files.
  - Recognizes documents (`pdf`, `docx`, `xlsx`, `txt`), images (`jpg`, `png`, `svg`), archives (`zip`, `tar`, `gz`), and media (`mp3`, `mp4`).
  - Configurable file extensions in [`utils/constants.js`](utils/constants.js).
- **Isolated In-Page UI (`content/content-style.css`)**:
  - Encapsulated within a native **Shadow DOM** (`#bulkgrab-root`) so host page CSS cannot break extension styles.
  - Floating, draggable header with collapse/minimize (`−`) and close (`×`) controls.
  - Extension filter tabs (`All`, `Docs`, `Images`, `Archives`, `Media`) with live counts.
  - Search filter and "Select All" toggle checkbox.
  - Download buttons: "⬇ Download Selected" and "📦 ZIP" (Pro).
- **Service Worker (`background/service-worker.js`)**:
  - Coordinates `chrome.downloads.download` API calls.
  - Free tier: allows up to 7 downloads per browser session, executed sequentially one at a time.
  - Pro tier: unlimited batch downloads and client-side ZIP archiving.
  - Listens to `chrome.tabs.onUpdated` to clear toolbar badges on page navigation.
- **Action Popup (`popup/popup.html`, `popup.js`, `popup.css`)**:
  - Displays the active page's domain and total downloadable file count.
  - Category breakdown pills (`📄 Docs`, `🖼️ Images`, `📦 Archives`, `🎵 Media`).
  - Session quota progress bar (`X / 7 used`).
  - Direct "Open Grabber Panel", "Rescan Page", and "Upgrade to Pro" triggers.
- **Settings & Licensing (`options/options.html`, `options.js`)**:
  - Manage license tier (`Free` vs `Pro`).
  - Paste Coinbase Commerce Charge ID to activate Pro.
  - Reset controls to easily toggle back to Free tier or clear session quota during testing.

---

## Loading the Extension in Chrome

1. Clone or open this repository directory:
   ```
   /home/sid/projects/bulkgrab
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `/home/sid/projects/bulkgrab` folder.
6. Confirm **"BulkGrab - Bulk File Downloader"** appears with zero manifest errors.

---

## How the License Stub Works

The extension uses Coinbase Commerce for crypto payments and includes a swappable verification stub in [`background/service-worker.js`](background/service-worker.js):

```javascript
export async function verifyLicense(chargeId) {
  if (!chargeId || typeof chargeId !== 'string' || !chargeId.trim()) {
    return {
      valid: false,
      error: 'Please enter a valid Coinbase Commerce charge ID.'
    };
  }

  const trimmed = chargeId.trim();

  // Stub logic: accepts any non-empty string as valid for local development/testing
  await chrome.storage.local.set({
    [STORAGE_KEYS.LICENSE_STATUS]: 'pro',
    [STORAGE_KEYS.COINBASE_CHARGE_ID]: trimmed
  });

  console.log(`[BulkGrab Service Worker] Coinbase Commerce license stub verified: ${trimmed}`);
  broadcastLicenseChange('pro');

  return {
    valid: true,
    status: 'pro',
    chargeId: trimmed,
    message: 'Coinbase Commerce crypto payment confirmed! Pro tier activated.'
  };
}
```

### Testing License Activation:
1. Open the Options page by clicking the gear icon (⚙️) in the popup or right-clicking the extension icon -> **Options**.
2. In the **Coinbase Commerce Charge ID** input, enter any test charge code or ID (e.g. `W6D7GXYZ`, `83647472-a1b2-4c3d-8e5f-123456789abc`, or `cb_test_123`).
3. Click **Activate Pro**.
4. The badge will immediately change to **PRO Active**, unlocking unlimited downloads and the "📦 ZIP" feature.
5. Click **Reset to Free Tier (For Testing)** anytime to revert back to the Free plan.

---

## Setting Up Coinbase Commerce (Crypto Payments)

To point licensing at a production Coinbase Commerce and Cloudflare Worker backend:

### 1. Create a Coinbase Commerce Account
1. Register at [Coinbase Commerce](https://commerce.coinbase.com).
2. Complete merchant onboarding and link your cryptocurrency payout wallet.

### 2. Create a Checkout Link
1. In the Coinbase Commerce dashboard, navigate to **Payments** or **Checkouts**.
2. Create a new hosted checkout for **BulkGrab Pro** priced at **$9.99**.
3. Copy the checkout URL and set it as `COINBASE_CHECKOUT_URL` in [`utils/constants.js`](utils/constants.js).

### 3. Generate an API Key
1. In the Coinbase Commerce dashboard, go to **Settings** -> **Security**.
2. Click **Create an API key**.
3. Copy the API key and store it securely in your Cloudflare Worker as an encrypted environment secret named `COINBASE_COMMERCE_API_KEY`:
   ```bash
   wrangler secret put COINBASE_COMMERCE_API_KEY
   ```

### 4. Cloudflare Worker Implementation (`worker.js`)
To keep your API key secure, charge status must be verified on your server/worker:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/verify-coinbase') {
      const chargeId = url.searchParams.get('charge_id');
      if (!chargeId) {
        return new Response(JSON.stringify({ valid: false, error: 'Missing charge_id parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        // 1. Fetch charge from Coinbase Commerce API
        const response = await fetch(`https://api.commerce.coinbase.com/charges/${encodeURIComponent(chargeId)}`, {
          method: 'GET',
          headers: {
            'X-CC-Api-Key': env.COINBASE_COMMERCE_API_KEY,
            'X-CC-Version': '2018-03-22',
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          return new Response(JSON.stringify({ valid: false, error: `Coinbase API returned HTTP ${response.status}` }), {
            status: response.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const json = await response.json();
        const charge = json.data;

        // 2. Check the charge timeline for COMPLETED status (not PENDING, UNRESOLVED, or EXPIRED)
        const timeline = charge.timeline || [];
        const isCompleted = timeline.some(entry => entry.status === 'COMPLETED') || charge.status === 'COMPLETED';
        const isPending = timeline.some(entry => entry.status === 'PENDING') || charge.status === 'PENDING';

        if (!isCompleted) {
          if (isPending) {
            return new Response(JSON.stringify({
              valid: false,
              pending: true,
              error: 'Crypto payment detected on blockchain but awaiting confirmation. Please try again in 2-5 minutes.'
            }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }
          const latestStatus = timeline[timeline.length - 1]?.status || charge.status || 'NEW';
          return new Response(JSON.stringify({
            valid: false,
            error: `Payment is not completed. Current status: ${latestStatus}`
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // 3. Verified completed charge
        return new Response(JSON.stringify({
          valid: true,
          status: 'pro',
          chargeId: charge.id,
          chargeCode: charge.code,
          customerEmail: charge.metadata?.customer_email
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ valid: false, error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
```

> [!NOTE]
> **Blockchain Confirmation Window**: Cryptocurrency transactions must be confirmed on the blockchain before Coinbase Commerce marks them `COMPLETED` (usually 2–10 minutes depending on network congestion). BulkGrab's Options UI informs users and handles pending states gracefully.

### 5. Update `verifyLicense(chargeId)` in `background/service-worker.js`
Replace the local stub in `verifyLicense()` with the fetch call to your Cloudflare Worker:

```javascript
export async function verifyLicense(chargeId) {
  try {
    const response = await fetch(
      `https://your-worker.workers.dev/api/verify-coinbase?charge_id=${encodeURIComponent(chargeId)}`
    );
    const data = await response.json();
    if (!data.valid) {
      return { valid: false, pending: data.pending, error: data.error || 'Payment not verified.' };
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.LICENSE_STATUS]: 'pro',
      [STORAGE_KEYS.COINBASE_CHARGE_ID]: chargeId.trim()
    });

    broadcastLicenseChange('pro');
    return { valid: true, status: 'pro', message: 'Pro license verified successfully!' };
  } catch (err) {
    return { valid: false, error: `Verification request failed: ${err.message}` };
  }
}
```

---

## Running Automated Tests

Run the full Puppeteer test suite:
```bash
npm test
```

This runs end-to-end automated tests validating:
- DOM scanning & Shadow DOM file listing.
- Tab-scoped badge count updates.
- Popup hero numbers & category breakdown pills.
- Free-tier 7-download session limit enforcement and rejection.
- Badge clearing on tab navigation.
- Options page Coinbase Commerce charge ID verification stub and empty/garbage rejection.
- Pro-tier batch downloading & JSZip archive creation.
- Resetting back to Free plan.
- CORS partial-failure ZIP bundling & fallback download delegation.
- Grabber panel rendering without stack overflow.
- Dynamic license tier update via storage events without page reload.
- Cross-origin host permissions prompt and background archive creation.

---

## Manual Test Checklist

1. **Unpacked Load**: Load extension in `chrome://extensions` — verify no error badges.
2. **Detection**: Open `http://localhost:8080/test-page.html`, click extension icon -> **Open Grabber Panel** — verify 11 files detected across tabs (`Docs`, `Images`, `Archives`, `Media`).
3. **Selection**: Toggle **Select All**, filter by category tab, deselect individual files.
4. **Free Quota Cap**: Select 8 files on Free tier and click download — verify quota warning appears.
5. **Sequential Download**: Select 2 files on Free tier — verify files download one after another and session quota updates to `2 / 7 used`.
6. **Navigation Badge Clear**: Navigate tab to a new URL — verify toolbar badge clears immediately.
7. **License Upgrade**: Open Options, enter `cb_test_charge_123` or `W6D7GXYZ`, click **Activate Pro** — verify Pro Active badge appears and open tabs immediately unlock without reload.
8. **Pro ZIP Bundling**: In the floating panel, select files and click **📦 ZIP** — verify JSZip bundles files client-side or via background worker.
9. **Reset**: In Options, click **Reset to Free Tier** — verify status downgrades back to Free across all open tabs.
