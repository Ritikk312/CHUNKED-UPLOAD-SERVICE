/**
 * uploader.js
 * Core resumable chunk uploader:
 * - Slices files into 2 MB chunks
 * - Calculates per-chunk and whole-file SHA-256
 * - Sends chunks sequentially with idempotency
 * - Automatically retries failed chunks with exponential backoff (capped at 30s)
 * - Supports pause, resume, and cancel
 * - Checks server for already received chunks upon resume
 */

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_BACKOFF_SECONDS = 30;

class ChunkUploader {
  constructor(options = {}) {
    this.options = options;
    this.file = null;
    this.fingerprint = null;
    this.uploadId = null;
    this.fileSha256 = null;
    this.totalChunks = 0;
    this.receivedChunks = new Set();
    this.chunkStates = []; // 'waiting' | 'sending' | 'done' | 'failed'
    
    // State machine: idle | hashing | uploading | paused | retrying | verifying | complete | failed
    this.state = 'idle';
    this.currentChunkIndex = 0;
    this.isPaused = false;
    this.isCancelled = false;
    this.retryAttempt = 0;
    this.retryTimeoutId = null;
    
    // Metrics tracking
    this.startTime = null;
    this.lastChunkTimes = []; // for calculating rolling speed

    // Event listeners
    this.listeners = {
      stateChange: [],
      progress: [],
      chunkUpdate: [],
      error: [],
      complete: []
    };
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error(`Error in listener for ${event}:`, e);
        }
      });
    }
  }

  setState(newState, extra = {}) {
    this.state = newState;
    this.emit('stateChange', { state: newState, ...extra });
  }

  /**
   * Initializes upload session for a file.
   * If a previous session exists on the server, verifies and resumes it.
   */
  async prepare(file, existingUploadId = null) {
    this.file = file;
    this.isPaused = false;
    this.isCancelled = false;
    this.fingerprint = StorageService.getFileFingerprint(file);
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.chunkStates = new Array(this.totalChunks).fill('waiting');

    // 1. Calculate whole-file SHA-256 fingerprint
    this.setState('hashing', { percent: 0 });
    this.fileSha256 = await HashUtil.computeFileSha256(file, (percent) => {
      this.emit('progress', {
        phase: 'hashing',
        percent: Math.round(percent),
        message: `Preparing… calculating file fingerprint (${Math.round(percent)}%)`
      });
    });

    // 2. Check if we have an existing upload to resume
    let targetUploadId = existingUploadId;
    if (!targetUploadId) {
      const stored = StorageService.getUpload(this.fingerprint);
      if (stored && stored.uploadId && stored.fileSha256 === this.fileSha256) {
        targetUploadId = stored.uploadId;
      }
    }

    if (targetUploadId) {
      try {
        const baseUrl = StorageService.getServerUrl();
        const res = await fetch(`${baseUrl}/api/uploads/${targetUploadId}`);
        if (res.ok) {
          const sessionData = await res.json();
          this.uploadId = sessionData.uploadId;
          this.receivedChunks = new Set(sessionData.received || []);

          // Sync chunk map
          for (let i = 0; i < this.totalChunks; i++) {
            if (this.receivedChunks.has(i)) {
              this.chunkStates[i] = 'done';
            }
          }
          this.emit('chunkUpdate', { states: [...this.chunkStates] });

          // If already complete on server
          if (sessionData.status === 'complete') {
            this.setState('complete', {
              uploadId: this.uploadId,
              downloadUrl: `${baseUrl}/api/files/${this.uploadId}`,
              sha256: sessionData.mergedSha256 || sessionData.fileSha256
            });
            return;
          }
        } else {
          // Upload not found on server anymore
          targetUploadId = null;
        }
      } catch (err) {
        console.warn('Could not query existing upload from server:', err);
        targetUploadId = null;
      }
    }

    // 3. Create fresh session if none exists or valid
    if (!this.uploadId) {
      const baseUrl = StorageService.getServerUrl();
      const createRes = await fetch(`${baseUrl}/api/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          size: file.size,
          chunkSize: CHUNK_SIZE,
          totalChunks: this.totalChunks,
          fileSha256: this.fileSha256
        })
      });

      if (!createRes.ok) {
        const errJson = await createRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to create upload session on server');
      }

      const resData = await createRes.json();
      this.uploadId = resData.uploadId;
      this.receivedChunks = new Set();
    }

    // 4. Persist in local storage
    StorageService.saveUpload(this.fingerprint, {
      uploadId: this.uploadId,
      fileName: file.name,
      size: file.size,
      lastModified: file.lastModified,
      chunkSize: CHUNK_SIZE,
      totalChunks: this.totalChunks,
      fileSha256: this.fileSha256,
      status: 'uploading'
    });

    this.setState('idle');
  }

  /**
   * Start or resume uploading chunks sequentially.
   */
  async start() {
    if (!this.file || !this.uploadId) {
      throw new Error('Upload is not prepared.');
    }

    this.isPaused = false;
    this.isCancelled = false;
    this.retryAttempt = 0;
    this.startTime = Date.now();
    this.setState('uploading');

    await this.uploadLoop();
  }

  /**
   * Main sequential upload loop.
   */
  async uploadLoop() {
    while (!this.isPaused && !this.isCancelled) {
      // Find the next missing chunk index
      let nextIndex = -1;
      for (let i = 0; i < this.totalChunks; i++) {
        if (!this.receivedChunks.has(i)) {
          nextIndex = i;
          break;
        }
      }

      // If all chunks have arrived, proceed to complete
      if (nextIndex === -1) {
        await this.finalizeUpload();
        return;
      }

      this.currentChunkIndex = nextIndex;
      const success = await this.sendChunk(nextIndex);

      if (!success) {
        if (this.isPaused || this.isCancelled) {
          return;
        }
        // Handle retry with exponential backoff
        await this.scheduleRetry();
      } else {
        this.retryAttempt = 0; // reset retry counter on success
        this.emitProgress();
      }
    }
  }

  /**
   * Slices, hashes, and PUTs a single chunk to the server.
   */
  async sendChunk(index) {
    const startByte = index * CHUNK_SIZE;
    const endByte = Math.min(this.file.size, startByte + CHUNK_SIZE);
    const chunkBlob = this.file.slice(startByte, endByte);

    this.chunkStates[index] = 'sending';
    this.emit('chunkUpdate', { states: [...this.chunkStates], currentIndex: index });

    const chunkStartTime = Date.now();

    try {
      // Compute chunk SHA-256 for integrity verification
      const chunkSha256 = await HashUtil.computeChunkSha256(chunkBlob);

      const chunkBuffer = await chunkBlob.arrayBuffer();
      const baseUrl = StorageService.getServerUrl();

      const response = await fetch(`${baseUrl}/api/uploads/${this.uploadId}/chunks/${index}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-SHA256': chunkSha256
        },
        body: chunkBuffer
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.warn(`Chunk ${index} failed with status ${response.status}:`, errorData.error);
        this.chunkStates[index] = 'failed';
        this.emit('chunkUpdate', { states: [...this.chunkStates], currentIndex: index });
        return false;
      }

      // Chunk accepted and saved
      this.receivedChunks.add(index);
      this.chunkStates[index] = 'done';
      this.emit('chunkUpdate', { states: [...this.chunkStates], currentIndex: index });

      // Track chunk duration for rolling speed
      const duration = (Date.now() - chunkStartTime) / 1000;
      const mbUploaded = chunkBlob.size / (1024 * 1024);
      if (duration > 0) {
        this.lastChunkTimes.push(mbUploaded / duration);
        if (this.lastChunkTimes.length > 5) {
          this.lastChunkTimes.shift();
        }
      }

      return true;
    } catch (networkError) {
      console.warn(`Network error sending chunk ${index}:`, networkError);
      this.chunkStates[index] = 'failed';
      this.emit('chunkUpdate', { states: [...this.chunkStates], currentIndex: index });
      return false;
    }
  }

  /**
   * Exponential backoff retry handler (1s, 2s, 4s, 8s, 16s, capped at 30s).
   */
  async scheduleRetry() {
    this.retryAttempt += 1;
    // Backoff formula: min(2^(attempt - 1), 30) seconds
    const backoffSeconds = Math.min(Math.pow(2, this.retryAttempt - 1), MAX_BACKOFF_SECONDS);
    
    this.setState('retrying', {
      attempt: this.retryAttempt,
      seconds: backoffSeconds,
      chunkIndex: this.currentChunkIndex
    });

    // Countdown timer for UI feedback
    for (let sec = backoffSeconds; sec > 0; sec--) {
      if (this.isPaused || this.isCancelled) return;
      this.emit('progress', {
        phase: 'retrying',
        message: `Connection lost — your progress is safe. Retrying in ${sec} s… (attempt ${this.retryAttempt})`,
        retrySeconds: sec
      });
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!this.isPaused && !this.isCancelled) {
      this.setState('uploading');
    }
  }

  /**
   * Finalizes the upload once all chunks are present.
   */
  async finalizeUpload() {
    this.setState('verifying');
    this.emit('progress', {
      phase: 'verifying',
      percent: 100,
      message: 'Checking file… verifying SHA-256 integrity'
    });

    try {
      const baseUrl = StorageService.getServerUrl();
      const res = await fetch(`${baseUrl}/api/uploads/${this.uploadId}/complete`, {
        method: 'POST'
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status === 'complete') {
        const dlUrl = data.downloadUrl ? `${baseUrl}${data.downloadUrl}` : `${baseUrl}/api/files/${this.uploadId}`;
        StorageService.saveUpload(this.fingerprint, {
          status: 'complete',
          mergedSha256: data.sha256,
          downloadUrl: dlUrl
        });

        this.setState('complete', {
          uploadId: this.uploadId,
          downloadUrl: dlUrl,
          sha256: data.sha256,
          message: 'Upload complete · checksum verified ✓'
        });
        this.emit('complete', { ...data, downloadUrl: dlUrl });
      } else {
        StorageService.saveUpload(this.fingerprint, {
          status: 'checksum_failed'
        });

        const errMsg = data.error || 'Checksum verification failed';
        this.setState('failed', { error: errMsg });
        this.emit('error', { message: errMsg });
      }
    } catch (err) {
      this.setState('failed', { error: 'Failed to complete upload session on server' });
      this.emit('error', { message: err.message });
    }
  }

  /**
   * Pauses the active upload.
   */
  pause() {
    this.isPaused = true;
    if (this.retryTimeoutId) clearTimeout(this.retryTimeoutId);
    this.setState('paused');
    if (this.fingerprint) {
      StorageService.saveUpload(this.fingerprint, { status: 'paused' });
    }
  }

  /**
   * Resumes a paused upload.
   */
  resume() {
    if (this.state === 'paused' || this.state === 'retrying' || this.state === 'failed') {
      this.start();
    }
  }

  /**
   * Cancels the active upload.
   */
  cancel() {
    this.isCancelled = true;
    this.isPaused = true;
    if (this.retryTimeoutId) clearTimeout(this.retryTimeoutId);
    this.chunkStates = new Array(this.totalChunks).fill('waiting');
    this.setState('idle');
  }

  /**
   * Calculates and emits current progress, upload speed, and ETA.
   */
  emitProgress() {
    const doneCount = this.receivedChunks.size;
    const percent = Math.min(100, Math.round((doneCount / this.totalChunks) * 100));

    // Calculate rolling average speed in MB/s
    let speedMBps = 0;
    if (this.lastChunkTimes.length > 0) {
      const sum = this.lastChunkTimes.reduce((acc, v) => acc + v, 0);
      speedMBps = sum / this.lastChunkTimes.length;
    }

    // Estimate time remaining
    let etaText = '--';
    const remainingChunks = this.totalChunks - doneCount;
    if (speedMBps > 0 && remainingChunks > 0) {
      const remainingMB = (remainingChunks * CHUNK_SIZE) / (1024 * 1024);
      const totalSec = Math.round(remainingMB / speedMBps);
      if (totalSec >= 86400) {
        const days = Math.floor(totalSec / 86400);
        const hrs = Math.floor((totalSec % 86400) / 3600);
        etaText = `${days}d ${hrs}h`;
      } else if (totalSec >= 3600) {
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        etaText = `${hrs}h ${mins}m`;
      } else if (totalSec >= 60) {
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        etaText = `${mins}m ${secs}s`;
      } else {
        etaText = `${totalSec}s`;
      }
    }

    this.emit('progress', {
      phase: 'uploading',
      percent,
      doneChunks: doneCount,
      totalChunks: this.totalChunks,
      speedMBps: speedMBps.toFixed(1),
      etaSec: etaText,
      message: `${doneCount} of ${this.totalChunks} chunks sent`
    });
  }
}

window.ChunkUploader = ChunkUploader;
