// Funções puras de ranking (sem ONNX): usadas pelo worker, pelas telas e pelos testes.
// Mesmas regras de ferramentas/bancada.py, para os resultados baterem com o Python.

export const SR = 32000;          // taxa de entrada do BirdNET+ V3.0
export const JANELA_S = 3;        // janela do modelo
export const PASSO_S = 1;         // passo entre janelas (sobreposição de 2 s)
export const ALFA = 0.5;          // peso do prior geográfico: final = acústico × prior^ALFA

// Semana 1–48 (4 por mês), como em geo_model.dart do birdnet-live-app.
export function semanaBirdnet(data) {
  return data.getMonth() * 4 + Math.min(Math.floor((data.getDate() - 1) / 7), 3) + 1;
}

// Rótulos do modelo de som: CSV com ";" e cabeçalho idx;id;sci_name;com_name;class;order
export function lerRotulosSom(texto) {
  const linhas = texto.trim().split(/\r?\n/);
  const cab = linhas.shift().split(";");
  return linhas.map((l) => {
    const c = l.split(";"), r = {};
    cab.forEach((k, i) => { r[k] = c[i]; });
    return { especie: r.sci_name, nome: r.com_name, classe: r.class, ordem: r.order, id: r.id };
  });
}

// Rótulos do geomodelo: "id<TAB>nome científico<TAB>nome comum". Os ids e a ordem NÃO são os do
// modelo de som; a ligação é pelo nome científico (9.789 de 9.789 batem).
export function mapaGeoParaSom(rotulosSom, textoGeo) {
  const pos = new Map();
  textoGeo.trim().split(/\r?\n/).forEach((l, k) => pos.set(l.split("\t")[1], k));
  return Int32Array.from(rotulosSom, (r) => (pos.has(r.especie) ? pos.get(r.especie) : -1));
}

export function alinharPrior(priorGeo, mapa) {
  return Float32Array.from(mapa, (k) => (k >= 0 ? priorGeo[k] : 0));
}

export function reordenar(acustico, prior, alfa = ALFA) {
  return Float32Array.from(acustico, (a, i) => a * Math.pow(Math.min(Math.max(prior[i], 0), 1), alfa));
}

export function top(escores, rotulos, k = 5) {
  const idx = Array.from(escores.keys()).sort((a, b) => escores[b] - escores[a]).slice(0, k);
  return idx.map((i) => ({ ...rotulos[i], indice: i, escore: escores[i] }));
}

// Posição da espécie no ranking. Pessimista: empate conta contra
// (sem isso, um vetor todo zerado daria "TOP-1" falso).
export function posicao(escores, rotulos, especie) {
  const i = rotulos.findIndex((r) => r.especie === especie);
  if (i < 0) return null;
  let n = 0;
  for (const e of escores) if (e >= escores[i]) n++;
  return n;
}

// Início (em amostras) de cada janela; o fim do áudio é completado com zeros dentro do worker.
export function iniciosJanelas(nAmostras, sr = SR) {
  const n = JANELA_S * sr, p = PASSO_S * sr, inicios = [];
  for (let i = 0; i <= Math.max(nAmostras - n, 0); i += p) inicios.push(i);
  return inicios;
}
