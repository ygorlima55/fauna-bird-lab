// Modo campo: ficha preenchida pelo observador em cada sessão (o que o Merlin mostrou na tela,
// espécie confirmada, distância, ruído) e a linha da planilha de comparação Merlin × Fauna Bird Lab.
// Funções puras (testadas em testes/passo6.html).

// sem acento, minúsculo, e hífen/sublinhado = espaço ("joao de barro" = "joão-de-barro")
const normalizar = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

// Nome digitado (português do Merlin, científico ou inglês) → nome científico do modelo, ou null.
export function resolverNome(texto, rotulos, nomesPt = {}) {
  const t = normalizar(texto);
  if (!t) return null;
  for (const r of rotulos) if (normalizar(r.especie) === t) return r.especie;
  for (const [cient, pt] of Object.entries(nomesPt)) if (normalizar(pt) === t) return cient;
  for (const r of rotulos) if (normalizar(r.nome) === t) return r.especie;
  return null;
}

// "bem-te-vi; sabiá-laranjeira, Furnarius rufus" → [{texto, especie|null}, ...] na ordem digitada
export function lerListaMerlin(texto, rotulos, nomesPt) {
  return String(texto || "").split(/[;,\n]+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => ({ texto: x, especie: resolverNome(x, rotulos, nomesPt) }));
}

export const NIVEIS = ["UNVERIFIED", "SILVER", "GOLD"];   // GOLD só com especialista (Parte 13)
export const METODOS = ["", "vi a ave", "ouvi e tenho certeza", "conferi a gravação depois", "não confirmada"];
export const DISTANCIAS = ["", "< 10 m", "10–30 m", "30–100 m", "> 100 m", "não sei"];
export const RUIDOS = ["", "baixo", "médio", "alto"];

export const COLUNAS = [
  "id_sessao", "data", "hora_inicio", "duracao_s", "ponto", "lat", "lon", "precisao_gps_m", "tipo", "app",
  "nosso_top1", "nosso_top1_nome", "nosso_escore1", "nosso_top2", "nosso_escore2", "nosso_top3", "nosso_escore3",
  "nosso_top4", "nosso_top5", "n_especies_lista",
  "merlin_lista", "merlin_top1", "merlin_nomes_nao_reconhecidos",
  "especie_confirmada", "metodo_confirmacao", "nivel", "distancia", "ruido", "snr_db",
  "pos_confirmada_nosso", "nosso_top1_certo", "nosso_top3_certo", "merlin_top1_certo", "merlin_contem_confirmada", "acordo_top1",
  "observacoes",
];

const sn = (v) => (v == null ? "" : v ? 1 : 0);

export function linhaPlanilha(s, rotulos, nomesPt = {}) {
  const c = s.campo || {};
  const lista = s.especies || [];
  const merlin = lerListaMerlin(c.merlin, rotulos, nomesPt);
  const confirmada = c.confirmada ? resolverNome(c.confirmada, rotulos, nomesPt) || c.confirmada : "";
  const temConfirmada = Boolean(confirmada) && c.metodo !== "não confirmada";
  const posNosso = temConfirmada ? lista.findIndex((e) => e.especie === confirmada) + 1 || null : null;
  const merlinTop1 = merlin[0]?.especie || merlin[0]?.texto || "";
  const d = new Date(s.inicio);
  const p2 = (n) => String(n).padStart(2, "0");
  return {
    id_sessao: s.id, data: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, hora_inicio: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
    duracao_s: Math.round(s.duracaoS), ponto: c.ponto || "",
    lat: s.local ? +s.local.lat.toFixed(5) : "", lon: s.local ? +s.local.lon.toFixed(5) : "",
    precisao_gps_m: s.local?.precisaoM ? Math.round(s.local.precisaoM) : "", tipo: s.tipo, app: s.app,
    nosso_top1: lista[0]?.especie || "", nosso_top1_nome: lista[0]?.nomePt || "", nosso_escore1: lista[0]?.final ?? "",
    nosso_top2: lista[1]?.especie || "", nosso_escore2: lista[1]?.final ?? "",
    nosso_top3: lista[2]?.especie || "", nosso_escore3: lista[2]?.final ?? "",
    nosso_top4: lista[3]?.especie || "", nosso_top5: lista[4]?.especie || "", n_especies_lista: lista.length,
    merlin_lista: merlin.map((m) => m.especie || m.texto).join("; "), merlin_top1: merlinTop1,
    merlin_nomes_nao_reconhecidos: merlin.filter((m) => !m.especie).map((m) => m.texto).join("; "),
    especie_confirmada: temConfirmada ? confirmada : "", metodo_confirmacao: c.metodo || "", nivel: s.validacao || "UNVERIFIED",
    distancia: c.distancia || "", ruido: c.ruido || "", snr_db: s.snrDb ?? "",
    pos_confirmada_nosso: posNosso ?? "",
    nosso_top1_certo: temConfirmada ? sn(lista[0]?.especie === confirmada) : "",
    nosso_top3_certo: temConfirmada ? sn(posNosso != null && posNosso <= 3) : "",
    merlin_top1_certo: temConfirmada && merlin.length ? sn(merlinTop1 === confirmada) : "",
    merlin_contem_confirmada: temConfirmada && merlin.length ? sn(merlin.some((m) => (m.especie || m.texto) === confirmada)) : "",
    acordo_top1: merlin.length && lista.length ? sn(lista[0].especie === merlinTop1) : "",
    observacoes: c.observacoes || "",
  };
}

// CSV para o Excel em português: separador ";" e vírgula decimal.
export function planilhaCsv(sessoes, rotulos, nomesPt) {
  const cel = (v) => (typeof v === "number" ? String(v).replace(".", ",") : `"${String(v ?? "").replace(/"/g, '""')}"`);
  return [COLUNAS.join(";"), ...sessoes.map((s) => { const l = linhaPlanilha(s, rotulos, nomesPt); return COLUNAS.map((k) => cel(l[k])).join(";"); })].join("\n");
}
