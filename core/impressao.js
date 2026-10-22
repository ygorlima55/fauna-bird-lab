// Impressão digital de áudio (método descrito por Wang, 2003, "An Industrial-Strength Audio Search Algorithm").
// Responde "este som já existe?" (mesma gravação, regravada, recortada ou convertida), não "que espécie é?".
//
// 1. espectrograma (FFT 1024 = 32 ms, passo 512 = 16 ms, 300 Hz a 12 kHz)
// 2. picos: pontos mais fortes que a vizinhança em frequência e em tempo ("mapa de constelação");
//    silêncio e ruído fraco não geram picos
// 3. cada pico (âncora) se liga aos próximos picos dentro de ~1 s: o par vira um código de 24 bits
//    (frequência da âncora, frequência do alvo, distância em quadros)
// 4. busca: códigos iguais em duas gravações votam no deslocamento de tempo entre elas; se muitos votam no
//    MESMO deslocamento, é a mesma gravação a partir daquele ponto
export const VERSAO_IMPRESSAO = 1;

const N = 1024, PASSO = 512;
const BIN_MIN = 10, BIN_MAX = 384;          // 312 Hz a 12 kHz a 32 kHz (31,25 Hz por faixa)
const VIZ_F = 8, VIZ_T = 6;                 // vizinhança do pico: ±8 faixas (250 Hz), ±6 quadros (96 ms)
const PICOS_POR_QUADRO = 3;
const LIMIAR_DB = -75;                      // abaixo disso não é pico (silêncio, zeros do microfone mudo)
const ACIMA_DO_QUADRO_DB = 8;               // o pico precisa estar 8 dB acima da média do quadro
const ALVO_MIN = 1, ALVO_MAX = 63;          // zona de alvos: 1 a 63 quadros depois (16 ms a 1 s)
const ALVO_DF = 96;                         // até ±96 faixas (3 kHz) da âncora
const LEQUE = 5;                            // alvos por âncora

export const segundosPorQuadro = (sr) => PASSO / sr;

// FFT radix-2 com tabelas prontas (N fixo)
const COS = new Float32Array(N / 2), SEN = new Float32Array(N / 2), REV = new Uint16Array(N);
for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / N); SEN[i] = -Math.sin((2 * Math.PI * i) / N); }
for (let i = 0, b = Math.log2(N); i < N; i++) { let r = 0; for (let k = 0; k < b; k++) r |= ((i >> k) & 1) << (b - 1 - k); REV[i] = r; }
const JANELA = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

function espectroDb(pcm, ini, re, im, saida) {
  for (let i = 0; i < N; i++) { const j = REV[i]; re[j] = (pcm[ini + i] || 0) * JANELA[i]; im[j] = 0; }
  for (let tam = 2; tam <= N; tam <<= 1) {
    const meio = tam >> 1, passo = N / tam;
    for (let i = 0; i < N; i += tam) for (let k = 0; k < meio; k++) {
      const a = i + k, b = a + meio, w = k * passo;
      const tr = re[b] * COS[w] - im[b] * SEN[w], ti = re[b] * SEN[w] + im[b] * COS[w];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let f = BIN_MIN; f < BIN_MAX; f++) saida[f - BIN_MIN] = 10 * Math.log10(re[f] * re[f] + im[f] * im[f] + 1e-12);
}

// Picos do espectrograma: máximo local em ±VIZ_F faixas e ±VIZ_T quadros. Processa em fluxo (guarda só
// 2·VIZ_T+1 quadros), então funciona para gravações longas sem estourar a memória.
export function picos(pcm, sr = 32000) {
  const nQ = Math.max(0, Math.floor((pcm.length - N) / PASSO) + 1), L = BIN_MAX - BIN_MIN, W = 2 * VIZ_T + 1;
  const anel = Array.from({ length: W }, () => new Float32Array(L).fill(-200));
  const re = new Float32Array(N), im = new Float32Array(N), achados = [];
  for (let q = 0; q < nQ + VIZ_T; q++) {
    if (q < nQ) espectroDb(pcm, q * PASSO, re, im, anel[q % W]); else anel[q % W].fill(-200);
    const c = q - VIZ_T;                       // quadro central, já com a vizinhança completa
    if (c < 0) continue;
    const quadro = anel[c % W];
    let media = 0;
    for (let f = 0; f < L; f++) media += quadro[f];
    media /= L;
    const cand = [];
    for (let f = 0; f < L; f++) {
      const v = quadro[f];
      if (v < LIMIAR_DB || v < media + ACIMA_DO_QUADRO_DB) continue;
      let maximo = true;
      for (let dt = -VIZ_T; dt <= VIZ_T && maximo; dt++) {
        const outro = anel[(c + dt + W) % W];
        if (c + dt < 0 || c + dt >= nQ) continue;
        for (let df = -VIZ_F; df <= VIZ_F; df++) {
          if ((dt === 0 && df === 0) || f + df < 0 || f + df >= L) continue;
          if (outro[f + df] > v || (outro[f + df] === v && (dt < 0 || (dt === 0 && df < 0)))) { maximo = false; break; }
        }
      }
      if (maximo) cand.push([f + BIN_MIN, v]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    for (const [f] of cand.slice(0, PICOS_POR_QUADRO)) achados.push(c, f);
  }
  return { picos: Uint16Array.from(achados), quadros: nQ };   // pares (quadro, faixa), em ordem de tempo
}

// Gera os códigos: Uint32Array de códigos e Uint32Array com o quadro da âncora de cada código.
export function impressao(pcm, sr = 32000) {
  const { picos: p, quadros } = picos(pcm, sr);
  const n = p.length / 2, codigos = [], tempos = [];
  for (let i = 0; i < n; i++) {
    const t1 = p[2 * i], f1 = p[2 * i + 1];
    let ligados = 0;
    for (let j = i + 1; j < n && ligados < LEQUE; j++) {
      const dt = p[2 * j] - t1;
      if (dt < ALVO_MIN) continue;
      if (dt > ALVO_MAX) break;
      const f2 = p[2 * j + 1];
      if (Math.abs(f2 - f1) > ALVO_DF) continue;
      codigos.push(((f1 & 0x1ff) << 15) | ((f2 & 0x1ff) << 6) | (dt & 0x3f));
      tempos.push(t1);
      ligados++;
    }
  }
  return { versao: VERSAO_IMPRESSAO, sr, passo: PASSO, quadros, picos: n, codigos: Uint32Array.from(codigos), tempos: Uint32Array.from(tempos) };
}

// Índice: código → lista de [id, quadro]. impressoes: [{id, codigos, tempos}]
export function indice(impressoes) {
  const mapa = new Map();
  for (const { id, codigos, tempos } of impressoes) {
    for (let k = 0; k < codigos.length; k++) {
      let lista = mapa.get(codigos[k]);
      if (!lista) mapa.set(codigos[k], (lista = []));
      lista.push(id, tempos[k]);
    }
  }
  return mapa;
}

// Procura a consulta no índice. Para cada gravação, conta os códigos que concordam no mesmo deslocamento
// (com tolerância de ±1 quadro). Devolve as que passam dos mínimos, da mais forte para a mais fraca.
// deslocamentoS > 0: a consulta começa nesse segundo da gravação encontrada.
export function procurar(consulta, mapa, { ignorar = null, minCodigos = 20, minFracao = 0.03 } = {}) {
  const votos = new Map();   // id → Map(deslocamento → votos)
  for (let k = 0; k < consulta.codigos.length; k++) {
    const lista = mapa.get(consulta.codigos[k]);
    if (!lista) continue;
    for (let i = 0; i < lista.length; i += 2) {
      const id = lista[i];
      if (id === ignorar) continue;
      const d = lista[i + 1] - consulta.tempos[k];
      let porId = votos.get(id);
      if (!porId) votos.set(id, (porId = new Map()));
      porId.set(d, (porId.get(d) || 0) + 1);
    }
  }
  const s = segundosPorQuadro(consulta.sr), saida = [];
  for (const [id, porId] of votos) {
    let melhor = 0, desl = 0;
    for (const [d, v] of porId) {
      const soma = v + (porId.get(d - 1) || 0) + (porId.get(d + 1) || 0);
      if (soma > melhor) { melhor = soma; desl = d; }
    }
    const fracao = consulta.codigos.length ? melhor / consulta.codigos.length : 0;
    if (melhor >= minCodigos && fracao >= minFracao)
      saida.push({ id, codigos: melhor, fracao: +fracao.toFixed(3), deslocamentoS: +(desl * s).toFixed(2) });
  }
  return saida.sort((a, b) => b.codigos - a.codigos);
}

// Para guardar em JSON (pacote da pesquisa): códigos e tempos intercalados, em base64.
export function paraBase64(imp) {
  const v = new Uint32Array(imp.codigos.length * 2);
  for (let k = 0; k < imp.codigos.length; k++) { v[2 * k] = imp.codigos[k]; v[2 * k + 1] = imp.tempos[k]; }
  let bin = "";
  const bytes = new Uint8Array(v.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function deBase64(texto, sr = 32000) {
  const bytes = Uint8Array.from(atob(texto), (c) => c.charCodeAt(0)), v = new Uint32Array(bytes.buffer);
  const codigos = new Uint32Array(v.length / 2), tempos = new Uint32Array(v.length / 2);
  for (let k = 0; k < codigos.length; k++) { codigos[k] = v[2 * k]; tempos[k] = v[2 * k + 1]; }
  return { versao: VERSAO_IMPRESSAO, sr, passo: PASSO, codigos, tempos };
}
