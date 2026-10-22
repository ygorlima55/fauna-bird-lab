// Fauna Bird Lab · telas Som, Importar e Histórico (passos 3 e 4 do MVP).
// Som: microfone/arquivo → AudioContext 32 kHz → anel de 3 s → a cada PASSO s uma janela vai para o
//      worker (BirdNET+) → acumulador com prior do geomodelo → TOP-5. Ao parar, salva a sessão.
// Importar: arquivos → 32 kHz → todas as janelas → ranking com prior → relatório TOP-1/3/5 → salva.
// Histórico: sessões do IndexedDB com áudio, sonograma, espécies, local e horário.
import { MotorBirdNET, paraPcm32k } from "../core/inferencia.js";
import { Captura, Anel } from "../core/captura.js";
import { Acumulador } from "../core/acumulador.js";
import { Espectrograma } from "../core/espectrograma.js";
import { SR, JANELA_S, PASSO_S, ALFA, semanaBirdnet, reordenar, top } from "../core/ranking.js";
import { juntar, paraWav16, sha256, snrAproximado, uuid } from "../core/audio.js";
import { sonogramaPng } from "../core/sonograma.js";
import { salvarSessao, atualizarSessao, listarSessoes, lerSessao, lerArquivos, apagarSessao, pedirPersistencia, espaco, lerFicha, salvarFicha,
         salvarImpressao, lerImpressao, listarImpressoes } from "../core/banco.js";
import { impressao, indice, procurar, paraBase64 } from "../core/impressao.js";
import { fichaAberta, VERSAO_FICHA } from "../core/fontes.js";
import { embeddingDaEspecie, ordenarPorSemelhanca } from "../core/similaridade.js";
import { NIVEIS, METODOS, DISTANCIAS, RUIDOS, lerListaMerlin, resolverNome, planilhaCsv } from "../core/campo.js";
import { rotuloDoNome, linhaRelatorio, metricasTopK, paraCsv } from "../core/relatorio.js";
import { medirDesempenho } from "../core/desempenho.js";
import { FiguraCanto, desenharMiniatura } from "./figura.js";
import { pacoteDados, nomeArquivos, CONTATO } from "../core/pesquisa.js";

const VERSAO_APP = "0.6.9";
const MODELOS = "../modelos/birdnet-plus-v3/";
const MODELO = { nome: "BirdNET+ V3.0-preview3.1 Global 10K-pruned FP16", geomodelo: "Geomodelo V3.0.4 Global 10K-pruned FP16", licenca: "Apache-2.0" };
const PRIOR_MINIMO = 0.03;   // defaultThreshold do geomodelo: abaixo disso, "fora da área esperada"
const LIMIAR = 0.35;
const MAX_GRAVACAO_S = 20 * 60;   // para sozinho e salva (memória do celular)
const $ = (id) => document.getElementById(id);
const BOM = String.fromCharCode(0xFEFF);   // marca UTF-8 para o Excel abrir os acentos certo

const estado = {
  motor: null, nomes: {}, prior: null, local: null,
  captura: null, anel: null, acum: null, rodando: false, ocupado: false,
  passoS: 1, ultimaPos: 0, msJanela: [], origem: null,
  blocos: [], janelasSessao: [], inicio: null, fonte: null, nomeArquivo: null,
  relatorio: [],
};
window.__app = estado;   // para inspeção nos testes

const espectro = new Espectrograma($("espectro"));
const figura = new FiguraCanto($("figura"), { n: 7000, raio: 0.36 });

// botão redondo da tela Ouvir: o texto fica na chamada acima dele
function botaoGravar(texto, rodando = false) {
  $("chamada").textContent = texto;
  $("btn-gravar").setAttribute("aria-label", rodando ? "Parar e salvar" : texto);
  $("btn-gravar").classList.toggle("parar", rodando);
  $("orbe").classList.toggle("ouvindo", rodando);
}

// ---------- utilidades ----------
function chip(id, classe, texto) {
  const c = $(id);
  c.className = "chip " + classe;
  c.lastChild.textContent = texto;
}
const lerLocal = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const gravarLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const f2 = (x) => (x == null ? "—" : x.toFixed(2));
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nomePt = (especie) => estado.nomes[especie] || estado.motor?.rotulos.find((r) => r.especie === especie)?.nome || especie;
const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function baixar(blob, nome) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function atualizarRede() {
  chip("chip-rede", navigator.onLine ? "ok" : "aviso", navigator.onLine ? "online" : "offline");
}
addEventListener("online", atualizarRede);
addEventListener("offline", atualizarRede);
atualizarRede();

// ---------- abas ----------
const SUBTITULOS = { som: "Identificar por Som", importar: "Importar áudio", historico: "Histórico", especies: "Espécies" };
function abrirAba(nome) {
  document.querySelectorAll(".abas [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aba === nome)));
  document.querySelectorAll(".aba").forEach((a) => { a.hidden = a.id !== "aba-" + nome; });
  $("subtitulo").textContent = SUBTITULOS[nome];
  if (nome === "historico") desenharHistorico();
}
document.querySelectorAll(".abas [role=tab]").forEach((b) => { b.onclick = () => abrirAba(b.dataset.aba); });

// ---------- localização e prior ----------
async function definirLocal(local) {
  estado.local = local;
  if (!local) {
    estado.prior = null;
    chip("chip-local", "aviso", "sem local");
    $("local-texto").textContent = "Sem filtro de local: a lista usa só o som.";
    return;
  }
  gravarLocal("fbl-local", local);
  $("lat").value = local.lat.toFixed(5);
  $("lon").value = local.lon.toFixed(5);
  if (estado.motor) estado.prior = (await estado.motor.prior(local.lat, local.lon, new Date())).alinhado;
  chip("chip-local", "ok", local.fonte === "gps" ? "GPS" : "local");
  const quando = local.quando ? dataHora(local.quando) : "";
  $("local-texto").textContent = `${local.lat.toFixed(4)}, ${local.lon.toFixed(4)} · ${local.fonte}` +
    (local.precisaoM ? ` · ±${Math.round(local.precisaoM)} m` : "") + (quando ? ` · ${quando}` : "");
}

// "quando" é o horário da leitura do GPS (p.timestamp), não o do pedido: uma posição guardada pelo
// aparelho continua com a hora antiga e a idade fica visível na sessão.
function pedirGps({ maximoIdadeMs = 60 * 1000, preciso = false, limiteMs = 8000 } = {}) {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precisaoM: p.coords.accuracy, fonte: "gps", quando: p.timestamp }),
      () => ok(null), { enableHighAccuracy: preciso, timeout: limiteMs, maximumAge: maximoIdadeMs });
  });
}

$("btn-gps").onclick = async () => {
  const p = await pedirGps();
  if (p) await definirLocal(p);
  else $("local-texto").textContent = "GPS indisponível ou negado. Digite a latitude e a longitude ou use sem filtro.";
};
$("btn-manual").onclick = async () => {
  const lat = parseFloat($("lat").value.replace(",", ".")), lon = parseFloat($("lon").value.replace(",", "."));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
    await definirLocal({ lat, lon, fonte: "digitado", quando: Date.now() });
  else $("local-texto").textContent = "Latitude ou longitude inválida.";
};
$("btn-sem-local").onclick = () => definirLocal(null);

// metadados comuns a toda sessão salva
function metadadosBase() {
  return {
    local: estado.local, semana: semanaBirdnet(new Date()),
    idadeGpsS: estado.local?.quando ? Math.round((Date.now() - estado.local.quando) / 1000) : null,   // na hora de salvar
    modelo: MODELO, app: VERSAO_APP,
    ranking: { alfa: estado.prior ? ALFA : 0, limiar: LIMIAR, janelaS: JANELA_S, sr: SR },
    validacao: "UNVERIFIED", sincronizado: false,
  };
}

// ---------- SOM: lista ao vivo ----------
// A lista principal mostra só aves; o modelo também tem insetos, anfíbios e mamíferos (cigarra e grilo entram fácil),
// que ficam numa linha à parte. A sessão salva continua com todas as classes.
const ehAve = (r) => estado.motor.rotulos[r.indice].classe === "Aves";
const aves = (itens) => itens.filter(ehAve);
const CLASSES_PT = { Insecta: "Insetos", Amphibia: "Anfíbios", Mammalia: "Mamíferos" };

function linhaOutros(outros) {
  if (!outros.length) return "";
  const por = {};
  for (const r of outros) (por[estado.motor.rotulos[r.indice].classe] ||= []).push(r);
  return `<li class="outros-grupos"><span class="rot">Também ouvido (não é ave)</span>` +
    Object.entries(por).map(([classe, rs]) => `<span><b>${esc(CLASSES_PT[classe] || classe)}:</b> ` +
      rs.map((r) => `<span data-especie="${esc(estado.motor.rotulos[r.indice].especie)}">${esc(nomePt(estado.motor.rotulos[r.indice].especie))}</span> ${f2(r.melhorFinal)}`).join(", ") +
      `</span>`).join("") + `</li>`;
}

function desenharLista(tempoS) {
  const todos = estado.acum.lista(tempoS), itens = aves(todos), outros = todos.filter((r) => !ehAve(r));
  const ol = $("lista");
  if (estado.rodando) $("palpite").textContent = itens.length
    ? `agora: ${nomePt(estado.motor.rotulos[itens[0].indice].especie)} · ${f2(itens[0].melhorFinal)}` : "";
  if (!itens.length) {
    ol.innerHTML = `<li class="vazio">${estado.rodando ? "Ouvindo… nenhuma ave acima do limiar ainda." : "Nenhuma ave acima do limiar nesta gravação."}</li>` + linhaOutros(outros);
    return;
  }
  ol.innerHTML = itens.map((r) => {
    const rot = estado.motor.rotulos[r.indice];
    const fora = estado.prior && r.prior < PRIOR_MINIMO;
    const detalhe = `som ${f2(r.melhorAcustico)}` + (estado.prior ? ` · local/semana ${f2(r.prior)}` : "") +
      ` · ${r.acima} janela(s)` + (fora ? " · fora da área esperada" : "") + (rot.classe !== "Aves" ? ` · ${rot.classe}` : "");
    return `<li class="${r.ativa && estado.rodando ? "ativa" : ""} ${fora ? "fora" : ""}">
      <span class="nome" data-especie="${esc(rot.especie)}">${esc(nomePt(rot.especie))}</span><span class="escore">${f2(r.melhorFinal)}</span>
      <span class="cient">${esc(rot.especie)}</span>
      <span class="barra"><b style="width:${Math.round(r.melhorFinal * 100)}%"></b></span>
      <span class="detalhe">${detalhe}</span></li>`;
  }).join("") + linhaOutros(outros);
}

function desenharEstado() {
  const tempoS = estado.anel ? estado.anel.total / SR : 0;
  const ms = estado.msJanela.length ? Math.round(estado.msJanela.reduce((a, b) => a + b, 0) / estado.msJanela.length) : null;
  $("estado").textContent = `${estado.origem || "—"} · ${tempoS.toFixed(0)} s · ${estado.acum?.janelas || 0} janelas` +
    (ms ? ` · ${ms} ms/janela · passo ${estado.passoS} s` : "");
}

async function analisarJanela() {
  estado.ocupado = true;
  const pcm = estado.anel.ultimos(JANELA_S * SR);
  estado.ultimaPos = estado.anel.total;
  const tempoS = estado.anel.total / SR;
  const t = performance.now();
  try {
    const r = await estado.motor.analisar(pcm);
    const ms = performance.now() - t;
    if (estado.acum.janelas > 0) {   // a 1ª janela é mais lenta (aquecimento do modelo): fora da conta
      estado.msJanela.push(ms);
      estado.msTodas.push(ms);
      if (estado.msJanela.length > 10) estado.msJanela.shift();
    }
    ajustarPasso();
    estado.acum.adicionar(r.maximo, estado.prior, tempoS);
    const tj = r.topJanelas[0];
    estado.janelasSessao.push({ fimS: +tempoS.toFixed(2), top: tj.indices.map((i, k) => [estado.motor.rotulos[i].especie, +tj.escores[k].toFixed(4)]) });
    desenharLista(tempoS);
    desenharEstado();
  } catch (e) {
    $("estado").textContent = "Erro na análise: " + e.message;
  } finally {
    estado.ocupado = false;
  }
}

// Passo entre janelas: 1 s se o aparelho acompanha; sobe até 3 s (sem sobreposição) se a média das
// últimas 3 janelas passar de 90% do passo, e volta a descer quando sobra folga.
function ajustarPasso() {
  const ult = estado.msJanela.slice(-3);
  if (ult.length < 3) return;
  const media = ult.reduce((a, b) => a + b, 0) / ult.length;
  if (media > estado.passoS * 1000 * 0.9 && estado.passoS < 3) { estado.passoS++; estado.msJanela = []; }
  else if (estado.passoS > 1 && media < (estado.passoS - 1) * 1000 * 0.6) { estado.passoS--; estado.msJanela = []; }
}

// ---------- microfone mudo ----------
// Na 1ª saída de campo, 5 de 14 gravações tiveram até 55 s de zeros exatos: o Android entrega o microfone a um app
// por vez (ex.: Merlin aberto por cima) e passa silêncio digital para o outro. Ruído de verdade nunca é zero exato,
// então ≥ 1 s de zeros seguidos = microfone mudo. Blocos que param de chegar (app congelado) contam à parte.
const MUDO_MIN_S = 1, PARADA_MIN_MS = 2000;

function novoMudo() {
  return { corrida: 0, inicioS: 0, trechos: [], paradas: [], tela: [], ultimoBloco: performance.now(), avisoS: 0 };
}

function fecharTrecho(m) {
  if (m.corrida >= MUDO_MIN_S * SR) m.trechos.push({ inicioS: +m.inicioS.toFixed(1), durS: +(m.corrida / SR).toFixed(1) });
  m.corrida = 0;
}

function medirMudo(bloco) {
  const m = estado.mudo, t0 = (estado.anel.total - bloco.length) / SR, agora = performance.now();
  if (agora - m.ultimoBloco > PARADA_MIN_MS) m.paradas.push({ aposS: +t0.toFixed(1), durS: +((agora - m.ultimoBloco) / 1000).toFixed(1) });
  m.ultimoBloco = agora;
  for (let i = 0; i < bloco.length; i++) {
    if (bloco[i] === 0) { if (m.corrida++ === 0) m.inicioS = t0 + i / SR; }
    else if (m.corrida) fecharTrecho(m);
  }
  avisarMudo(m.corrida / SR);
}

function resumoMudo(m, duracaoS) {
  fecharTrecho(m);
  const totalS = m.trechos.reduce((a, t) => a + t.durS, 0);
  return { totalS: +totalS.toFixed(1), pct: duracaoS ? +(100 * totalS / duracaoS).toFixed(1) : 0,
           maiorS: Math.max(0, ...m.trechos.map((t) => t.durS)), trechos: m.trechos.slice(0, 50),
           paradas: m.paradas.slice(0, 50), tela: m.tela.slice(0, 100) };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function textoMudo(si) {
  const n = si.trechos.length, maior = si.trechos.find((t) => t.durS === si.maiorS);
  return `${Math.round(si.totalS)} s (${String(si.pct).replace(".", ",")}% da gravação) em ${n} trecho${n > 1 ? "s" : ""}` +
    (maior ? `; o maior, de ${Math.round(maior.durS)} s, começou em ${mmss(maior.inicioS)}` : "");
}

// aviso na tela Ouvir; só para o microfone (um arquivo pode ter silêncio digital de verdade)
function avisarMudo(segundos) {
  const el = $("aviso-mudo"), mudo = estado.fonte === "microfone" && segundos >= MUDO_MIN_S;
  if (mudo) $("aviso-mudo-s").textContent = Math.floor(segundos);
  $("bolso-mudo").hidden = !mudo;
  if (el.hidden === !mudo) return;
  el.hidden = !mudo;
  if (mudo) navigator.vibrate?.(200);
}

// ---------- modo bolso ----------
// Na 1ª saída, a tela apagou (botão lateral ou bolso) e o Android silenciou o microfone. Uma página não pode gravar com
// a tela apagada; o modo bolso deixa a tela ligada mas preta (em OLED, pixel preto fica desligado), sem brilho de texto
// e com toques travados. Volta segurando o dedo 2 s. Só existe durante a escuta pelo microfone.
const SEGURAR_MS = 2000;
let bolsoRelogio = null, bolsoSegura = null;

function marcarTela(evento) {
  estado.mudo?.tela.push({ tS: +(estado.anel.total / SR).toFixed(1), quando: new Date().toISOString(), tela: evento });
}

function entrarBolso() {
  if (!estado.rodando || estado.fonte !== "microfone") return;
  $("bolso").hidden = false;
  document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
  marcarTela("bolso");
  let n = 0;
  const tick = () => {
    $("bolso-tempo").textContent = mmss(estado.anel.total / SR);
    if (n++ % 30 === 0) $("bolso-in").style.transform = `translateY(${Math.round(Math.random() * 40 - 20)}vh)`;   // muda de lugar: não marca a tela
  };
  tick();
  bolsoRelogio = setInterval(tick, 1000);
}

function sairBolso() {
  if ($("bolso").hidden) return;
  $("bolso").hidden = true;
  clearInterval(bolsoRelogio);
  soltarBolso();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (estado.rodando) marcarTela("saiu do bolso");
}

function soltarBolso() {
  clearTimeout(bolsoSegura);
  $("bolso").classList.remove("segurando");
}

$("btn-bolso").onclick = entrarBolso;
$("bolso").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  $("bolso").classList.add("segurando");
  bolsoSegura = setTimeout(() => { navigator.vibrate?.(60); sairBolso(); }, SEGURAR_MS);
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) $("bolso").addEventListener(ev, soltarBolso);
$("bolso").addEventListener("contextmenu", (e) => e.preventDefault());

// blocos parados (página congelada): o vigia avisa quando a tela volta
setInterval(() => {
  if (!estado.rodando || !estado.mudo || estado.fonte !== "microfone") return;
  const parado = (performance.now() - estado.mudo.ultimoBloco) / 1000;
  if (parado * 1000 > PARADA_MIN_MS) avisarMudo(parado);
}, 1000);

function aoBloco(bloco) {
  if (!estado.rodando) return;
  estado.anel.push(bloco);
  estado.blocos.push(bloco);
  medirMudo(bloco);
  if (estado.anel.total / SR >= MAX_GRAVACAO_S) { parar(); return; }
  if (estado.ocupado) return;
  if (estado.anel.total >= JANELA_S * SR && estado.anel.total - estado.ultimaPos >= estado.passoS * SR) estado.analiseAtual = analisarJanela();
}

// Tela ligada durante a escuta: com a tela apagada ou o app atrás de outro, o navegador congela a página.
let travaTela = null;
async function manterTelaLigada(ligar) {
  try {
    if (ligar && "wakeLock" in navigator && document.visibilityState === "visible") travaTela = await navigator.wakeLock.request("screen");
    else if (!ligar) { await travaTela?.release(); travaTela = null; }
  } catch { travaTela = null; }
}
document.addEventListener("visibilitychange", () => {
  if (!estado.rodando) return;
  const visivel = document.visibilityState === "visible";
  estado.mudo?.tela.push({ tS: +(estado.anel.total / SR).toFixed(1), quando: new Date().toISOString(), tela: visivel ? "voltou" : "saiu" });
  if (visivel) manterTelaLigada(true);
});

async function iniciar(fonte, bytes, nomeArquivo) {
  Object.assign(estado, { anel: new Anel(JANELA_S + 1), acum: new Acumulador({ limiar: LIMIAR }), ultimaPos: 0, msJanela: [], msTodas: [],
    passoS: 1, blocos: [], janelasSessao: [], inicio: new Date().toISOString(), fonte, nomeArquivo: nomeArquivo || null, mudo: novoMudo() });
  estado.captura = new Captura({ onBloco: aoBloco });
  espectro.limpar();
  $("salvo").hidden = true;
  try {
    const info = fonte === "microfone" ? await estado.captura.microfone() : await estado.captura.arquivo(bytes, () => parar());
    estado.origem = fonte === "microfone" ? `microfone (${info.taxaMicrofone || "?"} Hz → ${info.taxaAnalise} Hz)` : `arquivo ${info.duracaoS.toFixed(0)} s`;
    estado.infoCaptura = info;
    estado.rodando = true;
    manterTelaLigada(true);
    espectro.ligar(estado.captura.analisador);
    figura.ligar(estado.captura.analisador);
    botaoGravar(fonte === "microfone" ? "Ouvindo…" : "Tocando arquivo…", true);
    $("btn-bolso").hidden = fonte !== "microfone";
    $("palpite").textContent = "";
    desenharLista(0);
    desenharEstado();
  } catch (e) {
    await estado.captura.parar();
    $("estado").textContent = fonte === "microfone" ? "Microfone indisponível ou negado: " + e.message : "Não foi possível abrir o arquivo: " + e.message;
  }
}

async function parar() {
  if (!estado.rodando) return;
  estado.rodando = false;
  manterTelaLigada(false);
  espectro.desligar();
  await estado.captura.parar();
  await estado.analiseAtual;   // a última janela entra na sessão salva
  figura.desligar();
  $("aviso-mudo").hidden = true;
  $("btn-bolso").hidden = true;
  sairBolso();
  const melhor = aves(estado.acum.lista(estado.anel.total / SR))[0];
  botaoGravar(melhor ? nomePt(estado.motor.rotulos[melhor.indice].especie) : "Nada acima do limiar");
  $("palpite").textContent = melhor ? `mais provável · final ${f2(melhor.melhorFinal)} · toque para ouvir de novo` : "toque para ouvir de novo";
  desenharLista(estado.anel.total / SR);
  desenharEstado();
  await salvarAoVivo();
}

async function salvarAoVivo() {
  const pcm = juntar(estado.blocos);
  estado.blocos = [];
  if (pcm.length < SR) { $("salvo").hidden = false; $("salvo").textContent = "Gravação com menos de 1 s: não foi salva."; return; }
  $("salvo").hidden = false;
  $("salvo").textContent = "Salvando…";
  try {
    const wav = paraWav16(pcm, SR);
    const tempoS = pcm.length / SR;
    const especies = estado.acum.lista(tempoS, 50).map((r) => {
      const rot = estado.motor.rotulos[r.indice];
      return { especie: rot.especie, nomePt: nomePt(rot.especie), classe: rot.classe, final: +r.melhorFinal.toFixed(4),
               som: +r.melhorAcustico.toFixed(4), prior: estado.prior ? +r.prior.toFixed(4) : null, janelas: r.acima,
               primeiraS: r.primeiraS, ultimaS: r.ultimaS };
    });
    const sessao = {
      id: uuid(), tipo: estado.fonte === "microfone" ? "gravacao" : "arquivo-tocado", inicio: estado.inicio, fim: new Date().toISOString(),
      duracaoS: +tempoS.toFixed(2), origem: estado.origem, arquivoOriginal: estado.nomeArquivo, captura: estado.infoCaptura,
      ...metadadosBase(), especies, janelas: estado.janelasSessao, nJanelas: estado.acum.janelas,
      msPorJanela: estado.msTodas.length ? Math.round(estado.msTodas.reduce((a, b) => a + b, 0) / estado.msTodas.length) : null,
      passoFinalS: estado.passoS, snrDb: snrAproximado(pcm, SR), assinatura: figura.assinatura(), sha256Audio: await sha256(wav), bytesAudio: wav.size,
      silencio: resumoMudo(estado.mudo, tempoS),
    };
    await salvarSessao(sessao, { audio: wav, sonograma: await sonogramaPng(pcm, SR) });
    const repetidas = await registrarImpressao(sessao, pcm);
    $("salvo").innerHTML = `Sessão salva no aparelho (${especies.length} espécie(s), ${tempoS.toFixed(0)} s). <a href="#" id="ver-salvo">Ver no histórico</a>` +
      (sessao.silencio.totalS ? `<br><span class="falha">Microfone mudo em ${textoMudo(sessao.silencio)}.</span>` : "") +
      (repetidas.length ? `<br><span class="falha">Esta gravação é igual a ${repetidas.length} sessão(ões) já salvas (ver no histórico).</span>` : "");
    $("ver-salvo").onclick = (e) => { e.preventDefault(); abrirAba("historico"); abrirDetalhe(sessao.id); };
    estado.ultimaSessao = sessao.id;
    $("lista").dataset.sessao = sessao.id;   // tocar numa espécie da lista abre a ficha já com "comparar"
  } catch (e) {
    $("salvo").textContent = "Erro ao salvar: " + e.message;
  }
}

$("btn-gravar").onclick = async () => {
  if (estado.rodando) return parar();
  if (!estado.local) {   // primeira vez: tenta o GPS; se negar, segue sem filtro de local
    const p = await pedirGps();
    if (p) await definirLocal(p);
  } else if (estado.local.fonte === "gps") {
    // posição nova a cada gravação, sem atrasar o início (local digitado pelo usuário é mantido)
    pedirGps({ maximoIdadeMs: 30 * 1000, preciso: true, limiteMs: 20000 }).then((p) => { if (p) definirLocal(p); });
  }
  iniciar("microfone");
};
$("arquivo").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (estado.rodando) await parar();
  iniciar("arquivo", await f.arrayBuffer(), f.name);
};

// ---------- IMPORTAR ----------
async function importar(arquivos) {
  const linhas = [];
  let nRepetidas = 0;
  const ctx = new AudioContext();
  estado.ocupadoImportando = true;   // a atualização automática espera a importação acabar
  for (const [k, f] of arquivos.entries()) {
    const rotulo = `${k + 1}/${arquivos.length} · ${f.name}`;
    try {
      $("estado-importar").textContent = `${rotulo} · abrindo…`;
      const original = await f.arrayBuffer();
      const shaOriginal = await sha256(original);
      const buffer = await ctx.decodeAudioData(original.slice(0));
      const pcm = await paraPcm32k(buffer);
      const r = await estado.motor.analisar(pcm, (feitas, total) => {
        $("estado-importar").textContent = `${rotulo} · janela ${feitas}/${total}`;
      });
      const acustico = r.maximo, final = estado.prior ? reordenar(acustico, estado.prior) : acustico;
      const real = rotuloDoNome(f.name, estado.motor.rotulos, estado.nomes);
      const linha = linhaRelatorio({ arquivo: f.name, especieReal: real?.especie, acustico, final, rotulos: estado.motor.rotulos,
        duracaoS: +(pcm.length / SR).toFixed(1), snrDb: snrAproximado(pcm, SR), msPorJanela: Math.round(r.msPorJanela),
        janelas: r.janelas, local: estado.local });
      linhas.push(linha);

      const wav = paraWav16(pcm, SR);
      const especies = top(final, estado.motor.rotulos, 10).map((t) => ({
        especie: t.especie, nomePt: nomePt(t.especie), classe: t.classe, final: +t.escore.toFixed(4), som: +acustico[t.indice].toFixed(4),
        prior: estado.prior ? +estado.prior[t.indice].toFixed(4) : null }));
      const sessaoImp = {
        id: uuid(), tipo: "importado", inicio: new Date().toISOString(), fim: new Date().toISOString(),
        duracaoS: linha.duracaoS, origem: `importado (${buffer.sampleRate} Hz, ${buffer.numberOfChannels} canal(is))`,
        arquivoOriginal: f.name, bytesOriginal: f.size, sha256Original: shaOriginal,
        dataArquivo: f.lastModified ? new Date(f.lastModified).toISOString() : null,   // data do arquivo, não da gravação garantida
        ...metadadosBase(), ranking: { alfa: estado.prior ? ALFA : 0, janelaS: JANELA_S, passoS: PASSO_S, sr: SR, agregacao: "máximo entre janelas" },
        especieReal: real?.especie || null, rotuloOrigem: real?.origem || null,
        especies, janelas: r.topJanelas.map((j) => ({ inicioS: j.inicioS, top: j.indices.map((i, q) => [estado.motor.rotulos[i].especie, +j.escores[q].toFixed(4)]) })),
        nJanelas: r.janelas, msPorJanela: linha.msPorJanela, snrDb: linha.snrDb, relatorio: linha,
        sha256Audio: await sha256(wav), bytesAudio: wav.size,
      };
      await salvarSessao(sessaoImp, { audio: wav, sonograma: await sonogramaPng(pcm, SR) });
      const repetidas = await registrarImpressao(sessaoImp, pcm);
      if (repetidas.length) { linha.repetida = repetidas[0].id; nRepetidas++; }
    } catch (e) {
      linhas.push({ arquivo: f.name, erro: e.message });
    }
  }
  await ctx.close();
  estado.ocupadoImportando = false;
  $("estado-importar").textContent = `${arquivos.length} arquivo(s) importado(s) e salvos no histórico.` +
    (nRepetidas ? ` ${nRepetidas} deles são gravações que já estavam no histórico (ver detalhe).` : "");
  estado.relatorio = linhas;
  desenharRelatorio(linhas, "Esta importação");
}

function desenharRelatorio(linhas, titulo) {
  const validas = linhas.filter((l) => !l.erro);
  const m = metricasTopK(validas);
  $("relatorio").hidden = false;
  $("metricas").innerHTML = `<p><b>${esc(titulo)}</b> · ${linhas.length} arquivo(s), ${m.n} com espécie conhecida` +
    (m.semRotulo ? ` · ${m.semRotulo} sem rótulo no nome` : "") + (m.foraDoModelo ? ` · ${m.foraDoModelo} com espécie fora do modelo` : "") + `</p>` +
    (m.n ? `<table class="metricas"><tr><th></th><th>TOP-1</th><th>TOP-3</th><th>TOP-5</th></tr>
      <tr><td>Som + local/semana</td><td>${pct(m.final.top1)}</td><td>${pct(m.final.top3)}</td><td>${pct(m.final.top5)}</td></tr>
      <tr><td>Só som</td><td>${pct(m.soSom.top1)}</td><td>${pct(m.soSom.top3)}</td><td>${pct(m.soSom.top5)}</td></tr></table>` : "") +
    (m.confusoes.length ? `<p class="suave">Erros no TOP-1: ${m.confusoes.map((c) => `<i>${esc(c.real)}</i> → <i>${esc(c.previsto)}</i> (${f2(c.escore)})`).join("; ")}</p>` : "") +
    (m.n && m.n < 30 ? `<p class="suave">Amostra pequena (${m.n}): use como teste de funcionamento, não como desempenho.</p>` : "");
  $("tabela-relatorio").innerHTML = `<tr><th>Arquivo</th><th>Real (provisório)</th><th>TOP-1</th><th>Escore</th><th>Posição real</th><th>Dur.</th><th>SNR</th></tr>` +
    linhas.map((l) => l.erro
      ? `<tr><td>${esc(l.arquivo)}</td><td colspan="6" class="falha">Erro: ${esc(l.erro)}</td></tr>`
      : `<tr><td>${esc(l.arquivo)}</td><td>${l.especieReal ? `<i>${esc(l.especieReal)}</i>` : "—"}</td>
         <td data-especie="${esc(l.top1)}">${esc(nomePt(l.top1))}<br><i class="suave">${esc(l.top1)}</i></td><td class="mono">${f2(l.escoreTop1)}</td>
         <td class="mono">${l.posicaoFinal ?? "—"}${l.posicaoSoSom ? ` <span class="suave">(só som ${l.posicaoSoSom})</span>` : ""}</td>
         <td class="mono">${l.duracaoS} s</td><td class="mono">${l.snrDb ?? "—"} dB</td></tr>`).join("");
  estado.relatorioAtual = { titulo, gerado: new Date().toISOString(), metricas: m, linhas };
}

$("importar").onchange = async (e) => {
  const arquivos = [...e.target.files];
  e.target.value = "";
  if (arquivos.length) await importar(arquivos);
};
$("btn-csv").onclick = () => baixar(new Blob([BOM + paraCsv(estado.relatorioAtual.linhas.filter((l) => !l.erro))], { type: "text/csv" }), `relatorio-fauna-bird-lab-${Date.now()}.csv`);
$("btn-json").onclick = () => baixar(new Blob([JSON.stringify(estado.relatorioAtual, null, 2)], { type: "application/json" }), `relatorio-fauna-bird-lab-${Date.now()}.json`);
$("btn-relatorio-todos").onclick = async () => {
  const linhas = (await listarSessoes()).filter((s) => s.tipo === "importado" && s.relatorio).map((s) => s.relatorio);
  desenharRelatorio(linhas, "Todos os importados salvos");
};

// ---------- HISTÓRICO ----------
async function desenharHistorico() {
  const sessoes = await listarSessoes();
  const e = await espaco();
  $("espaco").textContent = `${sessoes.length} sessão(ões)` +
    (e ? ` · ${(e.usage / 1e6).toFixed(0)} MB usados de ${(e.quota / 1e6).toFixed(0)} MB disponíveis (inclui ~95 MB do modelo)` : "");
  $("historico").innerHTML = sessoes.length ? sessoes.map((s) => {
    const t = s.especies.find((e) => e.classe === "Aves") || s.especies[0];   // título da sessão: a ave mais provável
    return `<li><button class="item${s.assinatura ? " com-figura" : ""}" data-id="${s.id}">
      ${s.assinatura ? `<canvas class="mini" aria-hidden="true"></canvas>` : ""}
      <span class="quando">${dataHora(s.inicio)} · ${s.tipo === "gravacao" ? "gravação" : s.tipo === "importado" ? "importado" : "arquivo tocado"} · ${Math.round(s.duracaoS)} s</span>
      <span class="nome">${t ? esc(t.nomePt) + ` <span class="mono">${f2(t.final)}</span>` : "nenhuma espécie acima do limiar"}</span>
      <span class="suave">${s.arquivoOriginal ? esc(s.arquivoOriginal) + " · " : ""}${s.local ? `${s.local.lat.toFixed(3)}, ${s.local.lon.toFixed(3)}` : "sem local"}${s.especies.length > 1 ? ` · +${s.especies.length - 1} espécie(s)` : ""}${s.silencio?.totalS ? ` · <span class="falha">mudo ${Math.round(s.silencio.pct)}%</span>` : ""}${s.repetidas?.length ? ` · <span class="falha">repetida</span>` : ""}</span>
    </button></li>`;
  }).join("") : `<li class="vazio">Nenhuma sessão salva ainda.</li>`;
  $("historico").querySelectorAll("button.item").forEach((b) => { b.onclick = () => abrirDetalhe(b.dataset.id); });
  for (const s of sessoes) if (s.assinatura) desenharMiniatura($("historico").querySelector(`[data-id="${s.id}"] canvas.mini`), s.assinatura);
}

async function abrirDetalhe(id) {
  const [s, a] = await Promise.all([lerSessao(id), lerArquivos(id)]);
  if (!s) return;
  const d = $("detalhe");
  d.querySelectorAll("audio, img").forEach((el) => URL.revokeObjectURL(el.src));
  const urlAudio = a?.audio ? URL.createObjectURL(a.audio) : "", urlSono = a?.sonograma ? URL.createObjectURL(a.sonograma) : "";
  d.hidden = false;
  d.dataset.sessao = s.id;
  d.innerHTML = `<h2>${dataHora(s.inicio)} · ${Math.round(s.duracaoS)} s</h2>
    ${s.assinatura ? `<div class="figura-sessao"><canvas id="d-figura" aria-label="Figura do canto da sessão"></canvas>
      <p class="mono suave">figura do canto · centro ${String(s.assinatura.centroideKHz).replace(".", ",")} kHz · faixa ${String(s.assinatura.larguraKHz).replace(".", ",")} kHz</p></div>` : ""}
    ${urlSono ? `<img class="sonograma" src="${urlSono}" alt="Sonograma da sessão, 0 a 12 kHz">` : ""}
    ${urlAudio ? `<audio controls src="${urlAudio}"></audio>` : ""}
    ${s.especieReal ? `<p>Rótulo provisório (${esc(s.rotuloOrigem)}): <i>${esc(s.especieReal)}</i> · ${esc(s.validacao)}</p>` : ""}
    <table class="metricas"><tr><th>Espécie</th><th>Final</th><th>Som</th><th>Local</th><th>Janelas</th></tr>
      ${s.especies.slice(0, 10).map((e) => `<tr><td data-especie="${esc(e.especie)}">${esc(e.nomePt)}<br><i class="suave">${esc(e.especie)}</i></td><td class="mono">${f2(e.final)}</td>
        <td class="mono">${f2(e.som)}</td><td class="mono">${f2(e.prior)}</td><td class="mono">${e.janelas ?? "—"}</td></tr>`).join("") ||
        `<tr><td colspan="5">Nenhuma espécie acima do limiar.</td></tr>`}</table>
    ${s.silencio?.totalS ? `<p class="falha">Microfone mudo em ${textoMudo(s.silencio)}. Nesses trechos o app não recebeu som
      (outro app usando o microfone ou o Bird Lab fora da tela)${s.silencio.tela?.some((e) => e.tela === "saiu") ? `; o app saiu da tela ${s.silencio.tela.filter((e) => e.tela === "saiu").length} vez(es)` : ""}.</p>` : ""}
    <p class="suave" id="d-repetidas">Procurando gravações repetidas…</p>
    <p class="suave mono">${esc(s.origem)} · ${s.nJanelas} janelas · ${s.msPorJanela ?? "—"} ms/janela · SNR ${s.snrDb ?? "—"} dB<br>
      local: ${s.local ? `${s.local.lat.toFixed(5)}, ${s.local.lon.toFixed(5)} (${esc(s.local.fonte)}${s.local.precisaoM ? `, ±${Math.round(s.local.precisaoM)} m` : ""})` : "sem local"} · semana ${s.semana}<br>
      id ${s.id}<br>SHA-256 ${s.sha256Audio}<br>${esc(s.modelo.nome)} · app ${esc(s.app)} · ${s.sincronizado ? "sincronizado" : "não sincronizado"}</p>
    ${fichaCampoHtml(s)}
    <div class="controles">
      <button class="btn primario" id="d-pesquisa">Enviar para a pesquisa</button>
      <button class="btn" id="d-wav">Baixar WAV</button>
      <button class="btn" id="d-json">Baixar dados (JSON)</button>
      <button class="btn" id="d-apagar">Apagar</button>
      <button class="btn" id="d-fechar">Fechar</button>
    </div>`;
  const nome = `fauna-bird-lab_${s.inicio.slice(0, 19).replace(/[:T]/g, "-")}_${s.id.slice(0, 8)}`;
  $("d-wav").onclick = () => a?.audio && baixar(a.audio, nome + ".wav");
  $("d-json").onclick = () => baixar(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }), nome + ".json");
  $("d-fechar").onclick = () => { d.hidden = true; };
  $("d-pesquisa").onclick = () => abrirEnvioPesquisa(s, a);
  mostrarRepetidas(s);
  if (s.assinatura) requestAnimationFrame(() => desenharMiniatura($("d-figura"), s.assinatura, { raio: 0.38, n: 6000 }));
  ligarFichaCampo(s);
  $("d-apagar").onclick = async () => {
    if (!confirm("Apagar esta sessão do aparelho? O áudio e os resultados serão perdidos (ainda não há cópia no servidor).")) return;
    await apagarSessao(s.id);
    d.hidden = true;
    desenharHistorico();
  };
  d.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- IMPRESSÃO DIGITAL: gravações repetidas ----------
// Cada sessão ganha uma impressão digital (core/impressao.js). Ela responde "este som já existe?": a mesma
// gravação salva de novo, recortada, convertida ou regravada pelo microfone. Não identifica espécie.
let indiceImp = null;   // índice de todas as impressões; refeito quando entra uma nova

async function indiceDeImpressoes() {
  if (!indiceImp) indiceImp = indice(await listarImpressoes());
  return indiceImp;
}

// calcula, guarda e procura repetidas; grava o resumo na sessão
async function registrarImpressao(sessao, pcm) {
  const imp = { id: sessao.id, ...impressao(pcm, SR) };
  await salvarImpressao(imp);
  indiceImp = null;
  const achadas = procurar(imp, await indiceDeImpressoes(), { ignorar: sessao.id });
  sessao.impressao = { versao: imp.versao, codigos: imp.codigos.length };
  sessao.repetidas = achadas.slice(0, 5);
  await atualizarSessao(sessao);
  return achadas;
}

function textoRepetida(r, outra) {
  const quando = outra ? `${dataHora(outra.inicio)}${outra.arquivoOriginal ? ` (${esc(outra.arquivoOriginal)})` : ""}` : "sessão apagada";
  const d = r.deslocamentoS;
  const onde = Math.abs(d) < 0.5 ? "do começo" : d > 0 ? `esta começa no segundo ${d.toFixed(1)} dela` : `ela começa no segundo ${(-d).toFixed(1)} desta`;
  return `Mesma gravação que a sessão de <button class="link" data-abrir-sessao="${esc(r.id)}">${quando}</button> · ${onde} · ` +
    `${r.codigos} códigos no mesmo ponto (${Math.round(r.destaque)}× acima do acaso)`;
}

async function mostrarRepetidas(s) {
  const caixa = $("d-repetidas");
  if (!caixa) return;
  const imp = await lerImpressao(s.id);
  if (!imp) { caixa.innerHTML = "Impressão digital ainda não calculada. Use “Procurar gravações repetidas” no Histórico."; return; }
  const achadas = procurar(imp, await indiceDeImpressoes(), { ignorar: s.id });
  if (!achadas.length) { caixa.textContent = `Nenhuma gravação repetida (impressão digital: ${imp.codigos.length} códigos).`; return; }
  const outras = await Promise.all(achadas.map((r) => lerSessao(r.id)));
  caixa.innerHTML = `<span class="falha">Gravação repetida.</span><br>` + achadas.map((r, i) => textoRepetida(r, outras[i])).join("<br>");
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-abrir-sessao]");
  if (b) { e.preventDefault(); abrirDetalhe(b.dataset.abrirSessao); }
});

// Histórico: calcula a impressão das sessões que ainda não têm e conta os pares repetidos
$("btn-repetidas").onclick = async () => {
  const st = (t) => { $("estado-repetidas").textContent = t; };
  $("btn-repetidas").disabled = true;
  try {
    const sessoes = await listarSessoes();
    const ja = new Set((await listarImpressoes()).map((i) => i.id));
    const faltam = sessoes.filter((s) => !ja.has(s.id));
    const ctx = new AudioContext();
    for (const [k, s] of faltam.entries()) {
      st(`Calculando impressão digital ${k + 1}/${faltam.length}…`);
      const a = await lerArquivos(s.id);
      if (!a?.audio) continue;
      const pcm = await paraPcm32k(await ctx.decodeAudioData(await a.audio.arrayBuffer()));
      const imp = { id: s.id, ...impressao(pcm, SR) };
      await salvarImpressao(imp);
      s.impressao = { versao: imp.versao, codigos: imp.codigos.length };
      await atualizarSessao(s);
    }
    await ctx.close();
    indiceImp = null;
    const mapa = await indiceDeImpressoes(), pares = new Set();
    for (const imp of await listarImpressoes()) {
      const achadas = procurar(imp, mapa, { ignorar: imp.id });
      for (const r of achadas) pares.add([imp.id, r.id].sort().join("|"));
      const s = sessoes.find((x) => x.id === imp.id);
      if (s && JSON.stringify(s.repetidas || []) !== JSON.stringify(achadas.slice(0, 5))) { s.repetidas = achadas.slice(0, 5); await atualizarSessao(s); }
    }
    st(`${sessoes.length} sessão(ões) verificadas · ${faltam.length} impressão(ões) calculada(s) agora · ${pares.size} par(es) de gravações repetidas.`);
    desenharHistorico();
  } catch (e) {
    st("Erro: " + e.message);
  } finally {
    $("btn-repetidas").disabled = false;
  }
};

// ---------- ENVIO VOLUNTÁRIO PARA A PESQUISA ----------
function abrirEnvioPesquisa(s, arquivos) {
  const caixa = $("envio-pesquisa");
  const enviado = (s.enviosPesquisa || []).length;
  caixa.innerHTML = `<form method="dialog" class="ficha" id="form-pesquisa">
    <h3>Enviar esta sessão para a pesquisa</h3>
    <p>O app monta um pacote com o <b>áudio</b> e os <b>resultados</b> desta sessão (espécies, escores, horário, ficha de campo)
      e abre o compartilhar do celular. <b>Você escolhe para onde mandar</b> (WhatsApp, e-mail, Drive). Nada é enviado sozinho.</p>
    <p class="suave">Destino da pesquisa: ${esc(CONTATO)}. Se o áudio tiver vozes de pessoas, não envie.
      Detalhes no <a href="privacidade.html" target="_blank" rel="noopener">aviso de privacidade</a>.</p>
    ${enviado ? `<p class="suave">Esta sessão já foi compartilhada ${enviado} vez(es).</p>` : ""}
    <label class="marca"><input type="checkbox" name="autorizo" required> Autorizo o uso deste áudio e destes dados para pesquisa
      e para treinar e avaliar modelos de identificação de aves e anfíbios.</label>
    <label class="marca"><input type="checkbox" name="exato"> Enviar a localização exata (sem marcar, vai arredondada para ~1 km;
      não marque para espécies ameaçadas ou ninhos)</label>
    <label>Seu nome para crédito (opcional) <input name="credito" autocomplete="name"></label>
    <label>Contato para dúvidas sobre a gravação (opcional) <input name="contato" autocomplete="email"></label>
    <label>Observação (opcional) <textarea name="observacao" rows="2"></textarea></label>
    <div class="controles"><button class="btn primario" value="ok">Montar e compartilhar</button><button class="btn" value="cancelar" formnovalidate>Cancelar</button></div>
    <p class="suave" id="estado-pesquisa"></p>
  </form>`;
  caixa.showModal();
  const f = $("form-pesquisa");
  f.onsubmit = async (e) => {
    if (e.submitter?.value === "cancelar") return;
    e.preventDefault();
    if (!f.autorizo.checked) return;
    try {
      const imp = await lerImpressao(s.id);
      const dados = pacoteDados(s, { autorizado: true, localExato: f.exato.checked, credito: f.credito.value, contato: f.contato.value,
                                     observacao: f.observacao.value, app: VERSAO_APP,
                                     impressao: imp ? { versao: imp.versao, sr: imp.sr, passo: imp.passo, codigos: imp.codigos.length, dados: paraBase64(imp) } : null });
      const nomes = nomeArquivos(s);
      const arquivosEnvio = [new File([arquivos.audio], nomes.audio, { type: "audio/wav" }),
                             new File([JSON.stringify(dados, null, 2)], nomes.dados, { type: "application/json" })];
      let como = "baixado";
      if (navigator.canShare?.({ files: arquivosEnvio })) {
        try {
          await navigator.share({ files: arquivosEnvio, title: "Fauna Bird Lab · sessão para a pesquisa",
                                  text: `Sessão ${nomes.dados} para a pesquisa (${CONTATO}).` });
          como = "compartilhado";
        } catch (err) {
          if (err.name === "AbortError") { $("estado-pesquisa").textContent = "Compartilhamento cancelado."; return; }
          throw err;
        }
      } else {
        arquivosEnvio.forEach((arq) => baixar(arq, arq.name));
      }
      s.enviosPesquisa = [...(s.enviosPesquisa || []), { quando: dados.consentimento.quando, como, localExato: f.exato.checked, termo: dados.consentimento.termo }];
      await atualizarSessao(s);
      $("estado-pesquisa").textContent = como === "compartilhado" ? "Pronto. Obrigado pela ajuda!" :
        `Este navegador não compartilha arquivos: os 2 arquivos foram baixados. Envie para ${CONTATO}.`;
      setTimeout(() => caixa.close(), 2500);
    } catch (err) {
      $("estado-pesquisa").textContent = "Erro: " + err.message;
    }
  };
}

// ---------- MODO CAMPO: ficha da sessão ----------
const opcoes = (lista, atual) => lista.map((v) => `<option value="${esc(v)}" ${v === (atual || "") ? "selected" : ""}>${esc(v || "—")}</option>`).join("");

function fichaCampoHtml(s) {
  const c = s.campo || {};
  const sugestoes = s.especies.slice(0, 10).map((e) => `<option value="${esc(e.nomePt)}">${esc(e.especie)}</option>`).join("");
  return `<form class="ficha" id="ficha-campo">
    <h3>Ficha de campo</h3>
    <label>Ponto <input name="ponto" value="${esc(c.ponto)}" placeholder="ex.: P03 mata ciliar"></label>
    <label>O que o Merlin mostrou na tela (na ordem, separado por ;)
      <textarea name="merlin" rows="2" placeholder="ex.: bem-te-vi; sabiá-laranjeira">${esc(c.merlin)}</textarea></label>
    <p class="suave" id="ficha-merlin-lido"></p>
    <label>Espécie confirmada por você <input name="confirmada" list="ficha-sugestoes" value="${esc(c.confirmada)}" placeholder="nome popular ou científico"></label>
    <datalist id="ficha-sugestoes">${sugestoes}</datalist>
    <div class="linha">
      <label>Como confirmou <select name="metodo">${opcoes(METODOS, c.metodo)}</select></label>
      <label>Nível <select name="nivel">${opcoes(NIVEIS, s.validacao)}</select></label>
    </div>
    <div class="linha">
      <label>Distância da ave <select name="distancia">${opcoes(DISTANCIAS, c.distancia)}</select></label>
      <label>Ruído / vento <select name="ruido">${opcoes(RUIDOS, c.ruido)}</select></label>
    </div>
    <label>Observações <textarea name="observacoes" rows="2">${esc(c.observacoes)}</textarea></label>
    <p class="suave">GOLD só quando um especialista confirmou. O Merlin é anotado pelo que aparece na tela dele; nada é lido de dentro do app.</p>
    <div class="controles"><button class="btn primario" type="submit">Salvar ficha</button><span class="suave" id="ficha-salva"></span></div>
  </form>`;
}

function ligarFichaCampo(s) {
  const f = $("ficha-campo");
  const mostrarMerlin = () => {
    const lido = lerListaMerlin(f.merlin.value, estado.motor.rotulos, estado.nomes);
    $("ficha-merlin-lido").innerHTML = lido.length
      ? "Merlin entendido como: " + lido.map((m) => m.especie ? `<i>${esc(m.especie)}</i>` : `<span class="falha">${esc(m.texto)} (não reconhecido)</span>`).join(" · ")
      : "";
  };
  f.merlin.oninput = mostrarMerlin;
  mostrarMerlin();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const conf = f.confirmada.value.trim();
    s.campo = { ponto: f.ponto.value.trim(), merlin: f.merlin.value.trim(), confirmada: conf,
                confirmadaCientifico: resolverNome(conf, estado.motor.rotulos, estado.nomes), metodo: f.metodo.value,
                distancia: f.distancia.value, ruido: f.ruido.value, observacoes: f.observacoes.value.trim(), atualizado: new Date().toISOString() };
    s.validacao = f.nivel.value;
    await atualizarSessao(s);
    $("ficha-salva").textContent = "Salva " + new Date().toLocaleTimeString("pt-BR") +
      (conf && s.campo.metodo !== "não confirmada" && !s.campo.confirmadaCientifico ? " · atenção: nome confirmado não reconhecido no modelo" : "");
    desenharHistorico();
  };
}

$("btn-planilha").onclick = async () => {
  const sessoes = (await listarSessoes()).filter((x) => x.tipo !== "teste");
  if (!sessoes.length) return;
  baixar(new Blob([BOM + planilhaCsv([...sessoes].reverse(), estado.motor.rotulos, estado.nomes)], { type: "text/csv" }),
    `campo-merlin-x-birdlab-${new Date().toISOString().slice(0, 10)}.csv`);
};

// ---------- ESPÉCIES: ficha com fontes abertas e comparação por semelhança ----------
const CACHE_REF = "fbl-referencias";            // fotos e sons de referência guardados para uso offline
const IDADE_MAX_FICHA_DIAS = 30;
const MAX_REF_S = 60;                            // compara só o 1º minuto de cada referência
const normal = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").trim();

function buscarEspecies(texto, n = 12) {
  const t = normal(texto);
  if (t.length < 2) return [];
  const achados = [];
  for (const r of estado.motor.rotulos) {
    const pt = estado.nomes[r.especie] || "";
    const alvo = [normal(pt), normal(r.especie), normal(r.nome)];
    const pos = Math.min(...alvo.map((a) => { const i = a.indexOf(t); return i < 0 ? 99 : i; }));
    if (pos === 99) continue;
    // nome exato primeiro, depois o que começa com o texto, depois nomes curtos; aves antes de outros grupos
    const exato = alvo.includes(t) ? -20 : 0;
    achados.push({ r, pt, peso: exato + pos + (normal(pt || r.nome).length / 100) + (r.classe === "Aves" ? 0 : 5) });
  }
  return achados.sort((a, b) => a.peso - b.peso).slice(0, n);
}

$("busca-especie").oninput = () => {
  const lista = buscarEspecies($("busca-especie").value);
  $("resultados-busca").innerHTML = lista.map(({ r, pt }) =>
    `<li><button data-especie="${esc(r.especie)}">${esc(pt || r.nome)} <i>${esc(r.especie)}</i>${r.classe !== "Aves" ? ` <span class="selo">${esc(r.classe)}</span>` : ""}</button></li>`).join("");
};

// qualquer elemento com data-especie abre a ficha; se estiver dentro de uma sessão, a ficha oferece "comparar"
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-especie]");
  if (!el) return;
  abrirEspecie(el.dataset.especie, el.closest("[data-sessao]")?.dataset.sessao || null);
});

// Guarda para uso offline: primeiro os sons do Commons (servem para comparar), depois as fotos.
// Cada arquivo tem tempo limite, para uma fonte lenta ou bloqueada não travar as outras.
const comLimite = (url, opcoes, ms = 20000) => {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opcoes, signal: ctl.signal }).finally(() => clearTimeout(t));
};

const avisarGuardado = (url) => navigator.serviceWorker?.controller?.postMessage({ tipo: "ref-guardada", url });

async function guardarReferencias(ficha) {
  if (!navigator.onLine) return;
  const c = await caches.open(CACHE_REF);
  for (const s of ficha.sons.filter((x) => x.comparavel)) {
    try {
      if (await c.match(s.url)) continue;
      const r = await comLimite(s.url, { mode: "cors", credentials: "omit" }, 60000);
      if (r.ok) { await c.put(s.url, r); avisarGuardado(s.url); }
    } catch (e) { console.warn("som de referência não guardado:", s.url, e.message); }
  }
  for (const f of ficha.fotos) {
    try {
      if (await c.match(f.url)) continue;
      await c.put(f.url, await comLimite(f.url, { mode: "no-cors", credentials: "omit" }));   // opaca: só para exibir
      avisarGuardado(f.url);
    } catch (e) { console.warn("foto não guardada:", f.url, e.message); }
  }
}

async function audioReferencia(url) {
  const c = await caches.open(CACHE_REF);
  let r = await c.match(url);
  if (!r) {
    r = await comLimite(url, { mode: "cors", credentials: "omit" }, 60000);
    if (!r.ok) throw new Error(`áudio de referência indisponível (${r.status})`);
    await c.put(url, r.clone());   // já baixado: fica para uso offline
    avisarGuardado(url);
  }
  return r.arrayBuffer();
}

async function abrirEspecie(especie, sessaoId = null) {
  abrirAba("especies");
  const caixa = $("ficha-especie");
  caixa.hidden = false;
  caixa.dataset.fichaDe = especie;   // não usar data-especie aqui: esse atributo abre fichas ao tocar
  let ficha = await lerFicha(especie);
  desenharFicha(ficha || { especie, fotos: [], sons: [], links: {} }, sessaoId, !ficha);
  caixa.scrollIntoView({ behavior: "smooth", block: "start" });
  const velha = !ficha || (Date.now() - Date.parse(ficha.consultadoEm)) / 864e5 > IDADE_MAX_FICHA_DIAS
    || (ficha.versao || 1) < VERSAO_FICHA;   // formato antigo da ficha
  if (velha && navigator.onLine) {
    try {
      const nova = await fichaAberta(especie, { nomePt: estado.nomes[especie] || null });
      // mantém embeddings já calculados das referências que continuam na ficha
      for (const s of nova.sons) { const v = ficha?.sons.find((x) => x.url === s.url); if (v?.emb) s.emb = v.emb; }
      ficha = nova;
      await salvarFicha(ficha);
      if (caixa.dataset.fichaDe === especie) desenharFicha(ficha, sessaoId, false);
    } catch (e) {
      if (!ficha) caixa.querySelector(".estado-ficha").textContent = "Não foi possível buscar a ficha: " + e.message;
    }
  } else if (!ficha) {
    caixa.querySelector(".estado-ficha").textContent = "Sem internet e sem ficha guardada desta espécie. Abra com sinal uma vez para guardar.";
  }
  if (ficha) guardarReferencias(ficha);   // completa o que faltar no cache offline (só com internet)
}

function desenharFicha(f, sessaoId, carregando) {
  const rot = estado.motor.rotulos.find((r) => r.especie === f.especie) || {};
  const pt = estado.nomes[f.especie] || f.nomePt || rot.nome || "";
  const selo = (l) => `<span class="selo ${l.comercial ? "" : "nc"}" title="${l.comercial ? "permite uso comercial" : "só uso não comercial"}">${esc(l.nome)}</span>`;
  const link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : "");
  $("ficha-especie").innerHTML = `
    <h2>${esc(pt)}</h2>
    <p class="suave"><i>${esc(f.especie)}</i>${rot.classe ? ` · ${esc(rot.classe)}` : ""}${rot.ordem ? ` · ${esc(rot.ordem)}` : ""}${f.inat?.observacoes ? ` · ${f.inat.observacoes.toLocaleString("pt-BR")} observações no iNaturalist` : ""}</p>
    <p class="estado-ficha suave">${carregando ? (navigator.onLine ? "Buscando fotos e sons em fontes abertas…" : "") : f.consultadoEm ? `Fontes consultadas em ${dataHora(f.consultadoEm)}${f.erros?.length ? " · " + esc(f.erros.join("; ")) : ""}` : ""}</p>
    ${f.fotos.length ? `<div class="fotos">${f.fotos.map((x) => `<figure><img src="${esc(x.url)}" alt="${esc(pt)}" loading="lazy" onerror="this.closest('figure').hidden = true"><figcaption>${esc(x.credito)} ${selo(x.licenca)} · ${link(x.pagina, x.fonte)}</figcaption></figure>`).join("")}</div>` : ""}
    ${f.resumo ? `<p>${esc(f.resumo.texto.slice(0, 600))}${f.resumo.texto.length > 600 ? "…" : ""}</p><p class="credito">Texto: ${link(f.resumo.pagina, esc(f.resumo.fonte))} ${selo(f.resumo.licenca)}</p>` : ""}
    ${f.sons.length ? `<h3>Sons de referência</h3>
      ${sessaoId ? `<button class="btn primario" id="btn-comparar">Comparar a sessão com estas gravações</button><p class="suave" id="estado-comparar"></p>` : `<p class="suave">Abra a ficha a partir de uma sessão (Histórico ou lista do Som) para comparar a sua gravação com estas.</p>`}
      <ul class="sons" id="lista-sons">${f.sons.map((s, i) => `<li data-i="${i}">
        <span class="semelhanca"></span><b>${esc(s.fonte)}</b>${s.local ? ` · ${esc(s.local)}` : ""}${s.data ? ` · ${esc(s.data)}` : ""}
        <audio controls preload="none" src="${esc(s.url)}"></audio>
        <div class="credito">${esc(s.credito)} ${selo(s.licenca)} · ${link(s.pagina, "fonte")}${s.comparavel ? "" : " · só para ouvir (a fonte não libera análise)"}</div></li>`).join("")}</ul>` : ""}
    <div class="links-externos">${link(f.links?.wikiaves, "Ver no WikiAves")}${link(f.links?.xenocanto, "Ouvir no xeno-canto")}${link(f.links?.inaturalist, "iNaturalist")}</div>
    <p class="suave">Links externos abrem o site da fonte (precisa de internet). Nada do WikiAves é copiado para o app.</p>`;
  // sons do Commons guardados offline tocam do cache
  caches.open(CACHE_REF).then(async (c) => {
    for (const li of $("ficha-especie").querySelectorAll("#lista-sons li")) {
      const s = f.sons[li.dataset.i], r = s.comparavel && (await c.match(s.url));
      if (r) li.querySelector("audio").src = URL.createObjectURL(await r.blob());
    }
  });
  if (sessaoId && $("btn-comparar")) $("btn-comparar").onclick = () => compararSessao(sessaoId, f);
}

async function compararSessao(sessaoId, ficha) {
  const st = (t) => { $("estado-comparar").textContent = t; };
  const idx = estado.motor.rotulos.findIndex((r) => r.especie === ficha.especie);
  const refs = ficha.sons.filter((s) => s.comparavel);
  if (!refs.length) return st("Nenhuma gravação de referência que permita análise (Commons).");
  $("btn-comparar").disabled = true;
  try {
    const ctx = new AudioContext();
    const pcmDe = async (bytes, maxS) => { const p = await paraPcm32k(await ctx.decodeAudioData(bytes)); return maxS ? p.subarray(0, maxS * SR) : p; };
    st("Analisando a sua gravação…");
    const arq = await lerArquivos(sessaoId);
    const minha = await estado.motor.analisar(await pcmDe(await arq.audio.arrayBuffer()), null, { embeddings: true, alvo: idx });
    const vMinha = embeddingDaEspecie(minha.embeddings, minha.escoresAlvo);
    if (!vMinha) { st(`A espécie não aparece na sua gravação (escore < 0,10 em todas as janelas): não há o que comparar.`); return; }
    for (const [k, s] of refs.entries()) {
      if (s.emb) continue;
      st(`Analisando referência ${k + 1}/${refs.length}…`);
      try {
        const r = await estado.motor.analisar(await pcmDe(await audioReferencia(s.url), MAX_REF_S), null, { embeddings: true, alvo: idx });
        const v = embeddingDaEspecie(r.embeddings, r.escoresAlvo);
        s.emb = v ? Array.from(v) : null;
        s.semEspecie = !v;
      } catch (e) { s.erro = e.message; }
    }
    await salvarFicha(ficha);
    const ordem = ordenarPorSemelhanca(vMinha, refs.map((s) => ({ ...s, emb: s.emb ? Float32Array.from(s.emb) : null })));
    for (const o of ordem) {
      const i = ficha.sons.findIndex((x) => x.url === o.url);
      const alvo = $("ficha-especie").querySelector(`#lista-sons li[data-i="${i}"] .semelhanca`);
      if (alvo) alvo.textContent = o.semelhanca != null ? o.semelhanca.toFixed(2) : o.semEspecie ? "sem a espécie" : "erro";
    }
    const melhor = ordem[0];
    st(melhor?.semelhanca != null
      ? `Mais parecida: ${melhor.titulo || melhor.fonte} (semelhança ${melhor.semelhanca.toFixed(2)}; 1 = igual). Semelhança ajuda a conferir, não confirma a espécie.`
      : "Nenhuma referência pôde ser comparada.");
    await ctx.close();
  } catch (e) {
    st("Erro na comparação: " + e.message);
  } finally {
    $("btn-comparar").disabled = false;
  }
}

// ---------- DESEMPENHO ----------
$("btn-medir").onclick = async () => {
  if (estado.rodando) return ($("estado-medir").textContent = "Pare a gravação antes de medir.");
  $("btn-medir").disabled = true;
  try {
    const r = await medirDesempenho(estado.motor, { aoProgresso: (t) => { $("estado-medir").textContent = t; } });
    r.app = VERSAO_APP;
    estado.medicao = r;
    console.log("FBL_DESEMPENHO " + JSON.stringify(r));   // para ler pelo chrome://inspect no PC
    const anteriores = lerLocal("fbl-medicoes") || [];
    gravarLocal("fbl-medicoes", [r, ...anteriores].slice(0, 10));
    const linhas = [
      ["Carregar modelo", `${r.aparelho.msCarregarModelo} ms`],
      ["Threads / núcleos", `${r.aparelho.threadsModelo} / ${r.aparelho.nucleos ?? "?"} (isolamento de origem: ${r.aparelho.isolamentoOrigem ? "sim" : "não"})`],
      ["Ao vivo: ms por janela", `média ${r.aoVivo.ms.media} · mediana ${r.aoVivo.ms.mediana} · p95 ${r.aoVivo.ms.p95} (1ª: ${r.aoVivo.aquecimentoMs})`],
      ["Ao vivo: passo recomendado", `${r.aoVivo.passoRecomendadoS} s (fator tempo real ${r.aoVivo.fatorTempoReal})`],
      ["Importar 60 s", `${(r.importacao.msTotal / 1000).toFixed(1)} s (${r.importacao.msPorJanela} ms/janela, ${r.importacao.vezesMaisRapidoQueTempoReal}× tempo real)`],
      ["Memória", r.memoriaDepois.totalMB ? `${r.memoriaDepois.totalMB} MB (página + worker)` : r.memoriaDepois.heapJsPaginaMB ? `${r.memoriaDepois.heapJsPaginaMB} MB (só a página)` : "não disponível neste navegador"],
      ["Memória do aparelho", r.aparelho.memoriaGB ? `≥ ${r.aparelho.memoriaGB} GB` : "?"],
      ["Armazenamento", r.armazenamento ? `${r.armazenamento.usadoMB} MB de ${r.armazenamento.cotaMB} MB · persistente: ${r.armazenamento.persistente ? "sim" : "não"}` : "?"],
    ];
    $("tabela-medir").innerHTML = linhas.map(([k, v]) => `<tr><th>${k}</th><td class="mono">${esc(v)}</td></tr>`).join("");
    $("estado-medir").textContent = `Medido em ${dataHora(r.quando)} · ${r.aparelho.userAgent.slice(0, 80)}`;
    $("btn-medir-copiar").hidden = $("btn-medir-baixar").hidden = false;
  } catch (e) {
    $("estado-medir").textContent = "Erro: " + e.message;
  } finally {
    $("btn-medir").disabled = false;
  }
};
$("btn-medir-copiar").onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(estado.medicao, null, 2)); $("estado-medir").textContent = "Resultado copiado: cole na conversa com o Claude."; }
  catch { $("estado-medir").textContent = "Não foi possível copiar; use Baixar JSON."; }
};
$("btn-medir-baixar").onclick = () => baixar(new Blob([JSON.stringify(estado.medicao, null, 2)], { type: "application/json" }), `desempenho-fauna-bird-lab-${Date.now()}.json`);

// ---------- instalar na tela inicial ----------
// O Chrome avisa (beforeinstallprompt) quando o app pode ser instalado; o botão abre o pedido dele.
let pedidoInstalar = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); pedidoInstalar = e; $("btn-instalar").hidden = false; });
addEventListener("appinstalled", () => { pedidoInstalar = null; $("btn-instalar").hidden = true; });
$("btn-instalar").onclick = async () => {
  if (!pedidoInstalar) return;
  pedidoInstalar.prompt();
  const { outcome } = await pedidoInstalar.userChoice;
  estado.instalacao = outcome;   // "accepted" ou "dismissed"
  if (outcome === "accepted") $("btn-instalar").hidden = true;
  pedidoInstalar = null;
};

// ---------- início ----------
async function iniciarApp() {
  $("versao-app").textContent = VERSAO_APP;
  chip("chip-modelo", "aviso", "carregando");
  try {
    estado.motor = new MotorBirdNET(MODELOS);
    const [info, nomes] = await Promise.all([
      estado.motor.carregar(),
      fetch(MODELOS + "nomes-pt.json").then((r) => r.json()).catch(() => ({})),
    ]);
    estado.nomes = nomes;
    chip("chip-modelo", "ok", `modelo · ${info.threads} thread${info.threads > 1 ? "s" : ""}`);
    $("btn-gravar").disabled = false;
    botaoGravar("Toque para identificar");
  } catch (e) {
    chip("chip-modelo", "erro", "sem modelo");
    botaoGravar("Modelo não carregou");
    $("estado").textContent = e.message;
    return;
  }
  await definirLocal(lerLocal("fbl-local"));
  pedirPersistencia();
}

// Sem isolamento de origem o modelo roda com 1 thread. Se o servidor não manda COOP/COEP, o service
// worker acrescenta; basta recarregar uma vez depois que ele assumir a página.
async function garantirIsolamento() {
  if (!("serviceWorker" in navigator)) return false;
  // sem service worker (bloqueado, aba anônima, erro de rede) o app abre assim mesmo: sem offline e com 1 thread
  const reg = await navigator.serviceWorker.register("../sw.js", { scope: "../" }).catch((e) => { console.warn("service worker:", e); return null; });
  if (!reg || self.crossOriginIsolated) return false;
  // até 2 recarregamentos por sessão: no 1º acesso a página pode recarregar antes de o service worker assumir
  // (fica sem isolamento); o 2º só acontece quando ele já controla a página, e aí o isolamento pega
  let tentativas = 0;
  try { tentativas = Number(sessionStorage.getItem("fbl-recarregou")) || 0; } catch {}
  if (tentativas >= 2 || (tentativas === 1 && !navigator.serviceWorker.controller)) return false;
  try { sessionStorage.setItem("fbl-recarregou", String(tentativas + 1)); } catch {}
  $("estado").textContent = "Preparando uso offline (1ª vez baixa ~95 MB)…";
  // espera a instalação terminar (ou falhar: "redundant") em vez de navigator.serviceWorker.ready, que nunca volta se falhar
  await new Promise((ok) => {
    const w = reg.installing || reg.waiting;
    if (reg.active || !w) return ok();
    w.addEventListener("statechange", () => { if (w.state === "activated" || w.state === "redundant") ok(); });
  });
  if (!reg.active) { $("estado").textContent = "Não deu para preparar o uso offline; o app funciona com internet."; return false; }
  if (!navigator.serviceWorker.controller)
    await new Promise((ok) => { navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }); setTimeout(ok, 3000); });
  location.reload();
  return true;
}
garantirIsolamento().then((recarregando) => { if (!recarregando) iniciarApp(); });

// ---------- atualização automática ----------
// Quem abre pelo link público recebe a versão nova sem cabo: o app pergunta ao servidor se o sw.js mudou ao abrir,
// ao voltar para a tela e a cada 30 min. O service worker novo baixa só o que mudou (o modelo fica) e assume;
// aí a página recarrega sozinha, a não ser que esteja gravando ou importando, quando só mostra a faixa.
const VERIFICAR_MIN = 30;
const tinhaControlador = !!navigator.serviceWorker?.controller;   // 1ª instalação já recarrega em garantirIsolamento
let atualizacaoPendente = false;

async function procurarVersaoNova() {
  if (!navigator.onLine) return;
  try { await (await navigator.serviceWorker?.getRegistration("../"))?.update(); } catch {}
}

function aplicarVersaoNova() {
  if (estado.rodando || estado.ocupadoImportando) { $("faixa-versao").hidden = false; return; }
  location.reload();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!tinhaControlador || atualizacaoPendente) return;
    atualizacaoPendente = true;
    aplicarVersaoNova();
  });
  addEventListener("load", () => setTimeout(procurarVersaoNova, 5000));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") procurarVersaoNova(); });
  setInterval(procurarVersaoNova, VERIFICAR_MIN * 60 * 1000);
  $("btn-atualizar").onclick = () => location.reload();
}
