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
  - Paste NOWPayments Payment ID to activate Pro.
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

## How NOWPayments License Verification Works

The extension uses NOWPayments for cryptocurrency payments and includes status verification in [`background/service-worker.js`](background/service-worker.js):

- **Cloudflare Worker Proxy Architecture**: Keeps your private NOWPayments API key completely secure. The extension queries your Cloudflare Worker backend (`/api/verify-payment?payment_id=...`), which calls NOWPayments with `x-api-key`.
- **Status Handling**:
  - `finished`: Confirms payment and activates Pro tier.
  - `waiting`: Informs the user that payment is awaiting transaction broadcast.
  - `confirming`: Informs the user that transaction is detected on chain and awaiting block confirmations (2–5 minutes).
  - `partially_paid`: Alerts the user of underpayment and specifies remaining amount.
  - `failed` / `expired`: Explains that payment failed or expired.

### Testing License Activation:
1. Open the Options page by clicking the gear icon (⚙️) in the popup or right-clicking the extension icon -> **Options**.
2. In the **NOWPayments Payment ID** input, enter any valid Payment ID (e.g. `5829104812`, or test IDs like `test_waiting_1`, `test_confirming_2`, `test_partially_paid_3`).
3. Click **Activate Pro**.
4. The badge will immediately update to **PRO Active**, unlocking unlimited downloads and the "📦 ZIP" feature.
5. Click **Reset to Free Tier (For Testing)** anytime to revert back to the Free plan.

---

## Setting Up NOWPayments (Crypto Payments)

To point licensing at a production NOWPayments and Cloudflare Worker backend:

### 1. Create a Static Payment Link in NOWPayments
1. Log into your [NOWPayments Dashboard](https://account.nowpayments.io).
2. Go to **Payment Links** (or Store / Invoices) in the sidebar.
3. Click **Create payment link**:
   - **Price**: `$9.99`
   - **Price Currency**: `USD`
   - **Pay Currency**: Select `USDTBSC` (or multi-currency accepting any coin converted to your USDT BSC payout address).
   - **Order Description**: `BulkGrab Pro Lifetime License`
4. Copy the resulting Payment Link URL and paste it as `NOWPAYMENTS_PAYMENT_URL` in [`utils/constants.js`](utils/constants.js).

### 2. Deploy the Cloudflare Worker Backend
The complete Worker code is provided in [`cloudflare-worker/worker.js`](cloudflare-worker/worker.js).

#### Option A: Cloudflare Dashboard (Browser — 2 Minutes, Zero Install)
1. Log into [dash.cloudflare.com](https://dash.cloudflare.com) (free account).
2. In the left sidebar, click **Compute (Workers & Pages)** -> **Create**.
3. Select the **Workers** tab and click **Create Worker**.
4. Name your worker (e.g. `bulkgrab-licensing`) and click **Deploy**.
5. Click **Edit Code** (top right):
   - Replace the default code with the contents of [`cloudflare-worker/worker.js`](cloudflare-worker/worker.js).
   - Click **Deploy** (or **Save and Deploy**).
6. Configure your secret keys:
   - Go to your Worker's **Settings** tab -> **Variables and Secrets**.
   - Under **Secrets**, click **Add**:
     - Name: `NOWPAYMENTS_API_KEY` -> Paste your private API key.
     - Name: `NOWPAYMENTS_IPN_KEY` -> Paste your private IPN key.
   - Click **Deploy** / **Save**.
7. Note your live Worker URL (e.g. `https://bulkgrab-licensing.<your-subdomain>.workers.dev`).

#### Option B: Wrangler CLI
```bash
cd cloudflare-worker
npx wrangler login
npx wrangler secret put NOWPAYMENTS_API_KEY
npx wrangler secret put NOWPAYMENTS_IPN_KEY
npx wrangler deploy
```

### 3. Set Webhook URL in NOWPayments Dashboard
1. In the NOWPayments dashboard, navigate to **Settings** -> **Payment settings** -> **Instant Payment Notifications (IPN)**.
2. Enter your live Worker webhook URL:
   ```
   https://bulkgrab-licensing.<your-subdomain>.workers.dev/api/webhook
   ```
3. Click **Save** and use the **Test IPN** button to verify connectivity.

### 4. Connect Worker URL to Extension
In [`utils/constants.js`](utils/constants.js), update `NOWPAYMENTS_WORKER_URL`:
```javascript
export const NOWPAYMENTS_WORKER_URL = 'https://bulkgrab-licensing.<your-subdomain>.workers.dev/api/verify-payment';
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
- Options page NOWPayments payment ID verification and empty/whitespace rejection.
- Pro-tier batch downloading & JSZip archive creation.
- Resetting back to Free plan.
- CORS partial-failure ZIP bundling & fallback download delegation.
- Grabber panel rendering without stack overflow.
- Dynamic license tier update via storage events without page reload.
- Cross-origin host permissions prompt and background archive creation.
- Comprehensive NOWPayments status handling (`finished`, `waiting`, `confirming`, `partially_paid`).

---

## Manual Test Checklist

1. **Unpacked Load**: Load extension in `chrome://extensions` — verify no error badges.
2. **Detection**: Open `http://localhost:8124/test-page.html`, click extension icon -> **Open Grabber Panel** — verify 11 files detected across tabs (`Docs`, `Images`, `Archives`, `Media`).
3. **Selection**: Toggle **Select All**, filter by category tab, deselect individual files.
4. **Free Quota Cap**: Select 8 files on Free tier and click download — verify quota warning appears.
5. **Sequential Download**: Select 2 files on Free tier — verify files download one after another and session quota updates to `2 / 7 used`.
6. **Navigation Badge Clear**: Navigate tab to a new URL — verify toolbar badge clears immediately.
7. **License Upgrade**: Open Options, enter `5829104812`, click **Activate Pro** — verify Pro Active badge appears and open tabs immediately unlock without reload.
8. **Pro ZIP Bundling**: In the floating panel, select files and click **📦 ZIP** — verify JSZip bundles files client-side or via background worker.
9. **Reset**: In Options, click **Reset to Free Tier** — verify status downgrades back to Free across all open tabs.
