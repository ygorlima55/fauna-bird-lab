// Figura do canto: nuvem de partículas em camadas que nasce do som medido (não identifica nada).
// Lida de um AnalyserNode (0 a 12 kHz):
//   centro de frequência dos trechos com som → número de ondulações da casca (mais agudo, mais ondulações)
//   largura de banda → número de camadas
//   subida/descida da frequência dominante → inclinação
//   energia do quadro → a figura respira e espalha
// Ao parar, fica congelada na média da sessão; assinatura() devolve esses números para salvar com a sessão.
const FMAX = 12000, FMIN = 300;   // abaixo de 300 Hz é quase sempre vento ou manuseio
const REPOUSO = { centroideKHz: 3, larguraKHz: 2, inclinacao: 0 };

const lerCores = () => {
  const s = getComputedStyle(document.documentElement);
  const t = (n, p) => s.getPropertyValue(n).trim() || p;
  return { cores: [t("--p3", "#E8C45C"), t("--p2", "#4FD2F2"), t("--p1", "#2C63E0")], claro: t("--modo", "escuro") === "claro" };
};

function sorteio(semente) {
  return () => { semente = (semente * 16807) % 2147483647; return (semente - 1) / 2147483646; };
}

function parametros({ centroideKHz, larguraKHz, inclinacao }) {
  return {
    k: Math.max(2, Math.min(9, 2 + centroideKHz / 1.2)),          // contínuo: mistura duas ondulações vizinhas
    camadas: Math.max(2, Math.min(6, 2 + larguraKHz / 1.5)),
    inc: Math.max(-0.5, Math.min(0.5, inclinacao)),
  };
}

function criarParticulas(n, semente = 7) {
  const r = sorteio(semente), g = () => (r() + r() + r() - 1.5) / 1.5, P = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    const dentro = r() < 0.28;
    P.set([r() * Math.PI * 2, dentro ? -1 : Math.pow(r(), 0.75), g(), dentro ? Math.sqrt(r()) : 1, r()], i * 5);
  }
  return P;
}

// desenha um quadro; t em ms, en = energia 0..1
function quadro(g, w, h, P, p, t, en, raio, { cores, claro }) {
  const m = Math.min(w, h) * raio, cx = w * 0.53, cy = h * 0.5;
  const k0 = Math.floor(p.k), k1 = k0 + 1, f = p.k - k0, cam = p.camadas;
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = claro ? "source-over" : "lighter";
  const grupos = [[], [], []];
  for (let i = 0; i < P.length; i += 5) {
    const th = P[i], q = P[i + 1], j = P[i + 2], u = P[i + 3], z = P[i + 4];
    const c = q < 0 ? 0 : Math.floor(q * cam);
    const fase = c * 0.55 + t * 0.00025 * (1 + c * 0.2);
    const onda = (1 - f) * Math.cos(k0 * th + fase) + f * Math.cos(k1 * th + fase);
    let rr = (0.78 + c * 0.075) * (1 + 0.07 * onda + 0.035 * Math.sin((k0 + 1) * th - t * 0.0002)) *
      (1 + en * 0.1 * Math.sin(t * 0.012 + c * 1.3 + th * 3));
    rr += j * (c === 0 ? 0.012 : 0.028) * (1 + en * 2);
    if (q < 0) rr *= u * 0.74;
    const x = cx - c * m * 0.075 + Math.cos(th) * rr * m * (1 + p.inc * 0.08 * Math.cos(th));
    const y = cy + Math.sin(th) * rr * m * 0.97 + p.inc * m * 0.1 * Math.cos(th) * Math.sin(th);
    const grupo = q < 0 ? (z < 0.55 ? 0 : 1) : c === 0 ? 0 : c < cam / 2 ? 1 : 2;
    grupos[grupo].push(x, y, z);
  }
  for (let k = 0; k < 3; k++) {
    g.fillStyle = cores[k];
    g.globalAlpha = claro ? (k === 2 ? 0.35 : 0.55) : k === 0 ? 0.55 : 0.5;
    const a = grupos[k];
    for (let i = 0; i < a.length; i += 3) { const s = a[i + 2] < 0.08 ? 1.8 : 1.05; g.fillRect(a[i], a[i + 1], s, s); }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}

function ajustarCanvas(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r.width * d));
  cv.height = Math.max(1, Math.round(r.height * d));
  const g = cv.getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0);
  return { g, w: r.width, h: r.height };
}

export class FiguraCanto {
  constructor(canvas, { n = 7000, raio = 0.4 } = {}) {
    this.cv = canvas; this.raio = raio; this.P = criarParticulas(n);
    this.alvo = { ...REPOUSO }; this.atual = { ...REPOUSO }; this.en = 0; this.visivel = true;
    this.estilo = lerCores();
    this.tam = ajustarCanvas(canvas);
    new ResizeObserver(() => { this.tam = ajustarCanvas(canvas); }).observe(canvas);
    new IntersectionObserver((e) => { this.visivel = e[0].isIntersecting; }).observe(canvas);
    const tema = () => { this.estilo = lerCores(); };
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", tema);
    this.reduzido = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.zerar();
    const laco = (t) => { this.passo(t); requestAnimationFrame(laco); };
    requestAnimationFrame(laco);
  }

  zerar() {
    this.soma = { peso: 0, c: 0, l: 0, inc: 0, nInc: 0, quadros: 0 };
    this.piso = null; this.picoAnt = null;
  }

  ligar(analisador) {
    this.zerar();
    this.analisador = analisador;
    this.dados = new Uint8Array(analisador.frequencyBinCount);
  }

  // congela na média da sessão
  desligar() {
    this.analisador = null;
    const a = this.assinatura();
    if (a) this.alvo = a;
  }

  definir(assinatura) { if (assinatura) this.alvo = { ...REPOUSO, ...assinatura }; }

  assinatura() {
    const s = this.soma;
    if (s.peso <= 0) return null;
    return {
      centroideKHz: +(s.c / s.peso).toFixed(2), larguraKHz: +(s.l / s.peso).toFixed(2),
      inclinacao: s.nInc ? +(s.inc / s.nInc).toFixed(3) : 0, quadrosComSom: s.quadros,
    };
  }

  medir() {
    const A = this.analisador, d = this.dados;
    A.getByteFrequencyData(d);
    const hzPorFaixa = A.context.sampleRate / 2 / d.length;
    const i0 = Math.ceil(FMIN / hzPorFaixa), i1 = Math.min(d.length - 1, Math.floor(FMAX / hzPorFaixa));
    let soma = 0, sp = 0, sf = 0, pico = i0;
    for (let i = i0; i <= i1; i++) {
      const v = d[i] / 255, w = v * v;
      soma += v; sp += w; sf += w * i;
      if (d[i] > d[pico]) pico = i;
    }
    const nivel = soma / (i1 - i0 + 1);
    this.piso = this.piso == null ? nivel : Math.min(nivel, this.piso * 0.995 + nivel * 0.005);   // piso de ruído lento
    const acima = nivel - this.piso;
    this.en += (Math.min(1, acima * 8) - this.en) * 0.25;
    if (acima < 0.03 || sp <= 0) { this.picoAnt = null; return; }
    const centro = sf / sp;
    let sv = 0;
    for (let i = i0; i <= i1; i++) { const v = d[i] / 255; sv += v * v * (i - centro) ** 2; }
    const cKHz = centro * hzPorFaixa / 1000, lKHz = 2 * Math.sqrt(sv / sp) * hzPorFaixa / 1000;
    const s = this.soma, peso = acima;
    s.peso += peso; s.c += cKHz * peso; s.l += lKHz * peso; s.quadros++;
    const picoKHz = pico * hzPorFaixa / 1000;
    if (this.picoAnt != null && Math.abs(picoKHz - this.picoAnt) < 1.5) { s.inc += (picoKHz - this.picoAnt) * 4; s.nInc++; }
    this.picoAnt = picoKHz;
    this.alvo = { centroideKHz: cKHz, larguraKHz: lKHz, inclinacao: s.nInc ? s.inc / s.nInc : 0 };
  }

  passo(t) {
    if (this.analisador) this.medir(); else this.en *= 0.94;
    for (const k of ["centroideKHz", "larguraKHz", "inclinacao"]) this.atual[k] += (this.alvo[k] - this.atual[k]) * 0.04;
    if (!this.visivel || document.hidden || !this.tam.w) return;
    if (this.reduzido && !this.analisador && this.desenhado) return;
    quadro(this.tam.g, this.tam.w, this.tam.h, this.P, parametros(this.atual), this.reduzido ? 0 : t, this.en, this.raio, this.estilo);
    this.desenhado = true;
  }
}

// figura parada, para o histórico
const PEQUENA = criarParticulas(1800, 11);
export function desenharMiniatura(canvas, assinatura, { raio = 0.42, n } = {}) {
  const { g, w, h } = ajustarCanvas(canvas);
  quadro(g, w, h, n ? criarParticulas(n, 11) : PEQUENA, parametros({ ...REPOUSO, ...assinatura }), 0, 0, raio, lerCores());
}
