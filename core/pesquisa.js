// Envio voluntário para a pesquisa: monta o pacote de uma sessão (áudio WAV + dados JSON) com o registro do
// consentimento. Nada é enviado sozinho: o pacote vai para o "compartilhar" do aparelho (WhatsApp, e-mail,
// Drive...) e a pessoa escolhe para onde mandar. Ver app/privacidade.html.
export const VERSAO_TERMO = "2026-10-22";
export const CONTATO = "agrofort.projetos@gmail.com";

// Arredonda a posição para ~1 km (2 casas decimais) quando a pessoa não autoriza o local exato.
export function localParaEnvio(local, exato) {
  if (!local) return null;
  if (exato) return { ...local, precisaoEnvio: "exata" };
  const r = (x) => Math.round(x * 100) / 100;
  return { lat: r(local.lat), lon: r(local.lon), fonte: local.fonte, precisaoEnvio: "aproximada (~1 km)" };
}

// impressao: {versao, sr, passo, codigos, dados (base64)} — permite achar a mesma gravação enviada por pessoas diferentes
export function pacoteDados(sessao, { autorizado, localExato, credito, contato, observacao, app, impressao = null }) {
  if (!autorizado) throw new Error("sem autorização: nada é montado");
  const { janelas, ...resto } = sessao;
  return {
    tipo: "fauna-bird-lab/pacote-pesquisa", versao: 1, app,
    consentimento: {
      termo: VERSAO_TERMO, autorizado: true, quando: new Date().toISOString(),
      texto: "Autorizo o uso deste áudio e destes dados para pesquisa e para treinar e avaliar modelos de identificação de aves e anfíbios.",
      localExato: Boolean(localExato), credito: (credito || "").trim() || null, contato: (contato || "").trim() || null,
    },
    observacaoDoEnvio: (observacao || "").trim() || null,
    sessao: { ...resto, local: localParaEnvio(sessao.local, localExato), janelas: janelas?.length ?? 0 },
    janelas: janelas || [],
    impressao,
  };
}

export function nomeArquivos(sessao) {
  const base = `birdlab_${sessao.inicio.slice(0, 19).replace(/[:T]/g, "-")}_${sessao.id.slice(0, 8)}`;
  return { audio: base + ".wav", dados: base + ".json" };
}
