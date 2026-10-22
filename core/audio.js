// Utilidades de áudio sem estado: juntar blocos, WAV 16 bits, SHA-256, SNR aproximado.

export function juntar(blocos) {
  const n = blocos.reduce((s, b) => s + b.length, 0), saida = new Float32Array(n);
  let p = 0;
  for (const b of blocos) { saida.set(b, p); p += b.length; }
  return saida;
}

// PCM float (−1 a 1) → WAV PCM 16 bits mono (metade do tamanho do float; suficiente para revisão).
export function paraWav16(pcm, sr) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const txt = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  txt(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); txt(8, "WAVE");
  txt(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function sha256(dados) {
  const bytes = dados instanceof Blob ? await dados.arrayBuffer() : dados;
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SNR aproximado em dB: energia dos quadros mais fortes (p95) sobre a dos mais fracos (p10),
// em quadros de 50 ms. Serve para separar gravação limpa de ruidosa, não é medida de laboratório.
export function snrAproximado(pcm, sr) {
  const q = Math.round(sr * 0.05), rms = [];
  for (let i = 0; i + q <= pcm.length; i += q) {
    let s = 0;
    for (let j = i; j < i + q; j++) s += pcm[j] * pcm[j];
    rms.push(Math.sqrt(s / q));
  }
  if (rms.length < 10) return null;
  rms.sort((a, b) => a - b);
  const p = (f) => rms[Math.min(rms.length - 1, Math.floor(f * rms.length))];
  const fraco = Math.max(p(0.1), 1e-6);
  return Math.round(20 * Math.log10(p(0.95) / fraco) * 10) / 10;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}
