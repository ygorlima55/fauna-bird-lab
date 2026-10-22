// Espectrograma rolando num <canvas>, lido de um AnalyserNode (0 a FMAX Hz, linear).
const FMAX = 12000;

// paleta escura → clara (tipo "magma"), pré-calculada em 256 cores
const PALETA = (() => {
  const pontos = [[0, [12, 10, 24]], [0.35, [84, 28, 110]], [0.6, [196, 60, 78]], [0.82, [248, 150, 64]], [1, [252, 244, 180]]];
  const cores = [];
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    let j = 0;
    while (j < pontos.length - 2 && t > pontos[j + 1][0]) j++;
    const [t0, c0] = pontos[j], [t1, c1] = pontos[j + 1], u = (t - t0) / (t1 - t0);
    cores.push(c0.map((v, i) => Math.round(v + (c1[i] - v) * u)));
  }
  return cores;
})();

export class Espectrograma {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d", { willReadFrequently: false });
    this.ajustar();
    addEventListener("resize", () => this.ajustar());
  }

  ajustar() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.limpar();
  }

  limpar() {
    this.g.fillStyle = `rgb(${PALETA[0].join(",")})`;
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  ligar(analisador) {
    this.analisador = analisador;
    this.dados = new Uint8Array(analisador.frequencyBinCount);
    const loop = () => { if (!this.analisador) return; this.coluna(); this.quadro = requestAnimationFrame(loop); };
    this.quadro = requestAnimationFrame(loop);
  }

  desligar() { cancelAnimationFrame(this.quadro); this.analisador = null; }

  coluna() {
    const { width: L, height: A } = this.canvas, g = this.g, passo = 2;
    g.drawImage(this.canvas, -passo, 0);   // rola para a esquerda
    this.analisador.getByteFrequencyData(this.dados);
    const nyq = this.analisador.context.sampleRate / 2;
    const nFaixas = Math.floor(this.dados.length * Math.min(FMAX, nyq) / nyq);
    const img = g.createImageData(passo, A);
    for (let y = 0; y < A; y++) {
      const v = this.dados[Math.floor((1 - y / A) * (nFaixas - 1))];
      const [r, gg, b] = PALETA[v];
      for (let x = 0; x < passo; x++) {
        const o = (y * passo + x) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, L - passo, 0);
  }
}
export { FMAX };
