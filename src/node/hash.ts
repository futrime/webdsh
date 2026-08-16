/**
 * Synchronous SHA-1, SHA-256 and MD5 for the `node:crypto` shim.
 *
 * WebCrypto's `subtle.digest` is async, but `createHash(...).update(...).digest()`
 * is synchronous by contract and dsh hashes bundle content and session ids on
 * hot paths, so the digests are implemented directly.
 */

/** Rotate a 32-bit word left. */
function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

/** Append the standard 64-bit big-endian length padding. */
function padBigEndian(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  return padded
}

/** SHA-1 over the whole input. */
export function sha1(input: Uint8Array): Uint8Array {
  const padded = padBigEndian(input)
  const view = new DataView(padded.buffer)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      let f: number, k: number
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc } else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0
      e = d; d = c; c = rotl(b, 30); b = a; a = temp
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0); outView.setUint32(4, h1); outView.setUint32(8, h2); outView.setUint32(12, h3); outView.setUint32(16, h4)
  return out
}

/** SHA-256 round constants. */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 over the whole input. */
export function sha256(input: Uint8Array): Uint8Array {
  const padded = padBigEndian(input)
  const view = new DataView(padded.buffer)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = (rotl(w[i - 15], 25) ^ rotl(w[i - 15], 14) ^ (w[i - 15] >>> 3)) >>> 0
      const s1 = (rotl(w[i - 2], 15) ^ rotl(w[i - 2], 13) ^ (w[i - 2] >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = (rotl(e, 26) ^ rotl(e, 21) ^ rotl(e, 7)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0
      const S0 = (rotl(a, 30) ^ rotl(a, 19) ^ rotl(a, 10)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i])
  return out
}

/** MD5 per-round shift amounts. */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** MD5 sine-derived constants. */
const MD5_K = new Uint32Array(64)
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0

/** MD5 over the whole input (needed only for legacy content addressing). */
export function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8
  const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLength >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 } else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const temp = d
      d = c
      c = b
      const sum = (a + f + MD5_K[i] + view.getUint32(offset + g * 4, true)) >>> 0
      b = (b + rotl(sum, MD5_S[i])) >>> 0
      a = temp
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true); outView.setUint32(4, b0, true); outView.setUint32(8, c0, true); outView.setUint32(12, d0, true)
  return out
}

/** Dispatch by Node algorithm name; unknown names throw the way Node does. */
export function digest(algorithm: string, input: Uint8Array): Uint8Array {
  const name = algorithm.toLowerCase().replace('-', '')
  if (name === 'sha1') return sha1(input)
  if (name === 'sha256') return sha256(input)
  if (name === 'md5') return md5(input)
  throw new Error(`Digest method not supported: ${algorithm}`)
}
