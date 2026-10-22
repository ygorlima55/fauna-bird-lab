// Sonograma da sessão inteira (imagem PNG) calculado do PCM, para o histórico.
// FFT de 512 pontos (Hann), passo de 256 amostras (8 ms a 32 kHz), 0–FMAX Hz, dB normalizado pelo
// percentil 99 da própria gravação. Colunas demais são reduzidas pelo máximo (não perde notas curtas).
import { FMAX } from "./espectrograma.js";

const N = 512, PASSO = 256, LARG_MAX = 2400, ALTURA = 160;

function fft(re, im) {   // radix-2 in-place
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export async function sonogramaPng(pcm, sr) {
  const nFaixas = Math.floor((N / 2) * Math.min(FMAX, sr / 2) / (sr / 2));
  const nCol = Math.max(1, Math.floor((pcm.length - N) / PASSO) + 1);
  const larg = Math.min(nCol, LARG_MAX), agrupa = nCol / larg;
  const db = new Float32Array(larg * nFaixas).fill(-200);
  const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let c = 0; c < nCol; c++) {
    const ini = c * PASSO;
    for (let i = 0; i < N; i++) { re[i] = (pcm[ini + i] || 0) * hann[i]; im[i] = 0; }
    fft(re, im);
    const x = Math.min(larg - 1, Math.floor(c / agrupa));
    for (let f = 0; f < nFaixas; f++) {
      const v = 10 * Math.log10(re[f] * re[f] + im[f] * im[f] + 1e-12);
      if (v > db[x * nFaixas + f]) db[x * nFaixas + f] = v;
    }
  }
  const ordenado = Float32Array.from(db).sort();
  const topo = ordenado[Math.floor(ordenado.length * 0.99)], base = topo - 70;
  const tela = new OffscreenCanvas(larg, ALTURA), g = tela.getContext("2d"), img = g.createImageData(larg, ALTURA);
  for (let y = 0; y < ALTURA; y++) {
    const f = Math.floor((1 - y / ALTURA) * (nFaixas - 1));
    for (let x = 0; x < larg; x++) {
      const t = Math.max(0, Math.min(1, (db[x * nFaixas + f] - base) / (topo - base)));
      const o = (y * larg + x) * 4, cinza = Math.round(250 - t * 235);   // fundo claro, som escuro (como no papel)
      img.data[o] = cinza; img.data[o + 1] = cinza; img.data[o + 2] = Math.round(cinza * 0.97 + 6); img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return tela.convertToBlob({ type: "image/png" });
}
