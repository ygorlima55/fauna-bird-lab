// Ficha de espécie com fontes ABERTAS: iNaturalist (fotos, resumo e sons) e Wikimedia Commons (sons).
// Cada item guarda fonte, autor (crédito), licença e link. Itens sem licença ("todos os direitos
// reservados") ficam de fora. WikiAves e xeno-canto entram só como LINK (ver fontes_externas.md).
//
// iNaturalist: a API tem CORS; os arquivos de mídia não, então fotos e sons de lá só são exibidos/tocados.
// Commons: arquivos com CORS aberto, então os sons de lá também servem para a comparação por semelhança.

const INAT = "https://api.inaturalist.org/v1";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const LUGAR_BRASIL = 6878;   // place_id do Brasil no iNaturalist
export const VERSAO_FICHA = 2;   // 2 = fotos também do Commons; fichas guardadas com versão menor são refeitas

const NOMES_LICENCA = {
  "cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA", "cc-by-nc": "CC BY-NC", "cc-by-nc-sa": "CC BY-NC-SA",
  "cc-by-nd": "CC BY-ND", "cc-by-nc-nd": "CC BY-NC-ND", "pd": "Domínio público",
};

// "CC BY-NC-SA 4.0" / "cc-by-nc" → {nome, aberta, comercial, derivados}
export function licenca(codigoOuNome) {
  const bruto = String(codigoOuNome || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (!bruto) return { nome: "sem licença", aberta: false };
  const pd = /^(pd|public-domain|domínio-público|dominio-publico|cc0|cc-zero)/.test(bruto);
  const t = pd ? bruto : bruto.replace(/-\d(\.\d)?(-[a-z]{2})?$/, "");   // tira a versão: "cc-by-sa-4.0" → "cc-by-sa"
  const cc = t.startsWith("cc");
  const nome = NOMES_LICENCA[t] || (pd ? "Domínio público" : String(codigoOuNome).trim());
  return { nome, aberta: pd || cc, comercial: pd || (cc && !t.includes("nc")), derivados: pd || (cc && !t.includes("nd")) };
}

const semHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const slug = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "-");

export function links(especie, nomePt) {
  return {
    wikiaves: nomePt ? `https://www.wikiaves.com.br/wiki/${encodeURIComponent(slug(nomePt))}` : null,
    xenocanto: `https://xeno-canto.org/species/${especie.trim().replace(/\s+/g, "-")}`,
    inaturalist: `https://www.inaturalist.org/taxa/${encodeURIComponent(especie)}`,
  };
}

async function json(url, buscar) {
  const r = await buscar(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} em ${new URL(url).hostname}`);
  return r.json();
}

// buscar = fetch (injetável nos testes)
export async function fichaAberta(especie, { nomePt = null, buscar = fetch, maxFotos = 6, maxSons = 6 } = {}) {
  const ficha = { especie, nomePt, versao: VERSAO_FICHA, consultadoEm: new Date().toISOString(), fotos: [], sons: [], resumo: null, erros: [], links: links(especie, nomePt) };

  // iNaturalist: táxon, fotos e resumo
  try {
    const busca = await json(`${INAT}/taxa?q=${encodeURIComponent(especie)}&rank=species&locale=pt-BR&per_page=5`, buscar);
    const t = busca.results.find((x) => x.name.toLowerCase() === especie.toLowerCase());
    if (t) {
      const det = (await json(`${INAT}/taxa/${t.id}?locale=pt-BR`, buscar)).results[0];
      ficha.inat = { id: t.id, nomePt: det.preferred_common_name || null, observacoes: det.observations_count, url: `https://www.inaturalist.org/taxa/${t.id}` };
      ficha.links.inaturalist = ficha.inat.url;
      if (!ficha.nomePt && det.preferred_common_name) { ficha.nomePt = det.preferred_common_name; ficha.links = links(especie, ficha.nomePt); ficha.links.inaturalist = ficha.inat.url; }
      for (const tp of det.taxon_photos || []) {
        const f = tp.photo, lic = licenca(f.license_code);
        if (!lic.aberta || !f.medium_url) continue;
        ficha.fotos.push({ fonte: "iNaturalist", url: f.medium_url, credito: f.attribution, licenca: lic, pagina: `https://www.inaturalist.org/photos/${f.id}` });
        if (ficha.fotos.length >= maxFotos) break;
      }
      if (det.wikipedia_summary) ficha.resumo = { texto: semHtml(det.wikipedia_summary), fonte: "Wikipédia, via iNaturalist", licenca: licenca("CC BY-SA"), pagina: det.wikipedia_url };

      // sons do iNaturalist (Brasil primeiro): só tocar, sem comparação (sem CORS)
      for (const lugar of [`&place_id=${LUGAR_BRASIL}`, ""]) {
        if (ficha.sons.length >= maxSons / 2) break;
        const obs = await json(`${INAT}/observations?taxon_id=${t.id}&sounds=true&quality_grade=research&per_page=10&order_by=votes${lugar}`, buscar);
        for (const o of obs.results) for (const s of o.sounds || []) {
          const lic = licenca(s.license_code);
          if (!lic.aberta || !s.file_url || ficha.sons.some((x) => x.url === s.file_url) || ficha.sons.length >= maxSons / 2) continue;
          ficha.sons.push({ fonte: "iNaturalist", url: s.file_url, credito: s.attribution, licenca: lic, pagina: `https://www.inaturalist.org/observations/${o.id}`,
                            local: o.place_guess || null, data: o.observed_on || null, comparavel: false });
        }
      }
    } else ficha.erros.push("iNaturalist: espécie não encontrada");
  } catch (e) { ficha.erros.push("iNaturalist: " + e.message); }

  // Wikimedia Commons: fotos (segunda fonte, caso o servidor de fotos do iNaturalist esteja fora do ar)
  try {
    const q = `"${especie}" filetype:bitmap`;
    const d = await json(`${COMMONS}?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(q)}` +
      `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&iiextmetadatafilter=LicenseShortName|Artist`, buscar);
    const epiteto = especie.toLowerCase().split(" ")[1];
    let n = 0;
    for (const p of Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index)) {
      const ii = p.imageinfo?.[0], m = ii?.extmetadata || {}, lic = licenca(m.LicenseShortName?.value);
      if (!ii?.thumburl || !lic.aberta || !p.title.toLowerCase().includes(epiteto)) continue;
      ficha.fotos.push({ fonte: "Wikimedia Commons", url: ii.thumburl.split("?")[0], credito: semHtml(m.Artist?.value) || "autor no link", licenca: lic, pagina: ii.descriptionurl });
      if (++n >= 3) break;
    }
  } catch (e) { ficha.erros.push("Commons (fotos): " + e.message); }

  // Wikimedia Commons: sons com CORS (servem para comparar)
  try {
    const q = `"${especie}" filemime:audio`;
    const d = await json(`${COMMONS}?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=${encodeURIComponent(q)}` +
      `&prop=imageinfo&iiprop=url|extmetadata|size&iiextmetadatafilter=LicenseShortName|Artist|ImageDescription`, buscar);
    const paginas = Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index);
    for (const p of paginas) {
      const ii = p.imageinfo?.[0], m = ii?.extmetadata || {};
      const lic = licenca(m.LicenseShortName?.value);
      if (!ii?.url || !lic.aberta || !p.title.toLowerCase().includes(especie.toLowerCase().split(" ")[1])) continue;
      ficha.sons.push({ fonte: "Wikimedia Commons", url: ii.url, credito: semHtml(m.Artist?.value) || "autor no link", licenca: lic,
                        pagina: ii.descriptionurl, titulo: p.title.replace(/^File:/, ""), bytes: ii.size, comparavel: true });
      if (ficha.sons.filter((s) => s.comparavel).length >= maxSons / 2 + 1) break;
    }
  } catch (e) { ficha.erros.push("Commons: " + e.message); }

  return ficha;
}
