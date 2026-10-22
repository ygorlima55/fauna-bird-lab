// Similaridade acústica (Parte 16): "qual gravação de referência mais se parece com a minha?".
// Independente da classificação: usa só os embeddings do BirdNET+ (1.280 números por janela de 3 s).
// Para cada gravação, junta as janelas onde a espécie comparada aparece mais forte (assim o ruído e
// outros cantos pesam menos) e compara os dois vetores pelo cosseno (1 = igual, 0 = sem relação).
export const DIM_EMB = 1280;

// embs: Float32Array (janelas × DIM_EMB); escores: escore da espécie em cada janela (ou null = todas as janelas)
export function embeddingDaEspecie(embs, escores, { limiar = 0.1, maxJanelas = 5 } = {}) {
  const n = embs.length / DIM_EMB;
  let idx = [...Array(n).keys()];
  if (escores) {
    idx = idx.filter((i) => escores[i] >= limiar).sort((a, b) => escores[b] - escores[a]).slice(0, maxJanelas);
    if (!idx.length) return null;   // a espécie não aparece nesta gravação
  }
  const v = new Float32Array(DIM_EMB);
  for (const i of idx) for (let d = 0; d < DIM_EMB; d++) v[d] += embs[i * DIM_EMB + d];
  return normalizar(v);
}

export function normalizar(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function cosseno(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

// referencias: [{..., emb}] → mesmas, com .semelhanca, da mais parecida para a menos
export function ordenarPorSemelhanca(alvo, referencias) {
  return referencias.map((r) => ({ ...r, semelhanca: r.emb ? cosseno(alvo, r.emb) : null }))
    .sort((a, b) => (b.semelhanca ?? -1) - (a.semelhanca ?? -1));
}
