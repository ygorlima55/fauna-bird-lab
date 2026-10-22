// Teste de desempenho do aparelho: latência por janela (caminho ao vivo e de importação),
// fator de tempo real, memória e dados do aparelho. Usa áudio sintético (ruído + notas), então
// mede velocidade, não acerto.
import { SR, JANELA_S } from "./ranking.js";

function sinalSintetico(segundos) {
  const pcm = new Float32Array(segundos * SR);
  let semente = 12345;
  const aleatorio = () => ((semente = (semente * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR, nota = Math.floor(t * 4) % 2 === 0 ? Math.sin(2 * Math.PI * (2500 + 800 * Math.sin(t * 9)) * t) : 0;
    pcm[i] = 0.02 * aleatorio() + 0.3 * nota;
  }
  return pcm;
}

const estat = (v) => {
  const o = [...v].sort((a, b) => a - b), media = o.reduce((a, b) => a + b, 0) / o.length;
  return { media: Math.round(media), mediana: Math.round(o[Math.floor(o.length / 2)]), p95: Math.round(o[Math.min(o.length - 1, Math.floor(o.length * 0.95))]),
           min: Math.round(o[0]), max: Math.round(o[o.length - 1]) };
};

async function memoria() {
  const m = {};
  try {
    if (self.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
      const r = await performance.measureUserAgentSpecificMemory();   // inclui o worker do modelo
      m.totalMB = Math.round(r.bytes / 1e6);
      m.metodo = "measureUserAgentSpecificMemory";
    }
  } catch (e) { m.erroMedicao = e.message; }
  if (performance.memory) {
    m.heapJsPaginaMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
    m.metodo ??= "performance.memory (só a página, sem o worker e o WASM)";
  }
  return m;
}

// motor: MotorBirdNET já carregado. aoProgresso(texto) mostra o andamento na tela.
export async function medirDesempenho(motor, { janelasAoVivo = 20, aoProgresso = () => {} } = {}) {
  const r = { quando: new Date().toISOString() };
  r.aparelho = {
    userAgent: navigator.userAgent, nucleos: navigator.hardwareConcurrency || null, memoriaGB: navigator.deviceMemory || null,
    isolamentoOrigem: self.crossOriginIsolated, threadsModelo: motor.info?.threads, msCarregarModelo: motor.info?.msCarregar,
    seguro: self.isSecureContext, origem: location.origin,
  };
  r.memoriaAntes = await memoria();

  // caminho ao vivo: 1 janela de 3 s por chamada (a 1ª é aquecimento e fica fora)
  const janela = sinalSintetico(JANELA_S);
  const tempos = [];
  let aquecimento = null;
  for (let i = 0; i <= janelasAoVivo; i++) {
    aoProgresso(`janela ao vivo ${i}/${janelasAoVivo}`);
    const t = performance.now();
    await motor.analisar(janela);
    const ms = performance.now() - t;
    if (i === 0) aquecimento = ms; else tempos.push(ms);
  }
  r.aoVivo = { janelas: tempos.length, ms: estat(tempos), aquecimentoMs: Math.round(aquecimento) };
  r.aoVivo.fatorTempoReal = +(1000 / r.aoVivo.ms.media).toFixed(2);   // >1: dá conta do passo de 1 s
  r.aoVivo.passoRecomendadoS = r.aoVivo.ms.p95 < 900 ? 1 : r.aoVivo.ms.p95 < 1800 ? 2 : 3;

  // caminho de importação: 60 s de áudio em lotes de 8 janelas
  aoProgresso("importação de 60 s");
  const t = performance.now();
  const imp = await motor.analisar(sinalSintetico(60));
  const total = performance.now() - t;
  r.importacao = { audioS: 60, janelas: imp.janelas, msTotal: Math.round(total), msPorJanela: Math.round(total / imp.janelas),
                   vezesMaisRapidoQueTempoReal: +((60 * 1000) / total).toFixed(1) };

  r.memoriaDepois = await memoria();
  try {
    const e = await navigator.storage.estimate();
    r.armazenamento = { usadoMB: Math.round(e.usage / 1e6), cotaMB: Math.round(e.quota / 1e6), persistente: await navigator.storage.persisted?.() };
  } catch {}
  aoProgresso("pronto");
  return r;
}
