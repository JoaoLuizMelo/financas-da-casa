// Alicerce Proj — leitura de propostas (PDF, Word ou foto) no próprio aparelho, sem serviço pago.
// Calibrado no modelo "PROPOSTA DE PRESTAÇÃO DE SERVIÇOS" da JL Projetos Estruturais.

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js";
const carregados = {};
const carregar = src => carregados[src] ??= new Promise((ok, erro) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { delete carregados[src]; erro(new Error("sem_internet")); }; document.head.append(s); });

/* ===== extração de texto ===== */
export async function textoDoPdf(buf, lib = null) {
  let pdfjs = lib;
  if (!pdfjs) { await carregar(PDFJS); pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise, linhas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p), tc = await pg.getTextContent(), grupos = [];
    tc.items.filter(i => i.str.trim()).forEach(i => {
      const y = i.transform[5], x = i.transform[4];
      let g = grupos.find(g => Math.abs(g.y - y) < 2.5); if (!g) grupos.push(g = { y, itens: [] });
      g.itens.push({ x, s: i.str, w: i.width });
    });
    grupos.sort((a, b) => b.y - a.y).forEach(g => {
      g.itens.sort((a, b) => a.x - b.x);
      let txt = "", fim = null;
      g.itens.forEach(i => { if (fim !== null) txt += i.x - fim > 12 ? "   " : (i.x - fim > 1 && !txt.endsWith(" ") && !i.s.startsWith(" ") ? " " : ""); txt += i.s; fim = i.x + i.w; });
      linhas.push(txt);
    });
  }
  return linhas.join("\n");
}
async function textoDoDocx(buf) { await carregar(MAMMOTH); return (await window.mammoth.extractRawText({ arrayBuffer: buf })).value; }

export async function lerArquivo(file, aoProgredir = () => {}) {
  const nome = (file.name || "").toLowerCase();
  if (nome.endsWith(".pdf") || file.type === "application/pdf") { aoProgredir("Lendo o PDF…"); return textoDoPdf(await file.arrayBuffer()); }
  if (nome.endsWith(".docx")) { aoProgredir("Lendo o Word…"); return textoDoDocx(await file.arrayBuffer()); }
  if (file.type.startsWith("image/")) { aoProgredir("Lendo a foto (pode levar alguns segundos)…"); const { lerNota } = await import("../ocr.js"); return (await lerNota(file, (p, m) => aoProgredir(m))).texto; }
  throw new Error("formato");
}

/* ===== interpretação ===== */
const MINUSC = new Set(["de", "da", "do", "das", "dos", "e", "em", "no", "na", "a", "o"]);
export const titulo = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().split(" ").map((w, i) => (i && MINUSC.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ").replace(/\b(Pe|Cnpj|Cpf|Br)\b/g, m => m.toUpperCase());
const centavos = s => Math.round(parseFloat(String(s).replace(/\./g, "").replace(",", ".")) * 100);
const NUM_EXT = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, "três": 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, sessenta: 60, noventa: 90 };
const iso = (d, m, y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export function somarDias(isoData, dias, uteis) {
  const [y, m, d] = isoData.split("-").map(Number), t = new Date(y, m - 1, d); let n = 0;
  while (n < dias) { t.setDate(t.getDate() + 1); if (!uteis || (t.getDay() !== 0 && t.getDay() !== 6)) n++; }
  return iso(t.getDate(), t.getMonth() + 1, t.getFullYear());
}

/* dias úteis entre duas datas (exclui a data inicial, inclui a final; sáb./dom. não contam) */
export function diasUteisEntre(a, b) {
  if (!a || !b || b <= a) return 0;
  const [y, m, d] = a.split("-").map(Number), t = new Date(y, m - 1, d); let n = 0;
  const fim = b; while (true) { t.setDate(t.getDate() + 1); const s = iso(t.getDate(), t.getMonth() + 1, t.getFullYear()); if (s > fim) break; if (t.getDay() !== 0 && t.getDay() !== 6) n++; }
  return n;
}
export function interpretarProposta(bruto) {
  const T = bruto.replace(/\r/g, "").replace(/[ \t]+/g, " "), U = T.toUpperCase(), avisos = [], r = { avisos };
  const entre = (a, b) => { const i = U.indexOf(a); if (i < 0) return ""; const j = b ? U.indexOf(b, i + a.length) : -1; return T.slice(i + a.length, j > i ? j : undefined).replace(/\s+/g, " ").trim(); };
  /* cabeçalho */
  const objeto = entre("OBJETO:", "CLIENTE:");
  const clienteBruto = entre("CLIENTE:", "DATA:").split(/\n/)[0];
  const cnpj = (clienteBruto.match(/CNPJ:?\s*([\d./-]+)/i) || [])[1] || "";
  r.cliente = titulo(clienteBruto.replace(/[–-]\s*CNPJ.*$/i, "").replace(/CNPJ.*$/i, ""));
  const dm = T.match(/DATA:\s*(\d{2})\/(\d{2})\/(\d{4})/i) || T.match(/,\s*(\d{1,2}) de (\w+) de (\d{4})\./);
  if (dm) { const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
    r.orcData = /\d/.test(dm[2]) ? iso(+dm[1], +dm[2], +dm[3]) : iso(+dm[1], meses.indexOf(dm[2].toLowerCase()) + 1, +dm[3]); }
  else avisos.push("Data da proposta não encontrada.");
  r.descricao = objeto ? objeto.charAt(0) + objeto.slice(1).toLowerCase().replace(/\bpe\b/g, "PE").replace(/\bbr\b/g, "BR") : "";
  const cid = [...objeto.matchAll(/([A-ZÀ-Ú][A-ZÀ-Ú ]{2,}?)\s*[-/]\s*(PE|PB|AL|RN|BA|CE|SE|PI|MA)\b/g)].pop();
  r.local = cid ? `${titulo(cid[1].split(",").pop())} – ${cid[2]}` : "";
  r.tipologia = /MULTIFAMILIAR|EDIF[IÍ]CIO|PR[EÉ]DIO/.test(U.slice(0, 600)) ? "Residencial multifamiliar" : /UNIFAMILIAR|RESID[EÊ]NCIA|HABITA[CÇ][AÃ]O|CASA/.test(U.slice(0, 600)) ? "Residencial unifamiliar"
    : /GALP[AÃ]O|IND[UÚ]STRI/.test(U.slice(0, 600)) ? "Industrial / galpão" : /COMERCIAL|LOJA|CL[IÍ]NICA/.test(U.slice(0, 600)) ? "Comercial" : "Outro";
  const de = objeto.match(/RESID[EÊ]NCIA UNIFAMILIAR DE ([A-ZÀ-Ú ]+?),/i);
  const curto = r.cliente.split(" ").filter(w => w.length > 2 || w === "e").slice(0, 2).join(" ");
  r.nome = de ? `Residência ${titulo(de[1])}` : `${curto}${r.local ? " — " + r.local.split(" – ")[0] : ""}`;
  if (cnpj) r.contato = "CNPJ " + cnpj;
  /* valores */
  const tab = U.indexOf("PROPOSTA DE VALORES"), disc = {}; let total = 0;
  if (tab >= 0) {
    const bloco = T.slice(tab, U.indexOf("OBS", tab) > 0 ? U.indexOf("OBS", tab) : tab + 1500);
    bloco.split("\n").forEach(l => {
      const m = l.match(/^\s*\d+\.\d+\s+(.+?)\s+([\d.]+,\d{2})\s*$/); if (m) {
        const d = m[1].toUpperCase(), v = centavos(m[2]);
        const est = /ESTRUTURAL/.test(d), ele = /EL[EÉ]TRIC/.test(d), hid = /HIDRO/.test(d);
        if (est && !ele && !hid) disc["Estrutural"] = (disc["Estrutural"] || 0) + v;
        else if (ele && hid) { disc["Elétrico"] = (disc["Elétrico"] || 0) + v; disc["Hidrossanitário"] ??= 0; r.conjunto = v; }
        else if (ele) disc["Elétrico"] = (disc["Elétrico"] || 0) + v;
        else if (hid) disc["Hidrossanitário"] = (disc["Hidrossanitário"] || 0) + v;
        else disc["Outra"] = (disc["Outra"] || 0) + v;
      }
      const t = l.match(/TOTAL\s+([\d.]+,\d{2})/i); if (t) total = centavos(t[1]);
    });
  }
  r.disciplinas = disc; r.total = total || Object.values(disc).reduce((a, b) => a + b, 0);
  if (!Object.keys(disc).length) avisos.push("Tabela de valores não encontrada — preencha os valores das disciplinas.");
  const soma = Object.values(disc).reduce((a, b) => a + b, 0);
  if (total && soma && soma !== total) avisos.push("A soma das disciplinas difere do total da proposta — confira.");
  if (r.conjunto) avisos.push("Elétrico e hidrossanitário foram orçados juntos; o valor ficou todo no elétrico. Divida se quiser acompanhar separado.");
  /* prazo e validade */
  const nDias = (num, ext) => +num || NUM_EXT[(ext || "").toLowerCase()] || 0;
  const pz = T.match(/Prazo de (\d+)\s*(?:\(([^)]+)\))?\s*dias\s*(úteis|uteis|corridos)?/i);
  if (pz) { r.prazoDias = nDias(pz[1], pz[2]); r.prazoUteis = !/corridos/i.test(pz[3] || "úteis"); } else avisos.push("Prazo não encontrado.");
  const fz = T.match(/fundaç(?:ões|ão) será entregue em (\d+)\s*(?:\(([^)]+)\))?\s*dias\s*(úteis|corridos)?/i);
  if (fz) r.prazoFundacao = `${nDias(fz[1], fz[2])} dias ${/corridos/i.test(fz[3] || "") ? "corridos" : "úteis"}`;
  const vl = T.match(/válida por (\d+)\s*(?:\(([^)]+)\))?\s*dias\s*(úteis|corridos)?/i);
  if (vl && r.orcData) r.validade = somarDias(r.orcData, nDias(vl[1], vl[2]), !/corridos/i.test(vl[3] || "úteis"));
  /* pagamento */
  const fp = ((T.match(/[Ff]orma de pagamento:([\s\S]+?)(?:\n\s*[•\uf0b7]|\.\s*\n|\n\s*[A-ZÀ-Ú]{4,}|$)/) || [])[1] || "").replace(/\s+/g, " ");
  const pcts = [...fp.matchAll(/(\d{1,3})\s*%/g)].map(m => +m[1]);
  if (pcts.length && Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) <= 1) {
    const nomes = pcts.map((_, i) => i === 0 ? "Entrada (sinal)" : i === pcts.length - 1 && /t[eé]rmino|entrega|final/i.test(fp) ? "Na entrega dos projetos" : `Parcela ${i}`);
    r.pagamento = pcts.map((p, i) => ({ desc: `${nomes[i]} — ${p}%`, pct: p }));
    r.formaTexto = fp.replace(/\s+/g, " ").trim();
  } else if (fp) { r.formaTexto = fp.replace(/\s+/g, " ").trim(); avisos.push("Forma de pagamento não reconhecida — lance as parcelas manualmente."); }
  else avisos.push("Forma de pagamento não encontrada.");
  /* condições */
  const cond = [];
  if (/n[aã]o est[aá] inclusa a nota fiscal/i.test(T)) cond.push("sem nota fiscal"); else if (/est[aá] inclusa a nota fiscal/i.test(T)) cond.push("com nota fiscal");
  const vis = T.match(/(\d+)\s*\(([^)]+)\)\s*visitas t[eé]cnicas/i); if (vis) cond.push(`${vis[1]} visitas técnicas`); else if (/n[aã]o est[aá] incluso visitas/i.test(T)) cond.push("sem visitas");
  if (r.prazoDias) cond.push(`prazo ${r.prazoDias} dias ${r.prazoUteis ? "úteis" : "corridos"} após o sinal`);
  if (r.prazoFundacao) cond.push(`fundação em ${r.prazoFundacao}`);
  r.condicoes = cond;
  /* estrutural: respostas do checklist */
  if (disc["Estrutural"] !== undefined) {
    const fund = entre("3. FUNDAÇÕES", "4. DETALHAMENTO") || "", F = fund.toUpperCase(), lista = [];
    if (/SAPATAS? ISOLADAS?/.test(F) || /\[SAPATAS/.test(F)) lista.push("Sapatas isoladas");
    if (/SAPATAS? CORRIDAS?/.test(F)) lista.push("Sapatas corridas");
    if (/MUROS? DE CONTEN/.test(F)) lista.push("Muros de contenção");
    if (/BLOCOS? SOBRE ESTACAS/.test(F) && !/\[/.test(F)) lista.push("Blocos sobre estacas");
    if (/\[.*\/.*\]/.test(fund)) avisos.push("O tipo de fundação está em aberto na proposta ([sapatas / blocos / radier]) — confirme no checklist.");
    const det = entre("4. DETALHAMENTO", "5. DOCUMENTOS").toUpperCase();
    r.estrutural = { tqs: /TQS/.test(U) ? "alugar" : "nao", fund: lista.length ? lista : ["Sapatas isoladas"], npav: 1, coberta: true, rampa: /RAMPA/.test(det), rsup: /RESERVAT/.test(det), rinf: false,
      sistema: /MET[AÁ]LIC/.test(U.slice(0, 800)) ? "Metálico" : "Concreto armado" };
  }
  return r;
}
