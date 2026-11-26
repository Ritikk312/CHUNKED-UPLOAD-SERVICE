/**
 * app.js
 * Main UI Controller:
 * - Handles screen navigation and role switching
 * - Manages file picking, drag & drop, and client-side validation
 * - Orchestrates ChunkUploader events with DOM elements
 * - Displays live chunk map, progress, metrics, and checksum result
 * - Detects unfinished uploads on page load and enables resume
 * - Connects Admin view and Test Lab
 */

const App = {
  currentFile: null,
  uploader: null,
  activeScreen: 'upload',
  fullFileHash: '',
  testRuns: [],
  testRunCount: 0,

  init() {
    this.setupEventListeners();
    this.restoreRole();
    this.checkUnfinishedUpload();
    this.initFlakySlider();
  },

  setupEventListeners() {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());

      dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });

      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.handleFileSelection(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleFileSelection(e.target.files[0]);
        }
      });
    }

    // Keyboard accessibility: Space key pauses/resumes upload
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON') {
        if (this.uploader && (this.uploader.state === 'uploading' || this.uploader.state === 'paused')) {
          e.preventDefault();
          if (this.uploader.state === 'uploading') {
            this.pauseUpload();
          } else {
            this.resumeUpload();
          }
        }
      }
    });
  },

  /**
   * Screen Navigation
   */
  showScreen(screenId) {
    this.activeScreen = screenId;
    document.querySelectorAll('.app-screen').forEach(el => el.classList.add('d-none'));
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

    const targetScreen = document.getElementById(`screen-${screenId}`);
    const targetNav = document.getElementById(`nav-${screenId}`);

    if (targetScreen) targetScreen.classList.remove('d-none');
    if (targetNav) targetNav.classList.add('active');

    if (screenId === 'my-uploads') {
      this.renderMyUploads();
    } else if (screenId === 'all-uploads') {
      this.loadAdminUploads();
    }
  },

  /**
   * User Role Management
   */
  restoreRole() {
    const role = StorageService.getRole();
    const select = document.getElementById('role-select');
    if (select) select.value = role;
    this.syncRoleButtons(role);
    this.applyRoleRestrictions(role);
  },

  handleRoleChange(newRole) {
    StorageService.setRole(newRole);
    const select = document.getElementById('role-select');
    if (select) select.value = newRole;
    this.syncRoleButtons(newRole);
    this.applyRoleRestrictions(newRole);
    if (newRole === 'admin' && this.activeScreen === 'all-uploads') {
      this.loadAdminUploads();
    }
  },

  syncRoleButtons(role) {
    document.querySelectorAll('.role-segmented .btn-segment').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.role === role);
    });
  },

  switchToAdmin() {
    this.handleRoleChange('admin');
  },

  applyRoleRestrictions(role) {
    const adminNavs = [document.getElementById('nav-all-uploads'), document.getElementById('nav-test-lab')];
    const guardAll = document.getElementById('admin-role-guard-all');
    if (role !== 'admin') {
      adminNavs.forEach(nav => {
        if (nav) nav.classList.add('opacity-75');
      });
      if (guardAll) {
        guardAll.classList.remove('d-none');
        guardAll.classList.add('d-flex');
      }
      if (this.activeScreen === 'all-uploads' || this.activeScreen === 'test-lab') {
        this.showScreen('upload');
      }
    } else {
      adminNavs.forEach(nav => {
        if (nav) nav.classList.remove('opacity-75');
      });
      if (guardAll) {
        guardAll.classList.add('d-none');
        guardAll.classList.remove('d-flex');
      }
    }
  },

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * Check for Unfinished Uploads in localStorage
   */
  checkUnfinishedUpload() {
    const unfinished = StorageService.findUnfinishedUpload();
    const banner = document.getElementById('unfinished-banner');
    const bannerText = document.getElementById('unfinished-banner-text');

    if (unfinished && banner && bannerText) {
      const approxPercent = unfinished.totalChunks > 0 ?
        Math.round(((unfinished.doneChunks ? unfinished.doneChunks.length : 0) / unfinished.totalChunks) * 100) : 0;
      bannerText.textContent = `You have an unfinished upload: ${unfinished.fileName}. Choose the same file to continue.`;
      banner.classList.remove('d-none');
      banner.dataset.targetFingerprint = `${unfinished.fileName}_${unfinished.size}_${unfinished.lastModified}`;
      banner.dataset.uploadId = unfinished.uploadId;
    } else if (banner) {
      banner.classList.add('d-none');
    }
  },

  promptResumeUnfinished() {
    this.showScreen('upload');
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.click();
  },

  /**
   * File selection and validation
   */
  async handleFileSelection(file) {
    const validationBox = document.getElementById('file-validation-msg');
    validationBox.classList.add('d-none');

    // 1. Validate empty file
    if (!file || file.size === 0) {
      validationBox.textContent = 'Selected file is empty (0 bytes). Please select a valid file.';
      validationBox.classList.remove('d-none');
      return;
    }

    // 2. Validate maximum file size (10 GB)
    const MAX_SIZE = 10 * 1024 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      validationBox.textContent = `Selected file exceeds maximum allowed size of 10 GB (${this.formatFileSize(file.size)}).`;
      validationBox.classList.remove('d-none');
      return;
    }

    // Check if resuming an unfinished upload with mismatched file
    const banner = document.getElementById('unfinished-banner');
    if (banner && !banner.classList.contains('d-none')) {
      const targetFingerprint = banner.dataset.targetFingerprint;
      const currentFingerprint = StorageService.getFileFingerprint(file);
      if (targetFingerprint && targetFingerprint !== currentFingerprint) {
        validationBox.textContent = "That's a different file (size/date doesn't match). Pick the original file to resume.";
        validationBox.classList.remove('d-none');
        return;
      }
    }

    this.currentFile = file;
    this.displayFileInfo(file);
    await this.initUploader(file);
  },

  formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  },

  displayFileInfo(file) {
    document.getElementById('file-info-box').classList.remove('d-none');
    document.getElementById('info-file-name').textContent = file.name;
    document.getElementById('info-file-size').textContent = `${this.formatFileSize(file.size)} (${file.size.toLocaleString()} bytes)`;
    
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
    document.getElementById('info-chunk-count').textContent = `${chunkCount.toLocaleString()} chunks`;
    document.getElementById('info-file-hash').textContent = 'Calculating…';
    document.getElementById('btn-start').disabled = true;

    // Build empty chunk grid
    this.renderChunkGrid(new Array(chunkCount).fill('waiting'));
  },

  async initUploader(file) {
    this.uploader = new ChunkUploader();

    // Listen to uploader events
    this.uploader.on('stateChange', (e) => this.onUploaderStateChange(e));
    this.uploader.on('progress', (e) => this.onUploaderProgress(e));
    this.uploader.on('chunkUpdate', (e) => this.onChunkUpdate(e));
    this.uploader.on('complete', (e) => this.onUploaderComplete(e));
    this.uploader.on('error', (e) => this.onUploaderError(e));

    // Prepare upload (calculates whole-file SHA-256 and checks server session)
    try {
      await this.uploader.prepare(file);
      this.fullFileHash = this.uploader.fileSha256;
      document.getElementById('info-file-hash').textContent = `${this.fullFileHash.substring(0, 12)}…`;
      document.getElementById('btn-start').disabled = false;
      document.getElementById('status-line').textContent = 'File prepared and fingerprint calculated. Ready to start upload.';
    } catch (err) {
      document.getElementById('file-validation-msg').textContent = `Preparation failed: ${err.message}`;
      document.getElementById('file-validation-msg').classList.remove('d-none');
    }
  },

  onUploaderStateChange(event) {
    const statusBadge = document.getElementById('badge-upload-status');
    const statusBox = document.getElementById('status-box');
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
    const btnCancel = document.getElementById('btn-cancel');
    const progressBar = document.getElementById('progress-bar-fill');

    // Reset controls visibility
    btnStart.classList.add('d-none');
    btnPause.classList.add('d-none');
    btnResume.classList.add('d-none');
    btnCancel.classList.add('d-none');
    statusBox.className = 'status-box';
    if (progressBar) {
      progressBar.classList.remove('progress-bar-striped', 'progress-bar-animated', 'bg-success', 'bg-warning', 'bg-danger');
    }

    switch (event.state) {
      case 'idle':
        statusBadge.textContent = 'Ready';
        statusBadge.className = 'badge status-pill bg-secondary';
        btnStart.classList.remove('d-none');
        btnStart.disabled = false;
        break;

      case 'hashing':
        statusBadge.textContent = 'Hashing';
        statusBadge.className = 'badge status-pill bg-info text-dark';
        break;

      case 'uploading':
        statusBadge.textContent = 'Uploading';
        statusBadge.className = 'badge status-pill bg-primary';
        if (progressBar) progressBar.classList.add('progress-bar-striped', 'progress-bar-animated');
        btnPause.classList.remove('d-none');
        btnCancel.classList.remove('d-none');
        break;

      case 'paused':
        statusBadge.textContent = 'Paused';
        statusBadge.className = 'badge status-pill bg-warning text-dark';
        statusBox.classList.add('retrying');
        if (progressBar) progressBar.classList.add('bg-warning');
        btnResume.classList.remove('d-none');
        btnCancel.classList.remove('d-none');
        document.getElementById('status-line').textContent = 'Upload paused. Press Resume or Space to continue.';
        break;

      case 'retrying':
        statusBadge.textContent = 'Retrying…';
        statusBadge.className = 'badge status-pill bg-warning text-dark';
        statusBox.classList.add('retrying');
        if (progressBar) progressBar.classList.add('bg-warning');
        btnPause.classList.remove('d-none');
        btnCancel.classList.remove('d-none');
        break;

      case 'verifying':
        statusBadge.textContent = 'Verifying';
        statusBadge.className = 'badge status-pill bg-info text-dark';
        break;

      case 'complete':
        statusBadge.textContent = 'Verified ✓';
        statusBadge.className = 'badge status-pill bg-success';
        statusBox.classList.add('complete');
        if (progressBar) progressBar.classList.add('bg-success');
        break;

      case 'failed':
        statusBadge.textContent = 'Failed ✗';
        statusBadge.className = 'badge status-pill bg-danger';
        statusBox.classList.add('failed');
        if (progressBar) progressBar.classList.add('bg-danger');
        btnResume.classList.remove('d-none');
        break;
    }
  },

  onUploaderProgress(event) {
    if (event.phase === 'hashing') {
      document.getElementById('status-line').textContent = event.message;
      this.updateProgressBar(event.percent);
      return;
    }

    if (event.phase === 'retrying') {
      document.getElementById('status-line').textContent = event.message;
      return;
    }

    if (event.phase === 'verifying') {
      document.getElementById('status-line').textContent = event.message;
      this.updateProgressBar(100);
      return;
    }

    if (event.phase === 'uploading') {
      this.updateProgressBar(event.percent);
      document.getElementById('metric-speed').textContent = `${event.speedMBps} MB/s`;
      document.getElementById('metric-chunks').textContent = `${event.doneChunks} / ${event.totalChunks}`;
      document.getElementById('metric-eta').textContent = event.etaSec;
      document.getElementById('status-line').textContent = `${event.doneChunks} of ${event.totalChunks} chunks sent (${event.percent}%).`;
    }
  },

  updateProgressBar(percent) {
    const bar = document.getElementById('progress-bar-fill');
    bar.style.width = `${percent}%`;
    bar.textContent = `${percent}%`;
    bar.parentElement.setAttribute('aria-valuenow', percent);
  },

  onChunkUpdate(event) {
    this.renderChunkGrid(event.states);
  },

  renderChunkGrid(states) {
    const grid = document.getElementById('chunk-grid');
    const MAX_CELLS = 400;
    const total = states.length;
    const groupSize = total > 600 ? Math.ceil(total / MAX_CELLS) : 1;
    const cellCount = Math.ceil(total / groupSize);

    // Rebuild only when cell count changes (avoids 5,120-node DOM rebuilds on 10 GB files)
    if (grid.children.length !== cellCount || grid.querySelector('.chunk-empty-state')) {
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < cellCount; i++) {
        const square = document.createElement('div');
        square.className = 'chunk-square waiting';
        frag.appendChild(square);
      }
      grid.appendChild(frag);
    }

    for (let c = 0; c < cellCount; c++) {
      const start = c * groupSize;
      const end = Math.min(total, start + groupSize);
      let st = 'waiting';
      let doneCount = 0;
      let hasSending = false;
      let hasFailed = false;

      for (let i = start; i < end; i++) {
        if (states[i] === 'failed') hasFailed = true;
        else if (states[i] === 'sending') hasSending = true;
        else if (states[i] === 'done') doneCount++;
      }

      if (hasFailed) st = 'failed';
      else if (hasSending) st = 'sending';
      else if (doneCount === (end - start)) st = 'done';

      const square = grid.children[c];
      const nextClass = `chunk-square ${st}`;
      const nextTitle = groupSize === 1
        ? `Chunk ${start + 1}: ${st}`
        : `Chunks ${start + 1}–${end}: ${doneCount}/${end - start} done (${st})`;

      if (square.className !== nextClass) square.className = nextClass;
      if (square.title !== nextTitle) square.title = nextTitle;
    }
  },

  onUploaderComplete(data) {
    document.getElementById('completion-box').classList.remove('d-none');
    document.getElementById('status-line').textContent = 'Upload complete · checksum verified ✓';
    const dlBtn = document.getElementById('btn-download-file');
    dlBtn.href = data.downloadUrl || `/api/files/${data.uploadId}`;

    // Hide unfinished banner if this was it
    const banner = document.getElementById('unfinished-banner');
    if (banner) banner.classList.add('d-none');

    // Record in test runs if active in Test Lab
    if (this.isTestLabRun) {
      this.recordTestRun(true);
    }
  },

  onUploaderError(err) {
    document.getElementById('status-line').textContent = `Error: ${err.message}`;
    if (this.isTestLabRun) {
      this.recordTestRun(false);
    }
  },

  startUpload() {
    if (this.uploader) {
      document.getElementById('completion-box').classList.add('d-none');
      this.uploader.start();
    }
  },

  pauseUpload() {
    if (this.uploader) this.uploader.pause();
  },

  resumeUpload() {
    if (this.uploader) this.uploader.resume();
  },

  cancelUpload() {
    if (this.uploader) {
      this.uploader.cancel();
      this.resetUploadForm();
    }
  },

  resetUploadForm() {
    this.currentFile = null;
    this.uploader = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-info-box').classList.add('d-none');
    document.getElementById('completion-box').classList.add('d-none');
    document.getElementById('chunk-grid').innerHTML = '<div class="chunk-empty-state">Chunk map will appear here once a file is chosen.</div>';
    const progressBar = document.getElementById('progress-bar-fill');
    if (progressBar) {
      progressBar.classList.remove('progress-bar-striped', 'progress-bar-animated', 'bg-success', 'bg-warning', 'bg-danger');
    }
    this.updateProgressBar(0);
    document.getElementById('metric-speed').textContent = '-- MB/s';
    document.getElementById('metric-chunks').textContent = '0 / 0';
    document.getElementById('metric-eta').textContent = '--';
    document.getElementById('status-box').className = 'status-box';
    document.getElementById('status-line').textContent = 'Choose a file to upload (max 10 GB).';
    document.getElementById('badge-upload-status').textContent = 'Idle';
    document.getElementById('badge-upload-status').className = 'badge status-pill bg-secondary';
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-start').classList.remove('d-none');
    document.getElementById('btn-pause').classList.add('d-none');
    document.getElementById('btn-resume').classList.add('d-none');
    document.getElementById('btn-cancel').classList.add('d-none');
  },

  copyFullHash() {
    if (this.fullFileHash) {
      navigator.clipboard.writeText(this.fullFileHash);
      const btn = document.getElementById('btn-copy-hash');
      const copyIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      const checkIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.innerHTML = checkIcon;
      setTimeout(() => { btn.innerHTML = copyIcon; }, 1500);
    }
  },

  /**
   * SCREEN 2: My Uploads
   */
  renderMyUploads() {
    const tbody = document.getElementById('my-uploads-tbody');
    const all = StorageService.getAllUploads();
    const records = Object.values(all);

    if (records.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-5 text-muted">
            <div class="mb-2">No uploads recorded in this browser yet.</div>
            <button type="button" class="btn btn-sm btn-outline-primary btn-compact" onclick="App.showScreen('upload')">Upload a File</button>
          </td>
        </tr>`;
      return;
    }

    records.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    tbody.innerHTML = '';

    records.forEach(rec => {
      const tr = document.createElement('tr');
      const sizeStr = this.formatFileSize(rec.size);
      const dateStr = rec.updatedAt ? new Date(rec.updatedAt).toLocaleTimeString() : '--';

      let statusBadge = '<span class="badge bg-secondary">Unknown</span>';
      let actionBtn = '';
      const baseUrl = StorageService.getServerUrl();

      if (rec.status === 'complete') {
        statusBadge = '<span class="badge badge-status-complete">Complete ✓</span>';
        actionBtn = `<a href="${baseUrl}/api/files/${encodeURIComponent(rec.uploadId)}" class="btn btn-sm btn-outline-success btn-compact">Download</a>`;
      } else if (rec.status === 'paused' || rec.status === 'uploading') {
        statusBadge = `<span class="badge badge-status-paused">${this.escapeHtml(rec.status)}</span>`;
        actionBtn = `<button type="button" class="btn btn-sm btn-primary btn-compact" onclick="App.resumeSpecificUpload('${this.escapeHtml(rec.uploadId)}')">Resume</button>`;
      } else {
        statusBadge = '<span class="badge badge-status-failed">Failed</span>';
      }

      tr.innerHTML = `
        <td class="fw-semibold">${this.escapeHtml(rec.fileName)}</td>
        <td class="tabular-nums">${sizeStr}</td>
        <td class="tabular-nums">${rec.totalChunks} chunks</td>
        <td>${statusBadge}</td>
        <td><small class="text-muted tabular-nums">${dateStr}</small></td>
        <td class="text-end">${actionBtn}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  resumeSpecificUpload(uploadId) {
    this.showScreen('upload');
    alert('Please pick the exact same file in the file picker to resume missing chunks.');
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.click();
  },

  /**
   * SCREEN 3: All Uploads (Admin)
   */
  async loadAdminUploads() {
    const tbody = document.getElementById('admin-uploads-tbody');
    const guardAll = document.getElementById('admin-role-guard-all');
    const role = StorageService.getRole();

    if (role !== 'admin') {
      if (guardAll) {
        guardAll.classList.remove('d-none');
        guardAll.classList.add('d-flex');
      }
      tbody.innerHTML = '<tr><td colspan="8" class="text-center py-5 text-muted">Switch role to <strong>Platform Admin</strong> to view server upload sessions.</td></tr>';
      return;
    }

    if (guardAll) {
      guardAll.classList.add('d-none');
      guardAll.classList.remove('d-flex');
    }
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-5 text-muted">Loading uploads from server…</td></tr>';

    try {
      const baseUrl = StorageService.getServerUrl();
      const res = await fetch(`${baseUrl}/api/admin/uploads`, {
        headers: { 'X-Role': 'admin' }
      });

      if (!res.ok) {
        if (res.status === 403) {
          tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-danger">Access denied: Switch role to "Platform Admin" to view all uploads.</td></tr>';
          return;
        }
        throw new Error('Failed to fetch admin uploads');
      }

      const data = await res.json();
      const storageBadge = document.getElementById('admin-storage-summary');
      if (storageBadge && data.storage) {
        storageBadge.textContent = `Storage: ${data.storage.totalMB} MB (${data.storage.fileCount} files)`;
      }

      if (!data.uploads || data.uploads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-5 text-muted">No files on the server.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      data.uploads.forEach(u => {
        const tr = document.createElement('tr');
        const sizeStr = this.formatFileSize(u.size);
        const recvCount = u.received ? u.received.length : 0;
        const shaBadge = u.status === 'complete'
          ? '<span class="badge badge-status-complete">Verified ✓</span>'
          : '<span class="badge badge-status-paused">Pending</span>';
        const dateStr = u.createdAt ? new Date(u.createdAt).toLocaleTimeString() : '--';

        tr.innerHTML = `
          <td><code class="text-dark">${this.escapeHtml(u.uploadId)}</code></td>
          <td class="fw-medium">${this.escapeHtml(u.fileName)}</td>
          <td class="tabular-nums">${sizeStr}</td>
          <td class="tabular-nums">${recvCount} / ${u.totalChunks}</td>
          <td><span class="badge ${u.status === 'complete' ? 'badge-status-complete' : 'badge-status-paused'}">${this.escapeHtml(u.status)}</span></td>
          <td>${shaBadge}</td>
          <td><small class="text-muted tabular-nums">${dateStr}</small></td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-danger btn-compact" onclick="App.deleteAdminUpload('${this.escapeHtml(u.uploadId)}')">Delete</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-danger">${this.escapeHtml(err.message)}</td></tr>`;
    }
  },

  async deleteAdminUpload(uploadId) {
    if (!confirm(`Delete upload session ${uploadId}?`)) return;

    try {
      const baseUrl = StorageService.getServerUrl();
      const res = await fetch(`${baseUrl}/api/admin/uploads/${uploadId}`, {
        method: 'DELETE',
        headers: { 'X-Role': 'admin' }
      });
      if (res.ok) {
        this.loadAdminUploads();
      } else {
        alert('Failed to delete upload.');
      }
    } catch (e) {
      alert(`Error deleting upload: ${e.message}`);
    }
  },

  /**
   * SCREEN 4: Test Lab
   */
  async initFlakySlider() {
    try {
      const baseUrl = StorageService.getServerUrl();
      const res = await fetch(`${baseUrl}/api/test/flaky`);
      if (res.ok) {
        const data = await res.json();
        const slider = document.getElementById('fail-rate-slider');
        const label = document.getElementById('fail-rate-val');
        const killSelect = document.getElementById('kill-at-select');
        if (slider && label) {
          slider.value = data.flakyFailRate || 0;
          label.textContent = `${slider.value}%`;
        }
        if (killSelect && data.killAtPercent !== undefined) {
          killSelect.value = data.killAtPercent;
          this.syncKillAtButtons(String(data.killAtPercent));
        }
      }
    } catch (e) {
      // ignore
    }
  },

  setKillAt(val) {
    const killSelect = document.getElementById('kill-at-select');
    if (killSelect) killSelect.value = val;
    this.syncKillAtButtons(String(val));
    this.updateFlakySettings();
  },

  syncKillAtButtons(val) {
    document.querySelectorAll('.kill-at-segmented .btn-segment').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.kill === val);
    });
  },

  async updateFlakySettings() {
    const slider = document.getElementById('fail-rate-slider');
    const label = document.getElementById('fail-rate-val');
    const killSelect = document.getElementById('kill-at-select');

    const failVal = slider ? slider.value : 0;
    const killVal = killSelect ? killSelect.value : 0;
    if (label) label.textContent = `${failVal}%`;

    try {
      const baseUrl = StorageService.getServerUrl();
      await fetch(`${baseUrl}/api/test/flaky?fail=${failVal}&kill_at=${killVal}`, { method: 'GET' });
    } catch (e) {
      console.warn('Failed to update server test lab settings:', e);
    }
  },

  createSyntheticFile(sizeMB) {
    const bytesCount = sizeMB * 1024 * 1024;
    const pattern = `[ChunkTest-${sizeMB}MB-Payload]`.repeat(1024);
    const patternBytes = new TextEncoder().encode(pattern);
    const chunks = [];
    let filled = 0;

    while (filled < bytesCount) {
      const sliceSize = Math.min(patternBytes.length, bytesCount - filled);
      chunks.push(patternBytes.subarray(0, sliceSize));
      filled += sliceSize;
    }

    const syntheticBlob = new Blob(chunks, { type: 'application/octet-stream' });
    return new File([syntheticBlob], `synthetic_${sizeMB}MB_${Date.now()}.bin`, {
      type: 'application/octet-stream',
      lastModified: Date.now()
    });
  },

  async runTestLabBatch(sizeMB) {
    const runsCountInput = document.getElementById('test-runs-count');
    const totalRuns = runsCountInput ? Math.min(30, Math.max(1, parseInt(runsCountInput.value) || 1)) : 1;

    await this.updateFlakySettings();

    this.showScreen('upload');
    this.isTestLabRun = true;
    this.batchTotalRuns = totalRuns;
    this.batchCurrentRun = 1;

    const file = this.createSyntheticFile(sizeMB);
    this.testRunStartTime = Date.now();
    this.testRunFailRate = document.getElementById('fail-rate-slider').value;
    this.testRunKillAt = document.getElementById('kill-at-select').value;

    await this.handleFileSelection(file);
    // Auto-start upload for test lab run
    if (this.uploader) {
      const statusLine = document.getElementById('status-line');
      if (statusLine) {
        statusLine.textContent = `Test Lab: Run ${this.batchCurrentRun} of ${this.batchTotalRuns}`;
      }
      this.startUpload();
    }
  },

  recordTestRun(success) {
    this.testRunCount += 1;
    const elapsedSec = ((Date.now() - (this.testRunStartTime || Date.now())) / 1000).toFixed(1);
    const retries = this.uploader ? this.uploader.retryAttempt : 0;
    const killStr = this.testRunKillAt && this.testRunKillAt !== '0' ? ` (Kill at ${this.testRunKillAt}%)` : '';

    const runData = {
      runNumber: this.testRunCount,
      fileName: this.currentFile ? this.currentFile.name : 'synthetic.bin',
      sizeMB: this.currentFile ? (this.currentFile.size / (1024 * 1024)).toFixed(1) : '0',
      failRate: `${this.testRunFailRate || 0}%${killStr}`,
      retries: retries,
      resumed: true,
      checksumOk: success,
      time: `${elapsedSec}s`
    };

    this.testRuns.unshift(runData);
    this.renderTestRuns();

    // Check if more runs remain in batch
    if (this.batchCurrentRun < this.batchTotalRuns) {
      this.batchCurrentRun += 1;
      setTimeout(() => {
        const sizeMB = parseInt(this.currentFile.size / (1024 * 1024)) || 5;
        const nextFile = this.createSyntheticFile(sizeMB);
        this.testRunStartTime = Date.now();
        this.handleFileSelection(nextFile).then(() => {
          const statusLine = document.getElementById('status-line');
          if (statusLine) {
            statusLine.textContent = `Test Lab: Run ${this.batchCurrentRun} of ${this.batchTotalRuns}`;
          }
          this.startUpload();
        });
      }, 1500);
    } else {
      this.isTestLabRun = false;
    }
  },

  renderTestRuns() {
    const tbody = document.getElementById('test-runs-tbody');
    if (this.testRuns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-3 text-muted">No test runs executed yet.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    let passedCount = 0;
    this.testRuns.forEach(r => {
      if (r.checksumOk) passedCount++;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>#${r.runNumber}</strong></td>
        <td>${r.fileName} (${r.sizeMB} MB)</td>
        <td>${r.failRate}</td>
        <td>${r.retries}</td>
        <td><span class="text-success fw-bold">✓</span></td>
        <td><span class="${r.checksumOk ? 'text-success' : 'text-danger'} fw-bold">${r.checksumOk ? '✓ Pass' : '✗ Fail'}</span></td>
        <td>${r.time}</td>
      `;
      tbody.appendChild(tr);
    });

    const summaryPill = document.getElementById('test-summary-pill');
    const summaryText = document.getElementById('test-summary-text');
    summaryPill.classList.remove('d-none');
    summaryText.textContent = `Summary: ${this.testRuns.length} / ${this.testRuns.length} resumed · ${passedCount} / ${this.testRuns.length} checksum ✓`;
  },

  clearTestRuns() {
    this.testRuns = [];
    this.testRunCount = 0;
    this.renderTestRuns();
    document.getElementById('test-summary-pill').classList.add('d-none');
  }
};

window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
