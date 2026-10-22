// Captura ao vivo a 32 kHz (a taxa do modelo), do microfone ou de um arquivo tocado em tempo real.
// O AudioContext é criado já em 32 kHz: o navegador reamostra a entrada, e o espectrograma e o
// modelo veem o mesmo sinal. Cada bloco de áudio chega em onBloco(Float32Array).
import { SR } from "./ranking.js";

const CODIGO_WORKLET = `
class Coletor extends AudioWorkletProcessor {
  process(entradas) {
    const c = entradas[0] && entradas[0][0];
    if (c) this.port.postMessage(c.slice());
    return true;
  }
}
registerProcessor("coletor", Coletor);`;

export class Captura {
  constructor({ onBloco }) { this.onBloco = onBloco; }

  async preparar() {
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.coletor = new AudioWorkletNode(this.ctx, "coletor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    this.coletor.port.onmessage = ({ data }) => this.onBloco(data);
    this.analisador = this.ctx.createAnalyser();
    this.analisador.fftSize = 1024;            // 512 faixas de 15,6 Hz até 16 kHz
    this.analisador.smoothingTimeConstant = 0;
    this.analisador.minDecibels = -110;
    this.analisador.maxDecibels = -30;
    this.entrada = this.ctx.createGain();      // mono: o coletor e o analisador leem daqui
    this.entrada.channelCount = 1;
    this.entrada.channelCountMode = "explicit";
    this.entrada.connect(this.coletor);
    this.entrada.connect(this.analisador);
  }

  async microfone() {
    await this.preparar();
    // sem filtros de chamada de voz: eles cortam e distorcem cantos
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    this.fonte = this.ctx.createMediaStreamSource(this.stream);
    this.fonte.connect(this.entrada);
    await this.ctx.resume();
    const ajustes = this.stream.getAudioTracks()[0].getSettings();
    return { origem: "microfone", taxaMicrofone: ajustes.sampleRate || null, taxaAnalise: this.ctx.sampleRate };
  }

  // Toca um arquivo em tempo real pelo mesmo caminho do microfone (para testar e demonstrar).
  async arquivo(bytes, aoTerminar) {
    await this.preparar();
    const buffer = await this.ctx.decodeAudioData(bytes);
    this.fonte = this.ctx.createBufferSource();
    this.fonte.buffer = buffer;
    this.fonte.connect(this.entrada);
    this.fonte.connect(this.ctx.destination);  // para ouvir
    this.fonte.onended = () => aoTerminar?.();
    await this.ctx.resume();
    this.fonte.start();
    return { origem: "arquivo", duracaoS: buffer.duration, taxaAnalise: this.ctx.sampleRate };
  }

  async parar() {
    try { this.fonte?.stop?.(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = this.stream = this.fonte = null;
  }
}

// Guarda os últimos N segundos para montar a janela de 3 s do modelo.
export class Anel {
  constructor(segundos, sr = SR) { this.dados = new Float32Array(segundos * sr); this.pos = 0; this.total = 0; }
  push(bloco) {
    for (let i = 0; i < bloco.length; i++) { this.dados[this.pos] = bloco[i]; this.pos = (this.pos + 1) % this.dados.length; }
    this.total += bloco.length;
  }
  ultimos(n) {
    const saida = new Float32Array(n), d = this.dados, L = d.length;
    const ini = (this.pos - n + L * 2) % L;
    for (let i = 0; i < n; i++) saida[i] = d[(ini + i) % L];
    return saida;
  }
}
