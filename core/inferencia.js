// Motor de identificação (lado da tela). Esconde o worker atrás de promessas:
//   const motor = new MotorBirdNET(urlDaPastaDosModelos);
//   await motor.carregar();
//   const pcm = await paraPcm32k(audioBuffer);            // ou Float32Array já a 32 kHz
//   const { maximo, topJanelas } = await motor.analisar(pcm, (feitas, total) => ...);
//   const { alinhado } = await motor.prior(lat, lon, new Date());
//   const lista = top(reordenar(maximo, alinhado), motor.rotulos);
import { SR, lerRotulosSom, semanaBirdnet } from "./ranking.js";

export class MotorBirdNET {
  constructor(baseModelos) {
    this.base = new URL(baseModelos, location.href).href;
    this.worker = new Worker(new URL("./inferencia.worker.js", import.meta.url), { type: "module" });
    this.pendentes = new Map();
    this.seq = 0;
    this.worker.onmessage = ({ data: m }) => this.receber(m);
    this.worker.onerror = (e) => this.falhar(new Error(e.message || "erro no worker"));
  }

  receber(m) {
    if (m.tipo === "pronto" || (m.tipo === "erro" && m.id === undefined)) {
      const p = this.pendentes.get("carregar");
      this.pendentes.delete("carregar");
      return m.tipo === "pronto" ? p?.ok(m) : p?.erro(new Error(m.mensagem));
    }
    const p = this.pendentes.get(m.id);
    if (!p) return;
    if (m.tipo === "progresso") return p.progresso?.(m.feitas, m.total);
    this.pendentes.delete(m.id);
    m.tipo === "erro" ? p.erro(new Error(m.mensagem)) : p.ok(m);
  }

  falhar(e) {
    for (const p of this.pendentes.values()) p.erro(e);
    this.pendentes.clear();
  }

  pedir(chave, msg, progresso, transferir = []) {
    return new Promise((ok, erro) => {
      this.pendentes.set(chave, { ok, erro, progresso });
      this.worker.postMessage(msg, transferir);
    });
  }

  async carregar() {
    const [info, texto] = await Promise.all([
      this.pedir("carregar", { tipo: "carregar", base: this.base }),
      fetch(new URL("BirdNET+_V3.0-preview3.1_Global_10K-pruned_Labels.csv", this.base)).then((r) => r.text()),
    ]);
    this.rotulos = lerRotulosSom(texto);
    this.info = info;
    return info;
  }

  // pcm: Float32Array mono a 32 kHz. É copiado para o worker (o original continua válido).
  // opcoes.embeddings: devolve o embedding de cada janela; opcoes.alvo: índice de uma espécie, devolve o escore dela por janela.
  analisar(pcm, progresso, opcoes = {}) {
    const id = ++this.seq, copia = pcm.slice();
    return this.pedir(id, { tipo: "analisar", id, pcm: copia, opcoes }, progresso, [copia.buffer]);
  }

  prior(lat, lon, data = new Date()) {
    const id = ++this.seq;
    return this.pedir(id, { tipo: "prior", id, lat, lon, semana: semanaBirdnet(data) });
  }

  encerrar() { this.worker.terminate(); }
}

// Qualquer AudioBuffer (decodeAudioData) → mono a 32 kHz pelo reamostrador do navegador.
export async function paraPcm32k(buffer) {
  const n = Math.ceil(buffer.duration * SR);
  const ctx = new OfflineAudioContext(1, n, SR);
  const fonte = ctx.createBufferSource();
  fonte.buffer = buffer;          // multicanal é misturado em mono pelo destino de 1 canal
  fonte.connect(ctx.destination);
  fonte.start();
  return (await ctx.startRendering()).getChannelData(0);
}
