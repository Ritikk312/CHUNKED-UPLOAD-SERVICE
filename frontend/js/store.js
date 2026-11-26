/**
 * store.js
 * LocalStorage wrapper with safe try/catch error handling:
 * - Persists active and historical upload records by file fingerprint
 * - Persists application settings and backend server URL
 * - Persists active user role
 */

const STORAGE_KEYS = {
  UPLOADS: 'up_uploads',
  SETTINGS: 'up_settings',
  SESSION: 'up_session'
};

const StorageService = {
  /**
   * Returns base URL of Python backend API.
   * If running standalone (e.g. file://, github.io, or port other than 5050),
   * defaults to http://localhost:5050 unless configured in localStorage.
   */
  getServerUrl() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.serverUrl) return parsed.serverUrl.replace(/\/+$/, '');
      }
    } catch (e) {}
    // If frontend is running standalone on another port or protocol, target default Flask port 5050
    if (window.location.protocol === 'file:' || (window.location.port !== '5050' && window.location.port !== '5000')) {
      return 'http://localhost:5050';
    }
    return '';
  },

  setServerUrl(url) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      const settings = raw ? JSON.parse(raw) : { chunkSizeMB: 2 };
      settings.serverUrl = url;
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save server URL:', e);
    }
  },

  /**
   * Generates a stable unique fingerprint for a local file
   * based on file name, byte size, and last modified timestamp.
   */
  getFileFingerprint(file) {
    if (!file) return '';
    return `${file.name}_${file.size}_${file.lastModified}`;
  },

  /**
   * Reads all upload records from localStorage.
   * @returns {Object<string, Object>} Map of fingerprint -> record
   */
  getAllUploads() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.UPLOADS);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.warn('Failed to read uploads from localStorage:', err);
      return {};
    }
  },

  /**
   * Gets an upload record by file fingerprint.
   */
  getUpload(fingerprint) {
    const all = this.getAllUploads();
    return all[fingerprint] || null;
  },

  /**
   * Saves or updates an upload record.
   */
  saveUpload(fingerprint, record) {
    try {
      const all = this.getAllUploads();
      all[fingerprint] = {
        ...all[fingerprint],
        ...record,
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(STORAGE_KEYS.UPLOADS, JSON.stringify(all));
      return all[fingerprint];
    } catch (err) {
      console.warn('Failed to save upload record in localStorage:', err);
      return record;
    }
  },

  /**
   * Removes an upload record.
   */
  removeUpload(fingerprint) {
    try {
      const all = this.getAllUploads();
      delete all[fingerprint];
      localStorage.setItem(STORAGE_KEYS.UPLOADS, JSON.stringify(all));
    } catch (err) {
      console.warn('Failed to delete upload record from localStorage:', err);
    }
  },

  /**
   * Finds the most recent unfinished upload, if any exists.
   */
  findUnfinishedUpload() {
    const all = this.getAllUploads();
    const list = Object.values(all);
    const unfinished = list.filter(item => item.status === 'uploading' || item.status === 'paused');
    if (unfinished.length === 0) return null;
    unfinished.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return unfinished[0];
  },

  /**
   * Gets user role ("uploader" or "admin").
   */
  getRole() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (raw) {
        const obj = JSON.parse(raw);
        return obj.role || 'uploader';
      }
    } catch (e) {}
    return 'uploader';
  },

  /**
   * Sets user role.
   */
  setRole(role) {
    try {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ role }));
    } catch (e) {
      console.warn('Failed to set role:', e);
    }
  }
};

window.StorageService = StorageService;
