# Chrome Web Store Listing: BulkGrab

*Single source of truth for Chrome Web Store listing metadata, permissions justifications, and privacy disclosures.*

## Store Listing Metadata

- **Extension Name**: BulkGrab - Bulk File Downloader
- **Summary / Short Description**: Detect, select, and bulk download files from webpages with freemium and ZIP export options.
- **Detailed Description**:
  BulkGrab makes it effortless to find and download files embedded across webpages.

  Key Features:
  • Smart Detection: Automatically detects downloadable files (PDFs, images, audio, video, documents, and archives).
  • Interactive In-Page Panel: View all detected files in a non-intrusive floating panel with instant search and select-all controls.
  • Freemium Flexibility: Download up to 3 files per session for free, or unlock Pro for unlimited batch downloading.
  • Client-Side ZIP Packaging: Bundle multiple files into a single organized ZIP archive directly inside your browser.
  • Privacy First: All scanning and file bundling happens locally on your device.

- **Category**: Productivity / Tools
- **Version**: 1.0.0
- **Support Contact / URL**: support@bulkgrab.example.com

---

## Permissions Justification

Chrome Web Store requires a plain-English explanation for every requested permission:

### `downloads`
> **Justification**: Required to download user-selected files (such as PDFs, images, archives, audio, and documents) detected on webpages directly to the user's local Downloads directory without repetitive manual save prompts.

### `activeTab`
> **Justification**: Required to inspect the current webpage for downloadable media links only when invoked by the user via the extension action, strictly avoiding broad `<all_urls>` permissions.

### `scripting`
> **Justification**: Required to dynamically inject the DOM file scanner and interactive floating grabber panel into the active tab on user demand.

### `storage`
> **Justification**: Required to persist user license status (Free vs. Pro) and track session download counts for free-tier quota enforcement.

### Host Permissions
> **Status**: Left empty by default. All interactions are driven through `activeTab` upon user action.

---

## Asset Checklist & Pre-Submission Notes

- [ ] **Icons**:
  - [x] Placeholder icons generated (16x16, 48x48, 128x128)
  - [ ] **Action required before final submission**: Replace with polished final brand icons.
- [ ] **Licensing Backend (CRITICAL)**:
  - [ ] **Action required before final submission**: The current build contains a local development stub (`verifyLicense` in `background/service-worker.js`) that validates test session IDs starting with `cs_test_`. For production Web Store release, deploy the provided Cloudflare Worker (see `README.md`) to verify Stripe checkout sessions against the Stripe API, and update the endpoint URL in `background/service-worker.js`.
- [ ] **Store Promotional Screenshots**:
  - [ ] 1280x800 or 640x400 screenshot of in-page floating grabber panel.
  - [ ] Screenshot of Popup UI showing detected file stats.
  - [ ] Screenshot of options/licensing interface.
- [ ] **Privacy Policy & Single Purpose**:
  - **Single Purpose**: BulkGrab provides in-page detection and streamlined downloading of downloadable files and media.
  - **Data Transmission**: BulkGrab does not collect, track, or transmit user data, browsing history, or webpage contents to external servers. All file scanning, selection, and archive bundling execute entirely locally on the user's device.
  - **Licensing Verification**: When a user activates a Pro tier license, only the user-submitted Stripe checkout session ID is sent to the verification backend to validate purchase status. No personal data or browsing details are transmitted.

