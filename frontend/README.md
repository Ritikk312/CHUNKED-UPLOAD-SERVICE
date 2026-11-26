# Resumable Chunked Upload Service - Frontend Client

**Author / Maintainer:** Frontend Lead (OJT Track: PST_AD_149)  
**Backend Partner Repository:** [Ritikk312/CHUNKED-UPLOAD-SERVICE](https://github.com/Ritikk312/CHUNKED-UPLOAD-SERVICE) (Python Flask)

This is the standalone frontend client for the **Resumable / Chunked Upload Service**. It is built using HTML5, Bootstrap 5, and vanilla JavaScript without heavy framework dependencies.

---

## 🌟 Key Frontend Features

1. **Client-Side Slicing:** Splits files up to 10 GB into sequential 2 MB chunks using the browser's `File.slice()` API.
2. **Web Crypto SHA-256 Hashing (`hash.js`):** Computes per-chunk hashes for the `X-Chunk-SHA256` header and prepares whole-file fingerprints before upload.
3. **Resumable Upload Engine (`uploader.js`):**
   - Sequential chunk uploading with real-time speed (MB/s) and ETA calculations.
   - Automatic retry with exponential backoff (1s, 2s, 4s, 8s, up to 30s) during network drops.
   - Pause, resume, and keyboard control (<kbd>Space</kbd> key).
4. **LocalStorage Persistence (`store.js`):**
   - Remembers upload sessions across browser refreshes and tab closures.
   - Queries the backend for missing chunk indexes and sends only what's needed.
5. **Interactive UI Screens:**
   - **S1 (Upload):** Dynamic chunk map grid (waiting, sending, completed, failed states).
   - **S2 (My Uploads):** Browser upload history with one-click resume.
   - **S3 (Admin Inventory):** Server session overview and storage metrics.
   - **S4 (Reliability Test Lab):** Flakiness slider (0–50%), mid-upload connection kill simulation, and batch test runners.

---

## 🚀 How to Run the Frontend

### Option A: Open directly in your browser
Simply double-click `index.html` or open it in Google Chrome / Safari / Edge.

### Option B: Run with any local HTTP server
Using Python:
```bash
python3 -m http.server 3000
```
Then visit **`http://localhost:3000`** in your browser.

Using VS Code:
Right-click `index.html` and click **"Open with Live Server"**.

---

## 🔗 Connecting to the Python Backend

This frontend connects to the Python Flask backend service. By default, it looks for the backend at:
```text
http://localhost:5050
```

Make sure the Python backend is running on `http://localhost:5050`:
```bash
python3 run.py
```
*(The Python server includes CORS headers to allow cross-origin requests from this frontend).*
