// Observabilidade da sessão (F1, 08_camada_fable.md): o que é preciso para investigar depois, no PC, por que uma
// espécie não apareceu — perfil do aparelho, estado do microfone e do AudioContext, eventos da página com tempo,
// erros e medidas de áudio por janela. Só registra: não muda a captura, o modelo nem o ranking.
// Formato em knowledge/schemas/sessao_observabilidade.schema.json.
export const SCHEMA_OBS = "birdlab.obs/1";
export const DETECTOR_EVENTOS = "nenhum (janelas fixas de 3 s)";   // o app ainda não tem detector de eventos
const MAX_EVENTOS = 500, MAX_ERROS = 50;

// Perfil do aparelho. O modelo exato (ex.: SM-S926B) só vem do Chrome (userAgentData); no Safari fica null.
export async function perfilAparelho() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  const android = ua.match(/Android ([\d.]+)/);
  const chrome = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/), safari = ua.match(/Version\/([\d.]+).*Safari/);
  let alta = {};
  try { alta = (await navigator.userAgentData?.getHighEntropyValues?.(["model", "platformVersion", "fullVersionList"])) || {}; } catch {}
  // o Chrome "congela" o user agent (Android 10, Chrome NNN.0.0.0): a versão real vem do userAgentData
  const chromeReal = alta.fullVersionList?.find((b) => /Chrome/.test(b.brand))?.version;
  const androidReal = android && alta.platformVersion ? alta.platformVersion.split(".")[0] : null;
  return {
    modelo: alta.model || null,
    sistema: ios ? `iOS ${ios[1]}.${ios[2]}${ios[3] ? "." + ios[3] : ""}` : android ? `Android ${androidReal || android[1]}` : (navigator.userAgentData?.platform || navigator.platform),
    versaoPlataforma: alta.platformVersion || null,
    navegador: ios && !ua.includes("CriOS") ? `Safari ${safari?.[1] || "?"}` : chrome ? `Chrome ${chromeReal || chrome[1]}` : "outro",
    nucleos: navigator.hardwareConcurrency || null,
    memoriaGB: navigator.deviceMemory || null,
    tela: `${screen.width}×${screen.height} @${devicePixelRatio}`,
    instalado: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    isolamento: self.crossOriginIsolated === true,
    idioma: navigator.language || null,
    fuso: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    ua,
  };
}

// Ajustes que o navegador realmente aplicou no microfone (o pedido pode ser ignorado).
export function ajustesMicrofone(trilha) {
  if (!trilha) return null;
  const s = trilha.getSettings?.() || {};
  const campos = ["sampleRate", "sampleSize", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "latency"];
  const ajustes = Object.fromEntries(campos.filter((k) => k in s).map((k) => [k, s[k]]));
  return { ...ajustes, rotulo: trilha.label || null, estado: trilha.readyState, mudo: trilha.muted };
}

// Diário da sessão: cada evento leva o tempo da gravação (tS, s de áudio já recebido) e o relógio (quando).
export class Diario {
  constructor(tempoS) { this.tempoS = tempoS; this.eventos = []; this.erros = []; this.descartados = 0; }
  evento(tipo, dados = {}) {
    if (this.eventos.length >= MAX_EVENTOS) { this.descartados++; return; }
    this.eventos.push({ tS: +this.tempoS().toFixed(2), quando: new Date().toISOString(), tipo, ...dados });
  }
  erro(onde, e) {
    if (this.erros.length < MAX_ERROS) this.erros.push({ tS: +this.tempoS().toFixed(2), quando: new Date().toISOString(), onde, mensagem: String(e?.message || e) });
  }
  resumo() { return { eventos: this.eventos, erros: this.erros, eventosDescartados: this.descartados }; }
}

// Medidas de uma janela de áudio (Float32 −1 a 1): nível RMS e pico em dBFS, fração de zeros exatos e de clipping.
export function metricasJanela(pcm) {
  let soma = 0, pico = 0, zeros = 0, clip = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i], a = Math.abs(v);
    soma += v * v;
    if (a > pico) pico = a;
    if (v === 0) zeros++;
    if (a >= 0.999) clip++;
  }
  const db = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : null);
  const n = pcm.length || 1;
  return { rmsDb: db(Math.sqrt(soma / n)), picoDb: db(pico), zerosPct: +(100 * zeros / n).toFixed(1), clipPct: +(100 * clip / n).toFixed(2) };
}
