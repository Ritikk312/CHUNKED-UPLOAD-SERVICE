/**
 * hash.js
 * Cryptographic utility functions:
 * - Uses Web Crypto API (crypto.subtle.digest) for per-chunk and small-file hashing.
 * - Uses an incremental FIPS 180-4 StreamingSha256 hasher over 4 MB File.slice()
 *   reads for large files (up to 10 GB) so browser memory stays under ~8 MB.
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

class StreamingSha256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalBytes = 0;
    this.w = new Uint32Array(64);
  }

  processBlock(buf, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] = ((buf[idx] << 24) | (buf[idx + 1] << 16) | (buf[idx + 2] << 8) | buf[idx + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0w = w[i - 15];
      const s1w = w[i - 2];
      const s0 = (((s0w >>> 7) | (s0w << 25)) ^ ((s0w >>> 18) | (s0w << 14)) ^ (s0w >>> 3)) >>> 0;
      const s1 = (((s1w >>> 17) | (s1w << 15)) ^ ((s1w >>> 19) | (s1w << 13)) ^ (s1w >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;

    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  update(bytes) {
    let offset = 0;
    const len = bytes.length;
    this.totalBytes += len;

    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, len);
      this.block.set(bytes.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset += take;
      if (this.blockLen === 64) {
        this.processBlock(this.block, 0);
        this.blockLen = 0;
      }
    }

    while (offset + 64 <= len) {
      this.processBlock(bytes, offset);
      offset += 64;
    }

    if (offset < len) {
      const rem = len - offset;
      this.block.set(bytes.subarray(offset), 0);
      this.blockLen = rem;
    }
  }

  digestHex() {
    const padLen = this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen;
    const pad = new Uint8Array(padLen);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setBigUint64(padLen - 8, BigInt(this.totalBytes) * 8n, false);

    // Feed padding directly without altering totalBytes
    let pos = 0;
    if (this.blockLen > 0) {
      const firstTake = 64 - this.blockLen;
      this.block.set(pad.subarray(0, firstTake), this.blockLen);
      this.processBlock(this.block, 0);
      pos = firstTake;
    }
    while (pos < padLen) {
      this.processBlock(pad, pos);
      pos += 64;
    }

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += this.state[i].toString(16).padStart(8, '0');
    }
    return hex;
  }
}

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
 * For files <= 32 MB, uses Web Crypto API directly.
 * For larger files (up to 10 GB), streams 4 MB File.slice() blocks into StreamingSha256
 * to keep RAM flat (~4 MB) and update progress smoothly.
 *
 * @param {File} file
 * @param {function(number):void} onProgress - Callback with percentage (0-100)
 * @returns {Promise<string>} 64-character hex string
 */
async function computeFileSha256(file, onProgress = null) {
  if (file.size <= 32 * 1024 * 1024) {
    if (onProgress) onProgress(10);
    const fullBuffer = await file.arrayBuffer();
    if (onProgress) onProgress(70);
    const digest = await window.crypto.subtle.digest('SHA-256', fullBuffer);
    if (onProgress) onProgress(100);
    return bufferToHex(digest);
  }

  const SLICE_SIZE = 4 * 1024 * 1024; // 4 MB streaming slices
  const hasher = new StreamingSha256();
  let offset = 0;

  if (onProgress) onProgress(0);

  while (offset < file.size) {
    const end = Math.min(offset + SLICE_SIZE, file.size);
    const sliceBuffer = await file.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(sliceBuffer));
    offset = end;

    if (onProgress) {
      onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
    }
    // Yield to browser UI thread so progress renders smoothly
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const hex = hasher.digestHex();
  if (onProgress) onProgress(100);
  return hex;
}

if (typeof window !== 'undefined') {
  window.HashUtil = {
    computeChunkSha256,
    computeFileSha256,
    bufferToHex,
    StreamingSha256
  };
}
