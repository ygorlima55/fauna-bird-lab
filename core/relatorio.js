// Relatório de arquivos importados: rótulo provisório pelo nome do arquivo, posição da espécie real,
// TOP-1/3/5 e CSV. Funções puras (testadas em testes/passo4.html).
import { top, posicao } from "./ranking.js";

const normalizar = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// "Pitangus_sulphuratus_XC248804.mp3" ou "bem-te-vi 2026.m4a" → espécie do modelo, se o nome trouxer
// o nome científico (gênero + epíteto) ou o nome popular em português. É só um rótulo PROVISÓRIO
// (UNVERIFIED) até alguém validar.
export function rotuloDoNome(nomeArquivo, rotulos, nomesPt = {}) {
  const base = normalizar(nomeArquivo.replace(/\.[^.]+$/, "")).replace(/[_\-.,()]+/g, " ").replace(/\s+/g, " ").trim();
  const palavras = base.split(" ");
  for (let i = 0; i + 1 < palavras.length; i++) {
    const par = palavras[i] + " " + palavras[i + 1];
    const r = rotulos.find((x) => normalizar(x.especie) === par);
    if (r) return { especie: r.especie, origem: "nome científico no arquivo" };
  }
  const comHifen = normalizar(nomeArquivo.replace(/\.[^.]+$/, "")).replace(/[_.,()]+/g, " ");
  let melhor = null;
  for (const [cient, pt] of Object.entries(nomesPt)) {
    const n = normalizar(pt);
    if (n.length >= 5 && new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(comHifen) &&
        (!melhor || n.length > melhor.n.length)) melhor = { especie: cient, n };
  }
  return melhor ? { especie: melhor.especie, origem: "nome popular no arquivo" } : null;
}

export function linhaRelatorio({ arquivo, especieReal, acustico, final, rotulos, duracaoS, snrDb, msPorJanela, janelas, local }) {
  const t1a = top(acustico, rotulos, 1)[0], t1f = top(final, rotulos, 1)[0];
  return {
    arquivo, especieReal: especieReal || null, duracaoS, snrDb, janelas, msPorJanela,
    lat: local?.lat ?? null, lon: local?.lon ?? null,
    top1: t1f.especie, escoreTop1: t1f.escore, top1SoSom: t1a.especie, escoreTop1SoSom: t1a.escore,
    posicaoSoSom: especieReal ? posicao(acustico, rotulos, especieReal) : null,
    posicaoFinal: especieReal ? posicao(final, rotulos, especieReal) : null,
    escoreReal: especieReal ? final[rotulos.findIndex((r) => r.especie === especieReal)] ?? null : null,
    top5: top(final, rotulos, 5).map((t) => ({ especie: t.especie, escore: t.escore })),
  };
}

// Só conta arquivos com espécie real conhecida e presente no modelo.
export function metricasTopK(linhas) {
  const validas = linhas.filter((l) => l.especieReal && l.posicaoFinal);
  const taxa = (campo, k) => validas.length ? validas.filter((l) => l[campo] <= k).length / validas.length : null;
  const confusoes = validas.filter((l) => l.posicaoFinal > 1).map((l) => ({ real: l.especieReal, previsto: l.top1, escore: l.escoreTop1 }));
  return {
    n: validas.length, semRotulo: linhas.filter((l) => !l.especieReal).length,
    foraDoModelo: linhas.filter((l) => l.especieReal && !l.posicaoFinal).length,
    final: { top1: taxa("posicaoFinal", 1), top3: taxa("posicaoFinal", 3), top5: taxa("posicaoFinal", 5) },
    soSom: { top1: taxa("posicaoSoSom", 1), top3: taxa("posicaoSoSom", 3), top5: taxa("posicaoSoSom", 5) },
    confusoes,
  };
}

export function paraCsv(linhas) {
  const cols = ["arquivo", "especieReal", "top1", "escoreTop1", "posicaoFinal", "posicaoSoSom", "top1SoSom", "escoreTop1SoSom",
    "escoreReal", "duracaoS", "snrDb", "janelas", "msPorJanela", "lat", "lon"];
  const cel = (v) => (v == null ? "" : typeof v === "number" ? String(+v.toFixed(4)) : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(";"), ...linhas.map((l) => cols.map((c) => cel(l[c])).join(";"))].join("\n");
}
