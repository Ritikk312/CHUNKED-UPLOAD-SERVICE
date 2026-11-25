# Resumable / Chunked Upload Service (PST_AD_149)

**Author:** Ritik Saini  
**Collaborator:** Kanish  
**Project Track:** College OJT (PST_AD_149) - Level 4  

A beginner-friendly, resilient, chunked file upload web application built for college On-the-Job Training (OJT).

This project solves the problem of large file uploads failing over unreliable, slow, or intermittent network connections (such as hostel Wi-Fi or mobile hotspots). Instead of failing completely when a connection drops, files are split into **2 MB chunks**, uploaded sequentially, retried automatically with **exponential backoff**, safely **resumed from the exact point of interruption**, and verified for integrity using **SHA-256 checksums**.

---

## 👥 Student Team & Responsibilities

This project was built and designed for a 2-student engineering team:

| Student | Assigned Role | Components Owned |
| :--- | :--- | :--- |
| **Ritik Saini** | **Backend & Admin Systems** | • Flask Server (`app/server.py`)<br>• Session & Storage Logic (`app/session.py`)<br>• Sequential Chunk Merging & SHA-256 Verification<br>• Admin Endpoints & Test Mode API<br>• Automated Pytest Test Suite (`tests/`) |
| **Kanish** | **Frontend & Reliability UX** | • Resumable Uploader Engine (`app/static/js/uploader.js`)<br>• Cryptographic Hasher (`app/static/js/hash.js`)<br>• LocalStorage State Persistence (`app/static/js/store.js`)<br>• Responsive Bootstrap 5 UI (`index.html`, `style.css`)<br>• Interactive Chunk Map & Test Lab UI |

---

## 💡 Core Concepts for Student Presentation

When presenting this project to mentors and evaluators, use the following key concepts:

### 1. What is Chunking and Why Use It?
- **The Problem:** In standard single-request uploads (`multipart/form-data`), uploading a 200 MB file over a flaky connection means that if the network drops at 99%, the entire transfer fails and must start over from 0%.
- **The Solution:** The browser splits the file into fixed-size **2 MB binary slices**. Each slice is sent as an individual HTTP `PUT` request. If a drop occurs, only the current 2 MB slice fails—all previously completed chunks remain safe on the server.

### 2. Idempotent Chunk Storage
- Every chunk has a fixed index `0, 1, 2, ..., N-1`.
- Chunks are stored on the server as individual numbered files (`storage/uploads/<uploadId>/chunks/000000.part`).
- If a network timeout causes a retry, receiving the same chunk index a second time simply overwrites the part file without corrupting the upload.

### 3. Source of Truth: LocalStorage vs. Server
- **Client (localStorage):** Remembers the file's fingerprint (`name + size + lastModified`) and the server `uploadId`.
- **Server:** Acts as the **authoritative source of truth**. When resuming after a browser refresh, the client asks `GET /api/uploads/<uploadId>` which chunk indexes the server already has, and only transfers the missing chunks.

### 4. Exponential Backoff Auto-Retry
- When a chunk fails (due to network timeout or HTTP 500), the uploader pauses and retries with increasing delay:  
  **1s → 2s → 4s → 8s → 16s → 30s (capped)**.
- This prevents overwhelming the server or wasting cellular bandwidth during brief outages.

### 5. Two-Level SHA-256 Integrity Verification
- **Level 1 (Per-Chunk):** The client sends an `X-Chunk-SHA256` HTTP header with each chunk. The server computes the SHA-256 of the received bytes; if corrupted in transit, it rejects the chunk with HTTP 409 so the client can resend it.
- **Level 2 (Whole-File):** After all chunks arrive, the server merges them in numeric order and calculates the final SHA-256 checksum. If it matches the client's pre-calculated hash, the upload is marked `complete`. If not, it is marked `checksum_failed` and the bad file is deleted.

---

## 🛠️ Tech Stack

- **Frontend:** HTML5, CSS3 (Bootstrap 5.3), Vanilla JavaScript (ES6+), Web Crypto API (`crypto.subtle`), LocalStorage API.
- **Backend:** Python 3, Flask framework, Werkzeug, standard library (`hashlib`, `pathlib`, `uuid`).
- **Testing:** Pytest.
- **Storage:** Local disk directories (`storage/uploads/` and `storage/files/`) with JSON metadata. No S3, MinIO, or cloud dependencies required.

---

## 🚀 Installation & Running the Server

### Prerequisites
- Python 3.9 or higher

### Step 1: Clone and Set Up Virtual Environment
```bash
cd /Users/ritvikgodbole/Desktop/Ojt_Project
python3 -m venv .venv
source .venv/bin/activate
```

### Step 2: Install Dependencies
```bash
pip install -r requirements.txt
```

### Step 3: Run the Flask Application
```bash
python3 run.py
```
By default, the server starts on `http://127.0.0.1:5000` (or `http://0.0.0.0:5000` for local network access).

---

## 🖥️ Screen Guide & Core User Flows

### S1: Upload Screen
1. **Choose a File:** Drag and drop or browse for any file up to 500 MB (e.g. `.mp4`, `.zip`, `.pdf`).
2. **File Fingerprint:** The app calculates the 2 MB chunk breakdown and computes the initial SHA-256 hash with a preparation progress indicator.
3. **Start Upload:** Click **Start Upload**. Chunks upload sequentially.
4. **Chunk Map:** Watch the interactive chunk map update in real-time:
   - ⚪ **Waiting:** Chunk not yet uploaded.
   - 🔵 **Sending:** Currently in flight.
   - 🟢 **Done:** Successfully received and stored on server.
   - 🔴 **Failed:** Failed and scheduled for retry.
5. **Controls:** Use **Pause**, **Resume**, or **Cancel** at any time. (You can also press <kbd>Space</kbd> on your keyboard to pause/resume).
6. **Completion:** When 100% complete, the server merges the chunks, verifies the SHA-256 checksum, and provides a direct download link.

### S2: My Uploads Screen
- Lists all uploads initiated from this browser (persisted in `localStorage`).
- If an upload was interrupted (e.g., closing the tab at 40%), you will see a banner alerting you. Simply click **Resume**, pick the same file, and the app resumes from chunk 40%—not from 0%!

### S3: All Uploads (Admin Screen)
- Switch your role to **Platform Admin** in the top-right role switcher.
- View a server-wide inventory of all active and completed uploads.
- Inspect storage consumed on disk, received chunks, and delete test uploads.

### S4: Reliability Test Lab (Admin Screen)
- Simulate network drops with a slider from **0% to 50% failure rate**.
- Simulate **connection severance mid-upload** at a selected completion threshold (25%, 50%, or 75%).
- Configure batch test runs (1 to 30 runs) to verify repeated network survival and automatic recovery.
- Generate synthetic test files directly in memory (5 MB, 20 MB, or 50 MB).
- Run uploads through the simulated flaky connection and observe auto-retry with exponential backoff and successful checksum verification.

---

## 📡 REST API Reference

| Method | Endpoint | Description | Request Body / Headers | Response |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/uploads` | Create a new upload session | JSON: `{fileName, size, chunkSize, totalChunks, fileSha256}` | `201 Created`: `{uploadId}` |
| `GET` | `/api/uploads/<id>` | Query upload status and received chunks | None | `200 OK`: `{uploadId, received: [0, 1, ...], status, ...}` |
| `PUT` | `/api/uploads/<id>/chunks/<n>` | Upload raw bytes for chunk `n` | Body: raw binary bytes<br>Header: `X-Chunk-SHA256: <hex>` | `200 OK`: `{message: "saved", index: n, received: [...]}`<br>`409 Conflict`: Hash mismatch |
| `POST` | `/api/uploads/<id>/complete` | Merge chunks and verify final checksum | None | `200 OK`: `{status: "complete", downloadUrl, sha256}`<br>`400 Bad Request`: Checksum mismatch |
| `GET` | `/api/files/<id>` | Download the completed merged file | None | File download attachment |
| `GET` | `/api/admin/uploads` | List all sessions and disk usage | Header: `X-Role: admin` | `200 OK`: `{uploads: [...], storage: {...}}` |
| `DELETE`| `/api/admin/uploads/<id>` | Delete an upload session and files | Header: `X-Role: admin` | `200 OK`: `{message: "deleted"}` |
| `GET` | `/api/test/flaky?fail=20&kill_at=50` | Configure failure rate (0-50%) and mid-upload drop (%) | Query params: `fail`, `kill_at` | `200 OK`: `{flakyFailRate: 20, killAtPercent: 50}` |

---

## 🧪 Running Automated Tests

Run the full automated test suite using `pytest`:
```bash
.venv/bin/pytest -v
```

The test suite covers:
- Input validation (empty names, 0-byte files, >500 MB files, mismatched chunk counts).
- Per-chunk SHA-256 verification and HTTP 409 rejection of corrupted chunks.
- Idempotent resending of chunks.
- Out-of-order chunk arrival and sequential reassembly.
- Final merged file SHA-256 verification.
- Edge case file sizes: **1 byte**, **exactly 2 MB**, and **2 MB + 1 byte**.
- Admin authorization and upload deletion.
- Flaky network test mode.

---

## ⚠️ Known Limitations & Assumptions

1. **Sequential vs. Parallel:** Chunks are sent one after another. Parallel multi-chunk uploading is intentionally omitted to keep code simple and beginner-friendly for college demonstration.
2. **Local Storage:** Files and chunk parts are stored in the local file system (`storage/`). Cloud object stores (S3, MinIO) are not used per PRD requirements.
3. **Single Uploader per File:** Upload sessions are associated with one client at a time; multi-user collaborative uploading of the same file session is out of scope.
4. **Browser Fingerprint:** File identification is based on file name, byte size, and last modified timestamp (`File.lastModified`).
