// ZIP sem compressão (método "stored"), para baixar vários arquivos num download só.
// Motivo: no Chrome do celular o 2º download seguido (Baixar WAV + Baixar JSON) não chegava (bloqueio de downloads
// múltiplos; memoria/aprendizados.md, 22/10/2026). WAV não comprime bem, então "stored" basta e fica simples.
// Formato: PKWARE APPNOTE 6.3 (cabeçalho local + diretório central + fim do diretório), nomes em UTF-8 (bit 11).

const TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// data e hora no formato do DOS (a precisão é de 2 s)
function dataDos(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, dia };
}

// arquivos: [{ nome, dados: Blob | Uint8Array | string }] → Blob "application/zip"
export async function zipar(arquivos, quando = new Date()) {
  const enc = new TextEncoder(), { hora, dia } = dataDos(quando);
  const partes = [], central = [];
  let deslocamento = 0;
  for (const arq of arquivos) {
    const dados = typeof arq.dados === "string" ? enc.encode(arq.dados)
      : arq.dados instanceof Uint8Array ? arq.dados : new Uint8Array(await arq.dados.arrayBuffer());
    const nome = enc.encode(arq.nome), crc = crc32(dados);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, hora, true); local.setUint16(12, dia, true);
    local.setUint32(14, crc, true); local.setUint32(18, dados.length, true); local.setUint32(22, dados.length, true);
    local.setUint16(26, nome.length, true); local.setUint16(28, 0, true);
    partes.push(local.buffer, nome, dados);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, hora, true); c.setUint16(14, dia, true); c.setUint32(16, crc, true);
    c.setUint32(20, dados.length, true); c.setUint32(24, dados.length, true); c.setUint16(28, nome.length, true);
    c.setUint32(42, deslocamento, true);
    central.push(c.buffer, nome);
    deslocamento += 30 + nome.length + dados.length;
  }
  const tamCentral = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamCentral, true); fim.setUint32(16, deslocamento, true);
  return new Blob([...partes, ...central, fim.buffer], { type: "application/zip" });
}
