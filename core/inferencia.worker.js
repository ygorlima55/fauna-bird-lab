// Web Worker de inferência: roda o BirdNET+ V3.0 e o geomodelo com ONNX Runtime Web (WASM),
// fora da thread da tela. Mensagens:
//   {tipo:"carregar", base}                      → {tipo:"pronto", classes, threads, msCarregar}
//   {tipo:"analisar", id, pcm(Float32Array 32k), embeddings?, alvo?} → {tipo:"progresso", id, feitas, total} ...
//       {tipo:"analise", id, maximo, topJanelas, msPorJanela [, embeddings (janelas×1280), escoresAlvo (por janela)]}
//   {tipo:"prior", id, lat, lon, semana}          → {tipo:"prior", id, bruto, alinhado}
import * as ort from "../vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs";
import { SR, JANELA_S, iniciosJanelas, lerRotulosSom, mapaGeoParaSom, alinharPrior } from "./ranking.js";

const ARQ = {
  som: "BirdNET+_V3.0-preview3.1_Global_10K-pruned_FP16.onnx",
  geo: "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_FP16.onnx",
  rotulosSom: "BirdNET+_V3.0-preview3.1_Global_10K-pruned_Labels.csv",
  rotulosGeo: "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_Labels.txt",
};
const LOTE = 8;            // janelas por chamada ao modelo
const TOP_JANELA = 5;
const DIM_EMB = 1280;      // tamanho do embedding do BirdNET+ V3.0      // quantas espécies guardar por janela (para a tela "ao vivo")

let som, geo, mapa, nClasses;

async function carregar(base) {
  const t = performance.now();
  ort.env.wasm.wasmPaths = new URL("../vendor/onnxruntime-web-1.30.0/", import.meta.url).href;
  // várias threads só com isolamento de origem (COOP/COEP); sem ele, 1 thread
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1;
  const url = (n) => new URL(n, base).href;
  const opcoes = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const [s, g, tSom, tGeo] = await Promise.all([
    ort.InferenceSession.create(url(ARQ.som), opcoes),
    ort.InferenceSession.create(url(ARQ.geo), opcoes),
    fetch(url(ARQ.rotulosSom)).then((r) => r.text()),
    fetch(url(ARQ.rotulosGeo)).then((r) => r.text()),
  ]);
  som = s; geo = g;
  const rotulos = lerRotulosSom(tSom);
  mapa = mapaGeoParaSom(rotulos, tGeo);
  nClasses = rotulos.length;
  return { classes: nClasses, threads: ort.env.wasm.numThreads, msCarregar: Math.round(performance.now() - t),
           semPrior: mapa.filter((k) => k < 0).length };
}

async function analisar(id, pcm, { embeddings: querEmb = false, alvo = -1 } = {}) {
  const n = JANELA_S * SR, inicios = iniciosJanelas(pcm.length);
  const maximo = new Float32Array(nClasses);
  const topJanelas = [];
  const embs = querEmb ? new Float32Array(inicios.length * DIM_EMB) : null;
  const escoresAlvo = alvo >= 0 ? new Float32Array(inicios.length) : null;
  const t = performance.now();
  for (let j = 0; j < inicios.length; j += LOTE) {
    const parte = inicios.slice(j, j + LOTE);
    const dados = new Float32Array(parte.length * n);   // zeros = completar o fim
    parte.forEach((ini, k) => dados.set(pcm.subarray(ini, Math.min(ini + n, pcm.length)), k * n));
    const saida = await som.run({ input: new ort.Tensor("float32", dados, [parte.length, n]) });
    const pred = saida.predictions.data;
    if (embs) embs.set(saida.embeddings_out.data, j * DIM_EMB);
    for (let k = 0; k < parte.length; k++) {
      const linha = pred.subarray(k * nClasses, (k + 1) * nClasses);
      for (let c = 0; c < nClasses; c++) if (linha[c] > maximo[c]) maximo[c] = linha[c];
      if (escoresAlvo) escoresAlvo[j + k] = linha[alvo];
      const melhores = Array.from(linha.keys()).sort((a, b) => linha[b] - linha[a]).slice(0, TOP_JANELA);
      topJanelas.push({ inicioS: parte[k] / SR, indices: melhores, escores: melhores.map((c) => linha[c]) });
    }
    saida.predictions.dispose?.(); saida.embeddings_out?.dispose?.();
    postMessage({ tipo: "progresso", id, feitas: Math.min(j + LOTE, inicios.length), total: inicios.length });
  }
  const msPorJanela = (performance.now() - t) / inicios.length;
  const extra = {}, transf = [maximo.buffer];
  if (embs) { extra.embeddings = embs; transf.push(embs.buffer); }
  if (escoresAlvo) { extra.escoresAlvo = escoresAlvo; transf.push(escoresAlvo.buffer); }
  postMessage({ tipo: "analise", id, maximo, topJanelas, janelas: inicios.length, msPorJanela, ...extra }, transf);
}

async function prior(id, lat, lon, semana) {
  const saida = await geo.run({ input: new ort.Tensor("float32", Float32Array.of(lat, lon, semana), [1, 3]) });
  const bruto = new Float32Array(saida.probabilities.data);
  const alinhado = alinharPrior(bruto, mapa);
  postMessage({ tipo: "prior", id, bruto, alinhado }, [bruto.buffer, alinhado.buffer]);
}

onmessage = async ({ data: m }) => {
  try {
    if (m.tipo === "carregar") postMessage({ tipo: "pronto", ...(await carregar(m.base)) });
    else if (m.tipo === "analisar") await analisar(m.id, m.pcm, m.opcoes);
    else if (m.tipo === "prior") await prior(m.id, m.lat, m.lon, m.semana);
  } catch (e) {
    postMessage({ tipo: "erro", id: m.id, mensagem: String(e?.message || e) });
  }
};
