// Banco local (IndexedDB). Tabelas:
//   sessoes  — metadados pequenos (lista do histórico, fila de sincronização)
//   arquivos — áudio WAV e imagem do sonograma de cada sessão (só carregados ao abrir o detalhe)
//   fichas   — ficha de espécie de fontes abertas (iNaturalist/Commons), com embeddings das referências (v2)
// Cada sessão tem UUID, horário, GPS e SHA-256 do áudio: é o que a sincronização (Parte 20) usa
// para não duplicar nem perder gravações.
const NOME = "fauna-bird-lab", VERSAO = 2;

let conexao;
function abrir() {
  return (conexao ??= new Promise((ok, erro) => {
    const r = indexedDB.open(NOME, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("sessoes")) {
        const s = db.createObjectStore("sessoes", { keyPath: "id" });
        s.createIndex("inicio", "inicio");
        s.createIndex("sincronizado", "sincronizado");
      }
      if (!db.objectStoreNames.contains("arquivos")) db.createObjectStore("arquivos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("fichas")) db.createObjectStore("fichas", { keyPath: "especie" });
    };
    // outra janela do app aberta com versão velha segura o banco: ela fecha a conexão e recarrega
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); location.reload(); }; ok(r.result); };
    r.onblocked = () => console.warn("banco: feche as outras janelas do app para atualizar");
    r.onerror = () => erro(r.error);
  }));
}

function pedido(r) { return new Promise((ok, erro) => { r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); }); }

async function transacao(tabelas, modo, fn) {
  const db = await abrir(), tx = db.transaction(tabelas, modo);
  const resultado = await fn(tx);
  await new Promise((ok, erro) => { tx.oncomplete = ok; tx.onerror = () => erro(tx.error); tx.onabort = () => erro(tx.error); });
  return resultado;
}

export async function salvarSessao(sessao, arquivos) {
  await transacao(["sessoes", "arquivos"], "readwrite", (tx) => {
    tx.objectStore("sessoes").put(sessao);
    tx.objectStore("arquivos").put({ id: sessao.id, ...arquivos });
  });
}

// só os metadados (ex.: ficha de campo); o áudio e o sonograma ficam como estão
export async function atualizarSessao(sessao) {
  await transacao(["sessoes"], "readwrite", (tx) => { tx.objectStore("sessoes").put(sessao); });
}

// mais recentes primeiro
export async function listarSessoes() {
  const todas = await transacao(["sessoes"], "readonly", (tx) => pedido(tx.objectStore("sessoes").getAll()));
  return todas.sort((a, b) => b.inicio.localeCompare(a.inicio));
}

export const lerSessao = (id) => transacao(["sessoes"], "readonly", (tx) => pedido(tx.objectStore("sessoes").get(id)));
export const lerArquivos = (id) => transacao(["arquivos"], "readonly", (tx) => pedido(tx.objectStore("arquivos").get(id)));

export async function apagarSessao(id) {
  await transacao(["sessoes", "arquivos"], "readwrite", (tx) => {
    tx.objectStore("sessoes").delete(id);
    tx.objectStore("arquivos").delete(id);
  });
}

// Pede ao navegador para não apagar os dados quando faltar espaço (se ele permitir).
export async function pedirPersistencia() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
export async function espaco() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}

export const lerFicha = (especie) => transacao(["fichas"], "readonly", (tx) => pedido(tx.objectStore("fichas").get(especie)));
export async function salvarFicha(ficha) {
  await transacao(["fichas"], "readwrite", (tx) => { tx.objectStore("fichas").put(ficha); });
}
export const listarFichas = () => transacao(["fichas"], "readonly", (tx) => pedido(tx.objectStore("fichas").getAll()));
