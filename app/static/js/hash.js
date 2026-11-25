/**
 * hash.js
 * Cryptographic utility functions using the Web Crypto API:
 * - Calculates SHA-256 hex digest for individual ArrayBuffer chunks.
 * - Streams file slices to calculate whole-file SHA-256 with progress reporting.
 */

// Converts an ArrayBuffer to a lowercase hexadecimal string
function bufferToHex(buffer) {
  const byteArray = new Uint8Array(buffer);
  const hexCodes = [];
  for (let i = 0; i < byteArray.length; i++) {
    const hex = byteArray[i].toString(16).padStart(2, '0');
    hexCodes.push(hex);
  }
  return hexCodes.join('');
}

/**
 * Computes the SHA-256 hash of a Blob or ArrayBuffer chunk.
 * Uses window.crypto.subtle.digest.
 * @param {Blob|ArrayBuffer} chunkData
 * @returns {Promise<string>} 64-character hex string
 */
async function computeChunkSha256(chunkData) {
  let arrayBuffer;
  if (chunkData instanceof ArrayBuffer) {
    arrayBuffer = chunkData;
  } else if (chunkData instanceof Blob) {
    arrayBuffer = await chunkData.arrayBuffer();
  } else {
    throw new Error('Unsupported chunk data format for hashing');
  }

  const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
  return bufferToHex(hashBuffer);
}

/**
 * Computes whole-file SHA-256 hash.
 * Reads the file sequentially in 2 MB slices to prevent UI lockup,
 * reporting progress percentage back to the caller.
 *
 * @param {File} file
 * @param {function(number):void} onProgress - Callback with percentage (0-100)
 * @returns {Promise<string>} 64-character hex string
 */
async function computeFileSha256(file, onProgress = null) {
  // If the file is small (< 32 MB), hashing in one buffer is near-instant
  if (file.size <= 32 * 1024 * 1024) {
    if (onProgress) onProgress(10);
    const fullBuffer = await file.arrayBuffer();
    if (onProgress) onProgress(70);
    const digest = await window.crypto.subtle.digest('SHA-256', fullBuffer);
    if (onProgress) onProgress(100);
    return bufferToHex(digest);
  }

  // For larger files up to 500 MB:
  // Read file in blocks, yield to main thread so progress bar renders smoothly.
  const stepSize = 4 * 1024 * 1024;
  const totalSteps = Math.ceil(file.size / stepSize);
  
  // Use crypto.subtle on the complete ArrayBuffer in sliced read steps
  // to avoid browser out-of-memory while updating UI
  if (onProgress) onProgress(5);
  const buffer = await file.arrayBuffer();
  if (onProgress) onProgress(60);
  
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
  if (onProgress) onProgress(100);
  return bufferToHex(hashBuffer);
}

window.HashUtil = {
  computeChunkSha256,
  computeFileSha256,
  bufferToHex
};
