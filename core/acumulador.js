// Junta as janelas de uma sessão ao vivo numa lista de espécies estável (estilo Merlin):
// uma espécie entra quando passa do limiar em pelo menos MIN_JANELAS janelas, ou de uma vez se
// o escore for muito alto. Valores padrão do model_config.json do birdnet-live-app
// (defaultConfidenceThreshold 0,35 · minSupportWindows 2 · veryHighImmediateThreshold 0,98).
import { ALFA } from "./ranking.js";

const PISO = 0.05;   // abaixo disso a janela nem é registrada para a espécie

export class Acumulador {
  constructor({ limiar = 0.35, minJanelas = 2, imediato = 0.98, ativaS = 3 } = {}) {
    Object.assign(this, { limiar, minJanelas, imediato, ativaS });
    this.especies = new Map();   // índice da classe → registro
    this.janelas = 0;
  }

  // acustico: Float32Array de uma janela; prior: alinhado ao modelo de som, ou null sem localização.
  // Devolve os índices que entraram na lista nesta janela (para a observabilidade; a regra não muda).
  adicionar(acustico, prior, tempoS) {
    this.janelas++;
    const entraram = [];
    for (let i = 0; i < acustico.length; i++) {
      const a = acustico[i];
      if (a < PISO) continue;
      const p = prior ? prior[i] : 1;
      const f = a * Math.pow(Math.min(Math.max(p, 0), 1), prior ? ALFA : 0);
      let r = this.especies.get(i);
      if (!r) this.especies.set(i, (r = { indice: i, melhorFinal: 0, melhorAcustico: 0, prior: p, acima: 0, primeiraS: tempoS, ultimaS: tempoS }));
      r.prior = p;
      if (f > r.melhorFinal) r.melhorFinal = f;
      if (a > r.melhorAcustico) r.melhorAcustico = a;
      if (f >= this.limiar) { r.acima++; r.ultimaS = tempoS; }
      if (!r.entrouS && this.naLista(r)) { r.entrouS = tempoS; entraram.push(i); }
    }
    return entraram;
  }

  naLista(r) { return r.acima >= this.minJanelas || r.melhorFinal >= this.imediato; }

  lista(tempoS, n = 5) {
    return [...this.especies.values()]
      .filter((r) => this.naLista(r))
      .sort((a, b) => b.melhorFinal - a.melhorFinal)
      .slice(0, n)
      .map((r) => ({ ...r, ativa: tempoS - r.ultimaS <= this.ativaS }));
  }
}
