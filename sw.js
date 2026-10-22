// Service worker do Fauna Bird Lab · mude VERSAO a cada publicação para atualizar os aparelhos.
// Fica na raiz do projeto para controlar a tela (app/), o motor (core/, inclusive o worker),
// o ONNX Runtime (vendor/) e os modelos (modelos/). Os testes (testes/) ficam fora do cache.
const VERSAO = "0.8.1";
const CACHE_APP = "fbl-app-" + VERSAO;
const CACHE_MODELOS = "fbl-modelos-birdnet-plus-v3.0-preview3.1";   // ~95 MB: só muda com modelo novo
const CACHE_REF = "fbl-referencias";                                 // fotos e sons da ficha de espécie (app.js)

// Procura só nos caches desta versão. caches.match() olharia também um cache de versão anterior ainda não
// apagado (o mais antigo primeiro) e entregaria app.js velho.
async function doCache(req, nomes, opcoes) {
  for (const n of nomes) { const r = await (await caches.open(n)).match(req, opcoes); if (r) return r; }
  return null;
}

// Endereços de outros sites já guardados (fotos e sons da ficha). Só esses são interceptados: um pedido externo
// pendurado dentro do service worker impediria a versão nova de assumir. O app avisa por mensagem o que guardou.
function buscarComLimite(url, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { mode: "no-cors", credentials: "omit", signal: ctl.signal })
    .catch(() => new Response("", { status: 504, statusText: "tempo esgotado" }))
    .finally(() => clearTimeout(t));
}

let refGuardadas = new Set();
const carregarRef = async () => { refGuardadas = new Set((await (await caches.open(CACHE_REF)).keys()).map((r) => r.url)); };
carregarRef();
self.addEventListener("message", (e) => { if (e.data?.tipo === "ref-guardada") refGuardadas.add(e.data.url); });

const APP = [
  "app/", "app/index.html", "app/app.css", "app/app.js", "app/figura.js", "app/diagnostico.html", "app/diagnostico.js", "app/privacidade.html", "app/creditos.html", "app/manifest.webmanifest", "app/icone.svg", "app/icone-192.png", "app/icone-512.png", "app/icone-maskable-512.png",
  "core/inferencia.js", "core/inferencia.worker.js", "core/ranking.js", "core/captura.js", "core/acumulador.js", "core/espectrograma.js",
  "core/banco.js", "core/audio.js", "core/sonograma.js", "core/relatorio.js", "core/desempenho.js", "core/campo.js", "core/fontes.js", "core/similaridade.js", "core/pesquisa.js", "core/impressao.js",
];
const M = "modelos/birdnet-plus-v3/", V = "vendor/onnxruntime-web-1.30.0/";
const MODELOS = [
  M + "BirdNET+_V3.0-preview3.1_Global_10K-pruned_FP16.onnx", M + "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_FP16.onnx",
  M + "BirdNET+_V3.0-preview3.1_Global_10K-pruned_Labels.csv", M + "BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_Labels.txt",
  M + "nomes-pt.json", M + "MODEL_LICENSE",
  V + "ort.wasm.min.mjs", V + "ort-wasm-simd-threaded.mjs", V + "ort-wasm-simd-threaded.wasm", V + "LICENSE",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // cache: "reload" vai direto ao servidor: o GitHub Pages manda guardar cada arquivo por 10 min (max-age=600)
    // e, sem isso, a versão nova podia instalar o app.js da versão anterior
    await (await caches.open(CACHE_APP)).addAll(APP.map((u) => new Request(u, { cache: "reload" })));
    const cm = await caches.open(CACHE_MODELOS);
    for (const url of MODELOS) if (!(await cm.match(url))) await cm.add(new Request(url, { cache: "reload" }));   // não baixa de novo o que já tem
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const nome of await caches.keys())
      if (nome.startsWith("fbl-app-") && nome !== CACHE_APP) await caches.delete(nome);   // fbl-referencias e modelos ficam
    await self.clients.claim();
  })());
});

// Cache primeiro para tudo o que foi guardado (app, motor, modelos); o resto vai para a rede.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // fotos e sons de referência (outros sites) guardados pela ficha de espécie: do cache quando houver
  if (url.origin !== location.origin) {
    // Fotos: sempre procura primeiro no cache, direto. Depender de refGuardadas falhava depois de reiniciar o
    // celular: o SW acorda com o pedido da foto e a lista ainda está vazia (carregarRef é assíncrono), então
    // a foto ia para a rede e, sem internet, sumia. Sem cópia guardada: no Chrome 155 do Android, <img> externo
    // fica pendurado com COEP credentialless, mas fetch() funciona; o SW busca (sem credenciais, com tempo
    // limite) e entrega a resposta ao <img>.
    if (e.request.destination === "image")
      e.respondWith(doCache(e.request, [CACHE_REF], { ignoreVary: true }).then((r) => r || buscarComLimite(e.request.url, 20000)));
    else if (refGuardadas.has(e.request.url))
      e.respondWith(doCache(e.request, [CACHE_REF], { ignoreVary: true }).then((r) => r || fetch(e.request)));
    return;
  }
  // testes sempre da rede (nem a página nem o que ela carrega)
  if (url.pathname.includes("/testes") || e.request.referrer.includes("/testes")) return;
  e.respondWith((async () => {
    const guardado = await doCache(e.request, [CACHE_APP, CACHE_MODELOS], { ignoreSearch: true });
    return comIsolamento(guardado || await fetch(e.request));
  })());
});

// Acrescenta COOP/COEP/CORP quando o servidor não manda (ex.: GitHub Pages). Com eles a página fica
// "isolada" e o ONNX Runtime pode usar várias threads. Na 1ª visita a página ainda não passou pelo
// service worker; o app.js recarrega uma vez quando isso acontece.
function comIsolamento(resp) {
  if (!resp || resp.status === 0 || resp.type === "opaque" || resp.headers.get("Cross-Origin-Embedder-Policy")) return resp;
  const h = new Headers(resp.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");   // permite fotos de outros sites sem CORP
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
