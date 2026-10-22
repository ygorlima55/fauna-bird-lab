// Diagnóstico do aparelho (CASE_IOS_001 e DEVICE LAB). Repete, etapa por etapa e com tempo limite, o que o app faz
// ao abrir, para achar onde um aparelho trava (ex.: iPhone parado em "Carregando modelo…"). Não envia nada:
// o resultado é um texto para copiar. Parte 1 roda sozinha (leve); parte 2 baixa e carrega o modelo.
const $ = (id) => document.getElementById(id);
const BASE = new URL("../modelos/birdnet-plus-v3/", location.href).href;
const ORT = new URL("../vendor/onnxruntime-web-1.30.0/", location.href).href;
const ARQUIVOS = [
  ["modelo de som", "BirdNET+_V3.0-preview3.1_Global_10K-pruned_FP16.onnx"],
  ["geomodelo", "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_FP16.onnx"],
  ["rótulos do som", "BirdNET+_V3.0-preview3.1_Global_10K-pruned_Labels.csv"],
  ["rótulos do geomodelo", "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_Labels.txt"],
  ["nomes em português", "nomes-pt.json"],
];
const linhas = [], erros = [];
const MB = (b) => (b / 1e6).toFixed(1) + " MB";

addEventListener("error", (e) => erros.push(`erro: ${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
addEventListener("unhandledrejection", (e) => erros.push(`promessa rejeitada: ${e.reason?.message || e.reason}`));

function comLimite(promessa, ms, oque) {
  let t;
  return Promise.race([promessa, new Promise((_, nao) => { t = setTimeout(() => nao(new Error(`${oque}: sem resposta em ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(t));
}
const quadro = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // deixa a tela mostrar a etapa

async function etapa(nome, fn, { limiteMs = 30000 } = {}) {
  const li = document.createElement("li");
  li.className = "rodando";
  li.innerHTML = `<span class="st">…</span><span>${nome}</span><span class="ms"></span><span class="det"></span>`;
  $("passos").append(li);
  $("estado").textContent = `Testando: ${nome}…`;
  await quadro();
  const t = performance.now();
  let st = "ok", det = "";
  try {
    const r = await comLimite(Promise.resolve().then(fn), limiteMs, nome);
    if (r && typeof r === "object" && "aviso" in r) { st = "aviso"; det = r.aviso; } else det = r ?? "";
  } catch (e) { st = "falhou"; det = String(e?.message || e); }
  const ms = Math.round(performance.now() - t);
  li.className = st;
  li.querySelector(".st").textContent = st === "ok" ? "✓" : st === "aviso" ? "!" : "✗";
  li.querySelector(".ms").textContent = `${ms} ms`;
  li.querySelector(".det").textContent = det;
  linhas.push(`${st.toUpperCase().padEnd(6)} ${nome} · ${ms} ms${det ? " · " + det : ""}`);
  atualizarRelatorio();
  return st;
}

function aparelho() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  const android = ua.match(/Android ([\d.]+)/);
  const chrome = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/), safari = ua.match(/Version\/([\d.]+).*Safari/);
  return {
    sistema: ios ? `iOS ${ios[1]}.${ios[2]}${ios[3] ? "." + ios[3] : ""}` : android ? `Android ${android[1]}` : navigator.platform,
    navegador: ios && !ua.includes("CriOS") ? `Safari ${safari?.[1] || "?"}` : chrome ? `Chrome ${chrome[1]}` : "outro",
    ios: !!ios || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    instalado: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    nucleos: navigator.hardwareConcurrency || null, memoriaGB: navigator.deviceMemory || null,
    tela: `${screen.width}×${screen.height} @${devicePixelRatio}`, ua,
  };
}

function cabecalho(a, versao) {
  return [`Fauna Bird Lab · diagnóstico · ${new Date().toLocaleString("pt-BR")}`,
    `App ${versao} · ${a.sistema} · ${a.navegador} · ${a.instalado ? "instalado" : "aba do navegador"}`,
    `Núcleos ${a.nucleos ?? "?"} · memória ${a.memoriaGB ? "≥ " + a.memoriaGB + " GB" : "não informada"} · tela ${a.tela}`,
    `UA: ${a.ua}`, ""];
}
let topo = [];
function atualizarRelatorio() {
  const txt = [...topo, ...linhas, ...(erros.length ? ["", "Erros da página:", ...erros] : [])].join("\n");
  $("relatorio").value = txt;
  try { localStorage.setItem("fbl-diagnostico", txt); } catch {}
}

const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const memoriaJs = () => performance.memory ? ` · memória JS ${MB(performance.memory.usedJSHeapSize)} de ${MB(performance.memory.jsHeapSizeLimit)}` : "";

async function parte1() {
  let versao = "?";
  try { versao = (await (await fetch("../sw.js")).text()).match(/VERSAO = "([^"]+)"/)?.[1] || "?"; } catch {}
  $("versao").textContent = versao;
  const a = aparelho();
  topo = cabecalho(a, versao);
  atualizarRelatorio();

  await etapa("WebAssembly", () => { if (typeof WebAssembly !== "object") throw new Error("não disponível"); return "disponível"; });
  await etapa("WebAssembly SIMD (o motor usa)", () => {
    if (!WebAssembly.validate(SIMD)) throw new Error("não suportado: o ONNX Runtime deste app precisa de SIMD");
    return "suportado";
  });
  await etapa("Várias threads (isolamento de origem)", () => {
    const sab = typeof SharedArrayBuffer === "function", iso = self.crossOriginIsolated === true;
    if (sab && iso) return `sim · ${Math.min(navigator.hardwareConcurrency || 2, 4)} threads`;
    return { aviso: `não (SharedArrayBuffer ${sab ? "sim" : "não"}, isolamento ${iso ? "sim" : "não"}): o modelo roda com 1 thread, mais lento` };
  });
  await etapa("Web Worker de módulo", async () => {
    const url = URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    await new Promise((ok, erro) => { w.onmessage = ok; w.onerror = (e) => erro(new Error(e.message || "falhou")); });
    w.terminate(); URL.revokeObjectURL(url);
    return "funciona";
  }, { limiteMs: 10000 });
  await etapa("Service worker (uso offline)", async () => {
    if (!("serviceWorker" in navigator)) throw new Error("não disponível neste navegador");
    const reg = await navigator.serviceWorker.getRegistration("../");
    if (!reg) return { aviso: "não registrado: abra o app uma vez com internet" };
    const c = navigator.serviceWorker.controller ? "controlando a página" : "registrado, mas não controla esta página";
    return `${c} · ativo: ${reg.active?.state || "nenhum"}${reg.waiting ? " · há versão esperando" : ""}`;
  }, { limiteMs: 10000 });
  await etapa("Armazenamento", async () => {
    const e = await navigator.storage?.estimate?.();
    const p = await navigator.storage?.persisted?.();
    const txt = e ? `${MB(e.usage)} usados de ${MB(e.quota)}` : "estimativa indisponível";
    if (e && e.quota < 300e6) return { aviso: `${txt}: cota pequena para o modelo (~80 MB) + gravações` };
    return `${txt} · persistente: ${p === undefined ? "?" : p ? "sim" : "não (o sistema pode apagar se faltar espaço)"}`;
  }, { limiteMs: 10000 });
  await etapa("IndexedDB (gravações e histórico)", async () => {
    const nome = "fbl-diagnostico-teste";
    const db = await new Promise((ok, erro) => {
      const r = indexedDB.open(nome, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("t");
      r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); r.onblocked = () => erro(new Error("bloqueado"));
    });
    await new Promise((ok, erro) => { const tx = db.transaction("t", "readwrite"); tx.objectStore("t").put(new Blob([new Uint8Array(1e6)]), "x"); tx.oncomplete = ok; tx.onerror = () => erro(tx.error); });
    db.close(); indexedDB.deleteDatabase(nome);
    return "grava e lê (teste com 1 MB)";
  }, { limiteMs: 15000 });
  await etapa("Arquivos do modelo já guardados", async () => {
    if (!("caches" in self)) throw new Error("Cache Storage indisponível");
    const nomes = await caches.keys(), faltam = [];
    let total = 0;
    for (const [rot, arq] of ARQUIVOS) {
      const r = await caches.match(BASE + arq);
      if (r) total += +(r.headers.get("content-length") || 0); else faltam.push(rot);   // sem ler o arquivo: 67 MB na memória pode derrubar o iPhone
    }
    const t = `caches: ${nomes.join(", ") || "nenhum"} · guardado ${MB(total)}`;
    return faltam.length ? { aviso: `${t} · faltam: ${faltam.join(", ")}` } : t;
  }, { limiteMs: 60000 });
  await etapa("Microfone e áudio", () => {
    const tem = [!!navigator.mediaDevices?.getUserMedia && "microfone", !!window.AudioWorkletNode && "AudioWorklet",
      !!window.OfflineAudioContext && "reamostragem", "wakeLock" in navigator && "tela ligada"].filter(Boolean);
    const falta = ["microfone", "AudioWorklet", "reamostragem", "tela ligada"].filter((x) => !tem.includes(x));
    return falta.length ? { aviso: `tem: ${tem.join(", ")} · falta: ${falta.join(", ")}` } : tem.join(", ");
  });
  $("estado").textContent = "Parte 1 pronta. Toque em \"Testar o modelo\" para a parte 2.";
}

async function parte2() {
  $("btn-completo").disabled = true;
  for (const [rot, arq] of ARQUIVOS.slice(0, 2)) {
    await etapa(`Baixar ou ler ${rot}`, async () => {
      const t = performance.now();
      const r = await fetch(BASE + arq);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.arrayBuffer();
      const s = (performance.now() - t) / 1000;
      return `${MB(b.byteLength)} em ${s.toFixed(1)} s${memoriaJs()}`;
    }, { limiteMs: 300000 });
  }
  let ort = null;
  await etapa("Abrir o ONNX Runtime Web", async () => {
    ort = await import(ORT + "ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = 1;   // aqui sempre 1 thread: separa "não carrega" de "threads não funcionam"
    return `versão ${ort.env.versions?.web || "?"} · 1 thread`;
  }, { limiteMs: 60000 });
  if (ort) {
    let geo = null, som = null;
    await etapa("Criar o geomodelo (14 MB, 1 thread)", async () => {
      geo = await ort.InferenceSession.create(BASE + ARQUIVOS[1][1], { executionProviders: ["wasm"] });
      return `pronto${memoriaJs()}`;
    }, { limiteMs: 120000 });
    await etapa("Criar o modelo de som (67 MB, 1 thread)", async () => {
      som = await ort.InferenceSession.create(BASE + ARQUIVOS[0][1], { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      return `pronto${memoriaJs()}`;
    }, { limiteMs: 240000 });
    if (som) await etapa("Analisar 3 s de silêncio (1 thread)", async () => {
      const t = performance.now();
      const s = await som.run({ input: new ort.Tensor("float32", new Float32Array(96000), [1, 96000]) });
      return `${Math.round(performance.now() - t)} ms por janela · ${s.predictions.dims.join("×")} saídas`;
    }, { limiteMs: 120000 });
    await som?.release?.(); await geo?.release?.();
  }
  await etapa("Motor do app (Web Worker, mesmas threads do app)", async () => {
    const { MotorBirdNET } = await import("../core/inferencia.js");
    const m = new MotorBirdNET(BASE);
    try {
      const info = await m.carregar();
      const t = performance.now();
      await m.analisar(new Float32Array(96000));
      return `carregou em ${info.msCarregar} ms com ${info.threads} thread(s) · 1 janela em ${Math.round(performance.now() - t)} ms`;
    } finally { m.encerrar(); }
  }, { limiteMs: 300000 });
  const falhas = linhas.filter((l) => l.startsWith("FALHOU"));
  $("estado").textContent = falhas.length ? `Terminou com ${falhas.length} falha(s). Copie o resultado e mande.` : "Terminou sem falhas. Copie o resultado e mande.";
  $("btn-completo").disabled = false;
}

$("btn-completo").onclick = () => parte2();
$("btn-copiar").onclick = async () => {
  atualizarRelatorio();
  try { await navigator.clipboard.writeText($("relatorio").value); $("estado").textContent = "Resultado copiado."; }
  catch { $("relatorio").select(); $("estado").textContent = "Não deu para copiar sozinho: o texto ficou selecionado; use Copiar do teclado."; }
};
parte1();
