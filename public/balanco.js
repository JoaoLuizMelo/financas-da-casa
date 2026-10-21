// Alicerce — balanço mensal: consolidação dos números e geração do PDF (jsPDF, no próprio aparelho, gratuito)
import { AMB_NOME, MESES, brl, grupoDe, ambitoDe, valorParcela, dm } from "./nucleo.js";

const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

/* ===== consolidação ===== */
export function montarBalanco({ mes, itens, nome, pessoas = {}, conjunto = false, obs = "", cartoes = [] }) {
  const somar = arr => { let rec = 0, des = 0, pen = 0; arr.forEach(l => { if (l.tipo === "receita") rec += l.valor; else { des += l.valor; if (!l.pago) pen += l.valor; } }); return { rec, des, pen, res: rec - des }; };
  const totais = somar(itens);
  const ambitos = ["pessoal", "empresa"].map(a => ({ a, ...somar(itens.filter(l => ambitoDe(l) === a)) })).filter(x => x.rec || x.des);
  const porPessoa = conjunto ? Object.entries(pessoas).map(([u, n]) => ({ nome: n, ...somar(itens.filter(l => l.uid === u)) })).filter(x => x.rec || x.des) : [];
  const gmap = {};
  itens.filter(l => l.tipo === "despesa").forEach(l => { const g = grupoDe(l); const o = gmap[g] ||= { g, a: ambitoDe(l), v: 0, cats: {} }; o.v += l.valor; o.cats[l.categoria] = (o.cats[l.categoria] || 0) + l.valor; });
  const grupos = Object.values(gmap).sort((a, b) => b.v - a.v).map(o => ({ ...o, cats: Object.entries(o.cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ c, v })) }));
  const rmap = {};
  itens.filter(l => l.tipo === "receita").forEach(l => { const k = l.categoria; const o = rmap[k] ||= { c: k, g: grupoDe(l), v: 0 }; o.v += l.valor; });
  const receitas = Object.values(rmap).sort((a, b) => b.v - a.v);
  const agrupar = (arr, chave) => { const m = {}; arr.forEach(l => { const k = chave(l); const o = m[k.key] ||= { ...k, n: 0, v: 0, ab: 0 }; o.n++; o.v += l.valor; if (!l.pago) o.ab += l.valor; }); return Object.values(m).sort((a, b) => b.v - a.v).map(({ key, ...r }) => r); };
  const prestadores = agrupar(itens.filter(l => l.tipo === "despesa" && l.categoria === "Prestadores de serviço"), l => { const p = (l.contraparte || "Não informado").trim(), j = (l.projeto || "—").trim(); return { key: p + "|" + j, p, j }; });
  const clientes = agrupar(itens.filter(l => l.tipo === "receita" && ambitoDe(l) === "empresa"), l => { const c = (l.contraparte || "Não informado").trim(), o = l.categoria, j = (l.projeto || "—").trim(); return { key: c + "|" + o + "|" + j, c, o, j }; });
  const cmap = {};
  itens.filter(l => l.virtual).forEach(p => {
    const o = cmap[p.cartao.id] ||= { nome: p.cartao.nome, vence: p.data, pago: p.pago, v: 0, itens: [] };
    let rest = 0; for (let k = p.k + 1; k < p.compra.parcelas; k++) rest += valorParcela(p.compra, k);
    o.v += p.valor; o.itens.push({ d: p.compra.descricao, parc: p.compra.parcelas > 1 ? `${p.k + 1}/${p.compra.parcelas}` : "à vista", v: p.valor, falta: p.compra.parcelas - p.k - 1, rest, pessoa: pessoas[p.uid] || "" });
  });
  const cartoesRes = Object.values(cmap).sort((a, b) => b.v - a.v);
  const lancamentos = itens.slice().sort((a, b) => a.data.localeCompare(b.data) || (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0)).map(l => ({
    data: l.data, tipo: l.tipo, desc: l.descricao, grupo: grupoDe(l), cat: l.categoria, ambito: ambitoDe(l),
    contra: l.contraparte || "", proj: l.projeto || "", doc: l.documento || "", valor: l.valor, pago: !!l.pago,
    cartao: l.virtual ? l.cartao.nome : "", pessoa: conjunto ? (pessoas[l.uid] || "") : ""
  }));
  return { mes, nome, conjunto, obs, geradoEm: Date.now(), totais, ambitos, porPessoa, grupos, receitas, prestadores, clientes, cartoes: cartoesRes, lancamentos };
}

/* ===== PDF ===== */
const carregados = {};
const carregar = src => carregados[src] ??= new Promise((ok, erro) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { delete carregados[src]; erro(new Error("Sem internet para carregar o gerador de PDF.")); }; document.head.append(s); });

const COR = { petroleo: [15, 88, 104], ciano: [79, 179, 198], laranja: [240, 138, 60], grafite: [20, 38, 43], texto: [30, 42, 46], suave: [98, 117, 122], linha: [218, 226, 228], fundo: [244, 247, 247], verde: [31, 122, 82], vermelho: [178, 67, 31], amarelo: [168, 106, 0] };
const SERIES = [[42, 120, 214], [235, 104, 52], [27, 175, 122], [237, 161, 0], [232, 123, 164], [0, 131, 0], [98, 80, 214], [150, 160, 163]];
let logoCache = null;
async function logoPdf() {
  if (logoCache) return logoCache;
  try {
    const blob = await (await fetch(new URL("monograma.png", import.meta.url))).blob();
    const url = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    const img = await new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = erro; i.src = url; });
    return logoCache = { url, w: img.naturalWidth, h: img.naturalHeight };
  } catch (e) { return null; }
}
const nomeMes = m => `${MESES[+m.slice(5) - 1]}/${m.slice(0, 4)}`;
const Nome = s => s[0].toUpperCase() + s.slice(1);
const dataBR = iso => iso.split("-").reverse().join("/");

export async function gerarPdf(b) {
  await carregar(JSPDF); await carregar(AUTOTABLE);
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, H = 297, M = 14, CW = W - 2 * M;
  let y = 0;
  const fill = c => pdf.setFillColor(...c), draw = c => pdf.setDrawColor(...c), cor = c => pdf.setTextColor(...c);
  const fonte = (estilo = "normal", tam = 9) => { pdf.setFont("helvetica", estilo); pdf.setFontSize(tam); };
  const espaco = h => { if (y + h > H - 18) { pdf.addPage(); y = 18; } };
  const titulo = (txt, sub) => { espaco(16); y += 3; fill(COR.laranja); pdf.rect(M, y - 3.2, 1.4, 4.6, "F"); fonte("bold", 11); cor(COR.grafite); pdf.text(txt, M + 4, y + 0.6); if (sub) { fonte("normal", 8); cor(COR.suave); pdf.text(sub, W - M, y + 0.6, { align: "right" }); } y += 5; };
  const tabela = (head, body, opts = {}) => {
    pdf.autoTable({ startY: y, head: [head], body, margin: { left: M, right: M, top: 18, bottom: 18 }, theme: "plain",
      styles: { font: "helvetica", fontSize: 8.2, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 }, textColor: COR.texto, lineColor: COR.linha, overflow: "linebreak" },
      headStyles: { fontStyle: "bold", fontSize: 7.2, textColor: COR.suave, fillColor: COR.fundo },
      bodyStyles: { lineWidth: { bottom: 0.15 } }, footStyles: { fontStyle: "bold", fillColor: [255, 255, 255], textColor: COR.grafite, lineWidth: { top: 0.4 }, lineColor: COR.grafite },
      ...opts });
    y = pdf.lastAutoTable.finalY + 5;
  };

  /* cabeçalho: logo do engenheiro + título do balanço */
  const logo = await logoPdf();
  let lx = M; if (logo) { const lh = 15, lw = lh * logo.w / logo.h; pdf.addImage(logo.url, "PNG", M, 8.5, lw, lh); lx = M + lw + 5; }
  fonte("bold", 15); cor(COR.grafite); pdf.text("ALICERCE", lx, 18, { charSpace: 1.6 });
  fonte("bold", 13); cor(COR.grafite); pdf.text("Balanço mensal", W - M, 15, { align: "right" });
  fonte("normal", 9.5); cor(COR.suave); pdf.text(Nome(nomeMes(b.mes)) + (b.conjunto ? " · conjunto" : ""), W - M, 20.5, { align: "right" });
  fonte("normal", 7.5);
  pdf.text(`${b.nome || ""} · ${b.fechadoEm ? `fechado em ${new Date(b.fechadoEm).toLocaleDateString("pt-BR")}` : `prévia gerada em ${new Date().toLocaleDateString("pt-BR")}`}`, W - M, 25.5, { align: "right" });
  fill(COR.laranja); pdf.rect(M, 30, 22, 1.1, "F"); fill(COR.grafite); pdf.rect(M + 22, 30.35, CW - 22, 0.4, "F");
  y = 44;

  /* indicadores */
  const t = b.totais, kw = (CW - 9) / 4;
  [["RECEITAS", t.rec, COR.verde], ["DESPESAS", t.des, COR.vermelho], ["RESULTADO", t.res, t.res < 0 ? COR.vermelho : COR.petroleo], ["A PAGAR", t.pen, COR.amarelo]].forEach(([r, v, c], i) => {
    const x = M + i * (kw + 3); fill(i === 2 ? [231, 242, 244] : COR.fundo); pdf.roundedRect(x, y, kw, 19, 2, 2, "F");
    fill(c); pdf.rect(x, y + 3, 0.9, 13, "F");
    fonte("bold", 6.8); cor(COR.suave); pdf.text(r, x + 4, y + 6.5, { charSpace: 0.4 });
    fonte("bold", 11.5); cor(c); pdf.text(brl(v), x + 4, y + 14);
  });
  y += 25;
  const pct = t.rec ? t.des / t.rec : (t.des ? 1 : 0);
  fonte("normal", 8); cor(COR.suave); pdf.text("Despesas em relação às receitas", M, y); fonte("bold", 8); cor(COR.grafite); pdf.text(`${Math.round(pct * 100)}%`, W - M, y, { align: "right" });
  y += 2.2; fill(COR.linha); pdf.roundedRect(M, y, CW, 3, 1.5, 1.5, "F");
  fill(pct > 1 ? COR.vermelho : COR.ciano); pdf.roundedRect(M, y, Math.max(3, CW * Math.min(1, pct)), 3, 1.5, 1.5, "F");
  y += 9;

  /* resultado por âmbito / pessoa */
  if (b.ambitos.length) { titulo("Resultado por âmbito");
    tabela(["ÂMBITO", "RECEITAS", "DESPESAS", "RESULTADO"], b.ambitos.map(x => [AMB_NOME[x.a], brl(x.rec), brl(x.des), brl(x.res)]),
      { foot: [["Total", brl(t.rec), brl(t.des), brl(t.res)]], columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right", fontStyle: "bold" } }, didParseCell: d => { if (d.column.index > 0 && d.section !== "body" ) d.cell.styles.halign = "right"; } }); }
  if (b.porPessoa.length > 1) { titulo("Resultado por pessoa");
    tabela(["PESSOA", "RECEITAS", "DESPESAS", "RESULTADO"], b.porPessoa.map(x => [x.nome, brl(x.rec), brl(x.des), brl(x.res)]),
      { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right", fontStyle: "bold" } }, didParseCell: d => { if (d.column.index > 0 && d.section === "head") d.cell.styles.halign = "right"; } }); }

  /* despesas por grupo: barras horizontais */
  if (b.grupos.length) {
    titulo("Despesas por grupo", brl(t.des));
    const max = b.grupos[0].v;
    b.grupos.forEach((g, i) => {
      espaco(8);
      fonte("bold", 8.5); cor(COR.texto); pdf.text(g.g, M, y + 3);
      fonte("normal", 7); cor(COR.suave); pdf.text(AMB_NOME[g.a].toUpperCase(), M, y + 6.6);
      const bx = M + 52, bw = CW - 52 - 42;
      fill(COR.fundo); pdf.roundedRect(bx, y + 1, bw, 4.2, 1, 1, "F");
      fill(SERIES[i % SERIES.length]); pdf.roundedRect(bx, y + 1, Math.max(1.5, bw * g.v / max), 4.2, 1, 1, "F");
      fonte("bold", 8.5); cor(COR.grafite); pdf.text(brl(g.v), W - M - 12, y + 4.4, { align: "right" });
      fonte("normal", 8); cor(COR.suave); pdf.text(`${Math.round(g.v / t.des * 100)}%`, W - M, y + 4.4, { align: "right" });
      y += 9;
    });
    y += 1;
    titulo("Despesas por categoria");
    const linhas = []; b.grupos.forEach(g => g.cats.forEach(c => linhas.push([g.g, c.c, brl(c.v), `${(c.v / t.des * 100).toFixed(1).replace(".", ",")}%`])));
    tabela(["GRUPO", "CATEGORIA", "VALOR", "% DAS DESPESAS"], linhas, { columnStyles: { 2: { halign: "right" }, 3: { halign: "right", textColor: COR.suave } }, didParseCell: d => { if (d.column.index > 1 && d.section === "head") d.cell.styles.halign = "right"; } });
  }
  if (b.receitas.length) { titulo("Receitas por origem", brl(t.rec));
    tabela(["ORIGEM", "GRUPO", "VALOR", "% DAS RECEITAS"], b.receitas.map(r => [r.c, r.g, brl(r.v), `${(r.v / t.rec * 100).toFixed(1).replace(".", ",")}%`]),
      { columnStyles: { 2: { halign: "right" }, 3: { halign: "right", textColor: COR.suave } }, didParseCell: d => { if (d.column.index > 1 && d.section === "head") d.cell.styles.halign = "right"; } }); }
  if (b.prestadores.length) { titulo("Prestadores de serviço");
    tabela(["PRESTADOR", "PROJETO / OBRA", "PGTOS", "VALOR", "EM ABERTO"], b.prestadores.map(r => [r.p, r.j, r.n, brl(r.v), brl(r.ab)]),
      { columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } }, didParseCell: d => { if (d.column.index > 1 && d.section === "head") d.cell.styles.halign = "right"; } }); }
  if (b.clientes.length) { titulo("Receitas da empresa por cliente");
    tabela(["CLIENTE", "ORIGEM", "PROJETO / OBRA", "VALOR", "A RECEBER"], b.clientes.map(r => [r.c, r.o, r.j, brl(r.v), brl(r.ab)]),
      { columnStyles: { 3: { halign: "right" }, 4: { halign: "right" } }, didParseCell: d => { if (d.column.index > 2 && d.section === "head") d.cell.styles.halign = "right"; } }); }
  b.cartoes.forEach(c => {
    titulo(`Cartão ${c.nome}`, `${brl(c.v)} · vence ${dm(c.vence)} · ${c.pago ? "fatura paga" : "fatura em aberto"}`);
    tabela(["COMPRA", "PARCELA", ...(b.conjunto ? ["PESSOA"] : []), "VALOR", "FALTAM"], c.itens.map(i => [i.d, i.parc, ...(b.conjunto ? [i.pessoa] : []), brl(i.v), i.falta ? `${i.falta} · ${brl(i.rest)}` : "—"]),
      { columnStyles: { [b.conjunto ? 3 : 2]: { halign: "right" }, [b.conjunto ? 4 : 3]: { halign: "right", textColor: COR.suave } }, didParseCell: d => { if (d.column.index >= (b.conjunto ? 3 : 2) && d.section === "head") d.cell.styles.halign = "right"; } });
  });

  /* lançamentos */
  titulo("Lançamentos do mês", `${b.lancamentos.length} itens`);
  tabela(["DATA", "DESCRIÇÃO", "CATEGORIA", ...(b.conjunto ? ["PESSOA"] : []), "SITUAÇÃO", "VALOR"],
    b.lancamentos.map(l => [dm(l.data), [l.desc, [l.contra, l.proj, l.doc, l.cartao && "Cartão " + l.cartao].filter(Boolean).join(" · ")].filter(Boolean).join("\n"), `${l.grupo} › ${l.cat}`, ...(b.conjunto ? [l.pessoa] : []),
      l.cartao ? (l.pago ? "Fatura paga" : "Na fatura") : l.tipo === "receita" ? (l.pago ? "Recebido" : "A receber") : (l.pago ? "Pago" : "A pagar"), (l.tipo === "receita" ? "+ " : "- ") + brl(l.valor)]),
    { columnStyles: { 0: { cellWidth: 13, textColor: COR.suave }, [b.conjunto ? 5 : 4]: { halign: "right", fontStyle: "bold", cellWidth: 27 } },
      didParseCell: d => { const ic = b.conjunto ? 5 : 4; if (d.section === "head" && d.column.index === ic) d.cell.styles.halign = "right";
        if (d.section === "body" && d.column.index === ic) d.cell.styles.textColor = b.lancamentos[d.row.index].tipo === "receita" ? COR.verde : COR.vermelho; } });

  if (b.obs) { titulo("Observações"); fonte("normal", 9); cor(COR.texto); const ls = pdf.splitTextToSize(b.obs, CW); espaco(ls.length * 4.5); pdf.text(ls, M, y + 2); y += ls.length * 4.5 + 4; }

  /* rodapé em todas as páginas */
  const n = pdf.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    pdf.setPage(p); draw(COR.linha); pdf.setLineWidth(0.2); pdf.line(M, H - 12, W - M, H - 12);
    fonte("normal", 7); cor(COR.suave);
    pdf.text(`Alicerce · Balanço de ${nomeMes(b.mes)} · ${b.nome || ""}`, M, H - 7.5);
    pdf.text(`Página ${p} de ${n}`, W - M, H - 7.5, { align: "right" });
  }
  const arquivo = `Alicerce-balanco-${b.mes}${b.conjunto ? "-conjunto" : ""}.pdf`;
  pdf.save(arquivo);
  return arquivo;
}
