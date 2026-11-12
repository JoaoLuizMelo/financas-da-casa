// Alicerce Proj — gestão de projetos (dados, orçamento, fechamento, entrada, parcelamento, etapas, histórico).
// Mesmo Firebase e mesma conta do Alicerce; dados em users/{uid}/proj/{id} e relatórios em users/{uid}/projrel/{semana}.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, getDoc, query, where, arrayUnion, arrayRemove, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";
import { brl, parseValor, fmtIn, hojeISO, addDias, addMeses, difDias, dm } from "../nucleo.js";
import { carregar, logoPdf, COR, JSPDF, AUTOTABLE } from "../balanco.js";
import { lerArquivo, interpretarProposta, somarDias, diasUteisEntre } from "./proposta.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ===== modelos ===== */
export const DISCIPLINAS = {
  "Estrutural": ["Lançamento", "Formas", "Cálculo"],
  "Elétrico": ["Levantamento de cargas e pontos", "Quadro de cargas / circuitos", "Dimensionamento", "Pranchas e diagramas", "Memorial descritivo", "Entrega"],
  "Hidrossanitário": ["Levantamento de pontos", "Água fria / quente", "Esgoto e pluvial", "Reservatórios", "Pranchas e isométricos", "Entrega"],
  "Laudo / perícia": ["Vistoria", "Levantamento e ensaios", "Elaboração do laudo", "Entrega"],
  "Outra": ["Etapa 1", "Entrega"]
};
const SISTEMAS = ["A definir", "Concreto armado", "Metálico", "Misto — coberta metálica com pilares em concreto armado", "Pré-moldado"];
const ST = [["orcamento", "Orçamento"], ["negociacao", "Em negociação"], ["fechado", "Fechado"], ["execucao", "Em execução"], ["entregue", "Entregue"], ["concluido", "Concluído"], ["perdido", "Não fechado"]];
const STN = Object.fromEntries(ST);
const FLUXO = ["orcamento", "negociacao", "fechado", "execucao", "entregue", "concluido"];
const ATIVOS = ["fechado", "execucao", "entregue"];
/* checklist estrutural montado a partir das respostas do projeto */
const FUNDACOES = ["Sapatas isoladas", "Sapatas corridas", "Muros de contenção", "Blocos sobre estacas"];
const CFG_PADRAO = { tqs: "alugar", fund: ["Sapatas isoladas"], npav: 1, coberta: true, escada: false, rampa: false, piscina: false, rsup: true, rinf: false };
const nomePav = (i, n) => n === 1 ? "Térreo" : i === 0 ? "Térreo" : `${i}º pavimento`;
export function etapasEstrutural(cfg = CFG_PADRAO, sistema = "A definir") {
  const c = { ...CFG_PADRAO, ...cfg }, n = Math.max(1, Math.min(30, +c.npav || 1)), L = [];
  const pav = i => nomePav(i, n).toLowerCase(), cadaPav = txt => { for (let i = 0; i < n; i++) L.push(`${txt} ${pav(i)}`); };
  const fundacao = () => (c.fund.length ? c.fund : ["Fundação"]).forEach(f => L.push(`Fundação — detalhar ${f.toLowerCase()}`));
  const extras = () => { if (c.escada) L.push(/^Metálico$/.test(sistema) ? "Escada — detalhamento" : "Escada — armação"); if (c.rampa) L.push("Rampa — armação"); if (c.piscina) L.push("Piscina — armação");
    if (c.rsup) L.push("Reservatório superior"); if (c.rinf) L.push("Reservatório inferior"); };
  if (c.tqs === "alugar") L.push("TQS — alugar licença");
  if (sistema === "Metálico") {
    L.push("Cálculo");
    cadaPav("Detalhamento das peças —");
    cadaPav("Detalhamento da laje —");
    fundacao();
    L.push("Chapas de base e topo");
    if (c.coberta) L.push("Coberta — detalhamento das peças");
    extras();
    L.push("Gerar IFC");
  } else if (/^Misto/.test(sistema)) {
    L.push("Lançamento das formas", "Preparar as formas (plantas de formas)");
    fundacao();
    L.push("Pilares em concreto armado — detalhamento");
    cadaPav("Vigas — armação");
    cadaPav("Lajes — armação");
    L.push("Coberta metálica — cálculo", "Coberta metálica — detalhamento das peças", "Chapas de base e topo (ligação pilar × coberta)");
    extras();
    L.push("Gerar IFC (coberta metálica)");
  } else {
    L.push("Lançamento das formas", "Preparar as formas (plantas de formas)");
    fundacao();
    L.push("Pilares — detalhamento");
    cadaPav("Vigas — armação");
    if (c.coberta) L.push("Coberta — vigas");
    cadaPav("Lajes — armação");
    if (c.coberta) L.push("Coberta — lajes e elementos");
    extras();
  }
  return L;
}
const mesclar = (novas, velhas) => novas.map(t => { const v = (velhas || []).find(e => e.t === t); return v ? v : { t, ok: false, data: null }; });
const novaDisc = d => d === "Estrutural"
  ? { d, valor: 0, sistema: "A definir", config: { ...CFG_PADRAO }, etapas: etapasEstrutural(CFG_PADRAO, "A definir").map(t => ({ t, ok: false, data: null })) }
  : { d, valor: 0, etapas: DISCIPLINAS[d].map(t => ({ t, ok: false, data: null })) };

/* ===== utilitários ===== */
const $ = s => document.querySelector(s);
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3200); }
function falha(e) { console.error(e); toast(e?.code === "permission-denied" ? "Sem permissão para alterar este item." : e?.code === "unavailable" ? "Sem conexão. A alteração será enviada quando a internet voltar." : "Não foi possível salvar. Tente de novo."); }
function armar(btn, rotulo, acao) { let a = false; btn.onclick = async () => { if (!a) { a = true; btn.classList.add("armed"); btn.textContent = "Confirmar"; setTimeout(() => { a = false; btn.classList.remove("armed"); btn.textContent = rotulo; }, 4000); return; } a = false; btn.classList.remove("armed"); btn.textContent = rotulo; await acao(); }; }
const dBR = iso => iso ? iso.split("-").reverse().join("/") : "—";
const agoraISO = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${hojeISO()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const segunda = iso => { const [y, m, d] = iso.split("-").map(Number), w = (new Date(y, m - 1, d).getDay() + 6) % 7; return addDias(iso, -w); };

/* ===== carteira inicial (informada pelo usuário em 12/11/2026) ===== */
const INICIAIS = [
  { nome: "Ambirê – Bella Vista", disc: { "Estrutural": 1500000 }, pago: 800000 },
  { nome: "Guilherme Guilhermino", disc: { "Estrutural": 1000000 }, pago: 500000 },
  { nome: "Cartório Arcoverde", local: "Arcoverde – PE", tipologia: "Institucional", disc: { "Estrutural": 300000 }, pago: 150000 },
  { nome: "Wendi – Mezanino metálico", sistema: "Metálico", disc: { "Estrutural": 500000 }, pago: 250000 },
  { nome: "Shopping Arcoverde", local: "Arcoverde – PE", tipologia: "Comercial", disc: { "Estrutural": 2000000 }, pago: 0, status: "fechado", obs: "Informado em 12/11/2026: valor R$ 20.000,00 — confirmar disciplinas, recebimentos e prazo." },
  { nome: "Residência Danrley Idalino", cliente: "Danrley Vieira da Costa Idalino", contato: "Indicação: Fabio Carneiro", tipologia: "Residencial unifamiliar", disc: { "Estrutural": 150000, "Elétrico": 0, "Hidrossanitário": 0 }, pago: 0, status: "fechado", obs: "Residência pequena. Valor total de R$ 1.500,00 para estrutural, elétrico e hidrossanitário." },
  { nome: "EccoPrime", disc: { "Estrutural": 2000000, "Elétrico": 0, "Hidrossanitário": 0 }, pago: 1000000, obs: "Valor total de R$ 20.000,00 para as três disciplinas — distribuir entre estrutural, elétrico e hidrossanitário." }
];
function projetoInicial(x) {
  const h = hojeISO(), disciplinas = Object.entries(x.disc).map(([d, v]) => { const o = { ...novaDisc(d), valor: v };
    if (d === "Estrutural" && x.sistema) { o.sistema = x.sistema; o.etapas = etapasEstrutural(o.config, o.sistema).map(t => ({ t, ok: false, data: null })); } return o; });
  const total = Object.values(x.disc).reduce((a, b) => a + b, 0);
  return { ...modelo(), nome: x.nome, cliente: x.cliente || "", contato: x.contato || "", local: x.local || "", tipologia: x.tipologia || "Residencial unifamiliar", status: x.status || "execucao", obs: x.obs || "", disciplinas, orcData: "", validade: "", fechamento: "",
    parcelas: [{ desc: "Valor já recebido (até 12/11/2026)", valor: x.pago, venc: "", pago: true, pagoEm: "" }, { desc: x.pago ? "Saldo a receber" : "Valor a receber", valor: total - x.pago, venc: "", pago: false }].filter(y => y.valor > 0),
    historico: [{ d: agoraISO(), t: `Projeto importado — ${brl(total)} contratados, ${brl(x.pago)} recebidos` }], atualizadoEm: Date.now(), criadoEm: Date.now() };
}
/* propostas lidas dos PDFs enviados em 12/11/2026 (mesmo leitor do botão "Ler proposta") */
const PROPOSTAS_INICIAIS = [
  { r: {"avisos": [], "cliente": "Felipe Mota Pimentel de Oliveira", "orcData": "2026-10-24", "descricao": "Elaboração dos projetos estrutural, elétrico e hidrossanitário de uma habitação unifamiliar situada no lote 07 (sete) da quadra \"a\", na alameda \"i\" (interna praça 04) do loteamento \"alamedas da serra privê\", às margens da BR-423, km 83, bairro josé maria dourado, garanhuns-PE", "local": "Garanhuns – PE", "tipologia": "Residencial unifamiliar", "nome": "Felipe Mota — Garanhuns", "disciplinas": {"Estrutural": 600000, "Elétrico": 250000, "Hidrossanitário": 150000}, "total": 1000000, "prazoDias": 30, "prazoUteis": true, "prazoFundacao": "15 dias corridos", "validade": "2026-12-04", "pagamento": [{"desc": "Entrada (sinal) — 50%", "pct": 50}, {"desc": "Na entrega dos projetos — 50%", "pct": 50}], "formaTexto": "50% no início dos serviços, na aprovação do contrato, e 50% no término, na entrega dos projetos", "condicoes": ["sem nota fiscal", "3 visitas técnicas", "prazo 30 dias úteis após o sinal", "fundação em 15 dias corridos"], "estrutural": {"tqs": "alugar", "fund": ["Sapatas isoladas", "Sapatas corridas"], "npav": 1, "coberta": true, "rampa": false, "rsup": true, "rinf": false, "sistema": "Concreto armado"}}, status: "execucao", desconto: 50000, pagos: 1 },
  { r: {"avisos": ["Elétrico e hidrossanitário foram orçados juntos; o valor ficou todo no elétrico. Divida se quiser acompanhar separado.", "O tipo de fundação está em aberto na proposta ([sapatas / blocos / radier]) — confirme no checklist."], "cliente": "Basemate Lúcia das Neves Couto", "orcData": "2026-10-15", "descricao": "Elaboração dos projetos estrutural, elétrico e hidrossanitário de uma residência unifamiliar", "local": "", "tipologia": "Residencial unifamiliar", "nome": "Basemate Lúcia", "conjunto": 300000, "disciplinas": {"Estrutural": 700000, "Elétrico": 300000, "Hidrossanitário": 0}, "total": 1000000, "prazoDias": 20, "prazoUteis": true, "validade": "2026-11-26", "pagamento": [{"desc": "Entrada (sinal) — 50%", "pct": 50}, {"desc": "Na entrega dos projetos — 50%", "pct": 50}], "formaTexto": "50% no início dos serviços, na aprovação do contrato, e 50% no término, na entrega dos projetos", "condicoes": ["com nota fiscal", "sem visitas", "prazo 20 dias úteis após o sinal"], "estrutural": {"tqs": "alugar", "fund": ["Sapatas isoladas"], "npav": 1, "coberta": true, "rampa": true, "rsup": true, "rinf": false, "sistema": "Concreto armado"}}, status: "execucao", pagos: 1 },
  { r: {"avisos": ["Elétrico e hidrossanitário foram orçados juntos; o valor ficou todo no elétrico. Divida se quiser acompanhar separado."], "cliente": "Cavalcanti e Magnabosco", "orcData": "2026-11-05", "descricao": "Elaboração dos projetos elétrico e hidrossanitário da residência unifamiliar de flávia e osvaldo, situada no condomínio hyeda castro, lote 36, quadra 04, estrada de aldeia, km 12,5, aldeia dos camarás, camaragibe/PE", "local": "Camaragibe – PE", "tipologia": "Residencial unifamiliar", "nome": "Residência Flávia e Osvaldo", "contato": "CNPJ 34.281.365/0001-53", "conjunto": 250000, "disciplinas": {"Elétrico": 250000, "Hidrossanitário": 0}, "total": 250000, "prazoDias": 20, "prazoUteis": true, "validade": "2026-12-17", "pagamento": [{"desc": "Entrada (sinal) — 50%", "pct": 50}, {"desc": "Na entrega dos projetos — 50%", "pct": 50}], "formaTexto": "sinal de 50% na aprovação do contrato (R$ 1.250,00) e parcela final de 50% na entrega dos serviços completos (R$ 1.250,00)", "condicoes": ["sem nota fiscal", "prazo 20 dias úteis após o sinal"]}, status: "orcamento" }
];
export function projetoDeProposta(r, { status = "orcamento", desconto = 0, pagos = 0 } = {}) {
  const disciplinas = Object.entries(r.disciplinas || {}).map(([d, v]) => {
    const o = { ...novaDisc(d in DISCIPLINAS ? d : "Outra"), valor: v };
    if (d === "Estrutural" && r.estrutural) { const { sistema, ...cfg } = r.estrutural; o.sistema = sistema; o.config = { ...CFG_PADRAO, ...cfg }; o.etapas = etapasEstrutural(o.config, sistema).map(t => ({ t, ok: false, data: null })); }
    return o; });
  const fechado = Math.max(0, (r.total || 0) - desconto), pg = r.pagamento || []; let acc = 0;
  const parcelas = pg.map((x, i) => { const v = i === pg.length - 1 ? fechado - acc : Math.round(fechado * x.pct / 100); acc += v; return { desc: x.desc, valor: v, venc: "", pago: i < pagos, pagoEm: "", ...(i === 0 ? { entrada: true } : {}) }; });
  const obs = [r.condicoes?.length ? "Condições: " + r.condicoes.join("; ") + "." : "", r.conjunto ? `Elétrico e hidrossanitário orçados juntos (${brl(r.conjunto)}).` : ""].filter(Boolean).join(" ");
  return { ...modelo(), nome: r.nome || "Proposta sem nome", cliente: r.cliente || "", contato: r.contato || "", local: r.local || "", tipologia: r.tipologia || "Outro", descricao: (r.descricao || "").slice(0, 200), status, obs: obs.slice(0, 200),
    disciplinas, desconto, orcData: r.orcData || hojeISO(), validade: r.validade || "", fechamento: "", entrada: { valor: parcelas[0]?.valor || 0, data: "" }, forma: "Pix", periodicidade: "etapa", nParc: Math.max(0, parcelas.length - 1), parcelas,
    prazoDias: r.prazoDias || 0, prazoUteis: r.prazoUteis !== false, formaTexto: r.formaTexto || "", _avisos: r.avisos || [],
    historico: [{ d: agoraISO(), t: `Cadastrado a partir da proposta de ${r.orcData ? dBR(r.orcData) : "data não informada"}${desconto ? ` — desconto de ${brl(desconto)}` : ""}` }] };
}
const limpar = o => { const x = JSON.parse(JSON.stringify(o)); delete x._avisos; return x; };
let importando = false;
function itensImport() {
  const nomes = new Set(projs.map(p => p.nome)); let ign = []; try { ign = JSON.parse(localStorage.getItem("proj-ign-" + uid) || "[]"); } catch (e) {}
  const ok = n => !nomes.has(n) && !ign.includes(n);
  return [...INICIAIS.filter(x => ok(x.nome)).map(x => ({ nome: x.nome, criar: () => projetoInicial(x), linha: (() => { const t = Object.values(x.disc).reduce((a, b) => a + b, 0); return x.pago ? `${brl(x.pago)} de ${brl(t)}` : `${brl(t)} · nada recebido`; })(), sub: Object.keys(x.disc).join(", ") })),
    ...PROPOSTAS_INICIAIS.map(x => ({ x, p: projetoDeProposta(x.r, x) })).filter(o => ok(o.p.nome)).map(({ x, p }) => { const rr = resumo(p); return { nome: p.nome, criar: () => ({ ...limpar(projetoDeProposta(x.r, x)), atualizadoEm: Date.now(), criadoEm: Date.now() }), linha: x.status === "orcamento" ? `proposta ${brl(rr.fechado)}` : `${brl(rr.recebido)} de ${brl(rr.fechado)}`, sub: STN[p.status] }; })];
}
function renderImport() {
  let c = $("#impCard"); const itens = itensImport();
  if (!itens.length) { c?.remove(); return; }
  if (!c) { c = el("section", "card"); c.id = "impCard"; $("#lista").before(c); }
  c.textContent = "";
  const h = el("div", "card-h"); h.append(el("h2", null, projs.length ? "Novos projetos para importar" : "Importar minha carteira"), el("span", "eyebrow", `${itens.length} item(ns)`)); c.append(h);
  const ul = el("ul", "imp");
  itens.forEach(x => { const li = el("li"); li.append(el("span", null, `${x.nome} — ${x.sub}`), el("span", "num", x.linha)); ul.append(li); });
  c.append(ul, el("p", "note", "Projetos com valor recebido entram “Em execução”; os novos sem entrada entram “Fechado — aguardando liberação”; propostas entram como “Orçamento”. Itens já cadastrados não se repetem."));
  const a = el("div", "bar-actions"), b = el("button", "btn pri", "Importar agora"), n = el("button", "btn", "Dispensar");
  b.onclick = async () => { if (importando) return; importando = true; b.disabled = true;
    try { for (const x of itens) await addDoc(collection(db, "users", uid, "proj"), x.criar()); toast(`${itens.length} item(ns) importado(s).`); }
    catch (e) { falha(e); b.disabled = false; } importando = false; };
  n.onclick = () => { try { const ign = JSON.parse(localStorage.getItem("proj-ign-" + uid) || "[]"); localStorage.setItem("proj-ign-" + uid, JSON.stringify(ign.concat(itens.map(x => x.nome)))); } catch (e) {} c.remove(); };
  a.append(b, n); c.append(a);
}

/* ===== estado ===== */
let uid = null, nome = "", dono = null, donos = [], meuPerfil = {}, tqs = null, unsubProj = null, projs = [], rels = [], filtro = "ativos", aberto = null, edit = null, editId = null, semRef = null;
const subs = [];
const ref = id => doc(db, "users", dono || uid, "proj", id);
const ro = () => !!dono && dono !== uid;

/* ===== cálculos ===== */
export function resumo(p) {
  const ds = p.disciplinas || [];
  const orcado = ds.reduce((s, d) => s + (d.valor || 0), 0);
  const fechado = Math.max(0, orcado - (p.desconto || 0));
  const parc = p.parcelas || [];
  const recebido = parc.filter(x => x.pago).reduce((s, x) => s + x.valor, 0);
  const programado = parc.reduce((s, x) => s + x.valor, 0);
  const h = hojeISO(), abertas = parc.filter(x => !x.pago).sort((a, b) => (a.venc || "9").localeCompare(b.venc || "9"));
  const etapas = ds.flatMap(d => d.etapas || []), feitas = etapas.filter(e => e.ok).length;
  const pr = p.prestadores || [], custo = pr.reduce((s, x) => s + (x.valor || 0), 0), pgs = pr.flatMap(x => (x.pagamentos || []).map(y => ({ ...y, prest: x.nome, disc: x.disc })));
  const pagoPrest = pgs.filter(y => y.pago).reduce((s, y) => s + y.valor, 0);
  return { custo, pagoPrest, aPagar: Math.max(0, custo - pagoPrest), pgsAbertos: pgs.filter(y => !y.pago), margem: fechado - custo, margemPct: fechado ? (fechado - custo) / fechado : 0,
    orcado, fechado, recebido, programado, aReceber: Math.max(0, fechado - recebido), semParcela: Math.max(0, fechado - programado),
    prox: abertas[0] || null, atrasadas: abertas.filter(x => x.venc && x.venc < h), total: etapas.length, feitas, pct: etapas.length ? feitas / etapas.length : 0,
    proxEtapa: ds.map(d => ({ d: d.d, e: (d.etapas || []).find(e => !e.ok) })).filter(x => x.e) };
}
const filtros = { ativos: p => ATIVOS.includes(p.status), propostas: p => ["orcamento", "negociacao"].includes(p.status), concluidos: p => p.status === "concluido", perdidos: p => p.status === "perdido", todos: () => true };

/* ===== painel ===== */
function render() {
  if (!uid) return;
  document.body.classList.toggle("ro", ro()); renderDonos(); renderTqs(); renderShare();
  $("#whoName").textContent = nome ? `Olá, ${nome}` : "—"; $("#sairBtn").textContent = (nome[0] || "?").toUpperCase();
  if (aberto) { const p = projs.find(x => x.id === aberto); if (p && $("#vForm").hidden) renderFicha(p); else if (!p) fecharFicha(); }
  const ativos = projs.filter(filtros.ativos), prop = projs.filter(filtros.propostas);
  const fech = projs.filter(p => ["fechado", "execucao", "entregue", "concluido"].includes(p.status)).length, perd = projs.filter(filtros.perdidos).length;
  const k = $("#kpis"); k.textContent = "";
  [["Propostas em aberto", String(prop.length), brl(prop.reduce((s, p) => s + resumo(p).fechado, 0)) + " orçados"],
   ["Em andamento", String(ativos.length), brl(ativos.reduce((s, p) => s + resumo(p).fechado, 0)) + " fechados"],
   ["A receber", brl(projs.filter(p => p.status !== "perdido").reduce((s, p) => s + resumo(p).aReceber, 0)), `${projs.reduce((s, p) => s + resumo(p).atrasadas.length, 0)} atrasada(s) · a pagar prestadores ${brl(projs.filter(p => p.status !== "perdido").reduce((s, p) => s + resumo(p).aPagar, 0))}`],
   ["Taxa de fechamento", fech + perd ? Math.round(fech / (fech + perd) * 100) + "%" : "—", `${fech} fechado(s) · ${perd} não fechado(s)`]]
    .forEach(([a, b, c]) => { const d = el("div"); d.append(el("span", null, a), el("b", null, b), el("small", null, c)); k.append(d); });
  renderAgenda();
  const fl = $("#filtro"); fl.textContent = "";
  [["ativos", `Em andamento (${ativos.length})`], ["propostas", `Propostas (${prop.length})`], ["concluidos", "Concluídos"], ["perdidos", "Não fechados"], ["todos", "Todos"]].forEach(([id, n]) => {
    const b = el("button", "chip", n); b.setAttribute("aria-pressed", String(filtro === id)); b.onclick = () => { filtro = id; render(); }; fl.append(b); });
  const vis = projs.filter(filtros[filtro]), todosAbertos = vis.length && vis.every(p => abertosCard.has(p.id));
  const tg = el("button", "chip", todosAbertos ? "Recolher todos ▴" : "Expandir todos ▾"); tg.type = "button";
  tg.onclick = () => { vis.forEach(p => todosAbertos ? abertosCard.delete(p.id) : abertosCard.add(p.id)); salvarAbertos(); render(); }; if (vis.length) fl.append(tg);
  const box = $("#lista"); box.textContent = "";
  const lst = projs.filter(filtros[filtro]).sort((a, b) => (a.prazo || "9999").localeCompare(b.prazo || "9999") || (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
  if (!lst.length) { const e = el("div", "empty"); e.append(el("strong", null, projs.length ? "Nenhum projeto neste filtro" : "Nenhum projeto cadastrado"), "Toque em “+ Novo projeto” para lançar os dados, o orçamento, o fechamento e as etapas."); box.append(e); }
  lst.forEach(p => box.append(cartao(p)));
  renderSemana(); renderRels(); renderImport();
}
function renderAgenda() {
  const h = hojeISO(), ate = addDias(h, 15), it = [];
  projs.forEach(p => {
    if (p.status === "perdido" || p.status === "concluido") return;
    if (p.prazo && ATIVOS.slice(0, 2).includes(p.status) && p.prazo <= ate) it.push({ d: p.prazo, tag: p.prazo < h ? ["late", "Entrega atrasada"] : ["ent", "Entrega"], t: p.nome, m: p.cliente || "", id: p.id });
    (p.parcelas || []).filter(x => !x.pago && x.venc && x.venc <= ate).forEach(x => it.push({ d: x.venc, tag: x.venc < h ? ["late", "Parcela atrasada"] : ["par", "Parcela"], t: `${x.desc || "Parcela"} — ${brl(x.valor)}`, m: p.nome, id: p.id }));
    (p.prestadores || []).forEach(x => (x.pagamentos || []).filter(y => !y.pago && y.venc && y.venc <= ate).forEach(y => it.push({ d: y.venc, tag: y.venc < h ? ["late", "Pagar prestador (atrasado)"] : ["ent", "Pagar prestador"], t: `${x.nome} — ${y.desc || "pagamento"} — ${brl(y.valor)}`, m: p.nome, id: p.id })));
    if (["orcamento", "negociacao"].includes(p.status) && p.validade && p.validade >= h && p.validade <= ate) it.push({ d: p.validade, tag: ["orc", "Validade do orçamento"], t: p.nome, m: brl(resumo(p).fechado), id: p.id });
  });
  it.sort((a, b) => a.d.localeCompare(b.d));
  $("#agendaCard").hidden = !it.length; const box = $("#agenda"); box.textContent = "";
  it.forEach(x => { const r = el("div", "ag"); const dd = difDias(h, x.d);
    r.append(el("span", "ag-tag " + x.tag[0], x.tag[1]), Object.assign(el("div"), {}), el("span", "num", dd < 0 ? `${-dd}d atrás` : dd === 0 ? "hoje" : dm(x.d)));
    r.children[1].append(el("span", "d", x.t), el("span", "m", x.m)); r.style.cursor = "pointer"; r.onclick = () => abrirFicha(x.id); box.append(r); });
}
const abertosCard = new Set((() => { try { return JSON.parse(localStorage.getItem("proj-abertos") || "[]"); } catch (e) { return []; } })());
const salvarAbertos = () => { try { localStorage.setItem("proj-abertos", JSON.stringify([...abertosCard])); } catch (e) {} };
function cartao(p) {
  const r = resumo(p), h = hojeISO(), aberto = abertosCard.has(p.id), c = el("section", "card pp" + (aberto ? " open" : ""));
  const alternar = () => { aberto ? abertosCard.delete(p.id) : abertosCard.add(p.id); salvarAbertos(); render(); };
  /* cabeçalho — toque para expandir/recolher */
  const top = el("button", "pp-top pp-tog"); top.type = "button"; top.setAttribute("aria-expanded", String(aberto)); top.onclick = alternar;
  const t = el("div", "pp-tit"); t.append(el("h2", "pp-nome", p.nome), el("div", "pp-meta", [p.cliente, p.local].filter(Boolean).join(" · ") || (p.disciplinas || []).map(d => d.d).join(", ")));
  const dir = el("div", "pp-dir"); dir.append(el("span", "st st-" + p.status, STN[p.status]), el("span", "chev", "▾"));
  top.append(t, dir); c.append(top);
  /* resumo (sempre visível) */
  const rs = el("div", "pp-res");
  const bar = el("div", "mini"), bi = el("i"); bi.style.width = Math.round(r.pct * 100) + "%"; bar.append(bi);
  const lin = el("div", "pp-res-l"); lin.append(el("span", null, r.total ? `${r.feitas} de ${r.total} etapas` + (r.proxEtapa[0] ? ` · próxima: ${r.proxEtapa[0].e.t}` : " · concluídas") : "Sem etapas"), el("span", "num", Math.round(r.pct * 100) + "%"));
  rs.append(bar, lin); c.append(rs);
  if (r.atrasadas.length) c.append(el("div", "pp-alert late", `${r.atrasadas.length} parcela(s) atrasada(s) — ${brl(r.atrasadas.reduce((s, x) => s + x.valor, 0))}`));
  const sp = situacaoPrazo(p);
  if (sp && !["entregue", "concluido"].includes(p.status)) c.append(el("div", "pp-alert " + (sp.cls || "info"), "⏱ " + sp.txt));
  else if (!p.liberadoEm && ["fechado", "execucao"].includes(p.status)) { const lb = el("button", "pp-alert soon lib-btn", "Aguardando liberação para cálculo — tocar para liberar"); lb.type = "button"; lb.onclick = () => abrirFicha(p.id); c.append(lb); }
  const f = el("div", "pp-foot");
  const it = (a, b) => { const s = el("span", null, a + " "); s.append(el("b", null, b)); return s; };
  f.append(it(["orcamento", "negociacao"].includes(p.status) ? "Orçado" : "Fechado", brl(r.fechado)), it("Falta receber", brl(r.aReceber)));
  if (r.aPagar) f.append(it("A pagar prestadores", brl(r.aPagar)));
  c.append(f);
  if (!aberto) return c;
  /* detalhe (expandido): checklist feito × falta, prestadores e acesso à ficha */
  (p.disciplinas || []).forEach((d, di) => {
    const fe = d.etapas.filter(e => e.ok).length, tt = d.etapas.length, box = el("div", "pp-chk");
    const hd = el("div", "pp-chk-h"); hd.append(el("b", null, d.d + (d.sistema && d.sistema !== "A definir" ? ` · ${d.sistema}` : "")), el("span", "num", `${fe}/${tt} feitas`));
    const mi = el("div", "mini"), i = el("i"); i.style.width = (tt ? fe / tt * 100 : 0) + "%"; mi.append(i);
    box.append(hd, mi);
    const ul = el("ul", "pp-list");
    d.etapas.forEach((e, ei) => {
      const li = el("li", e.ok ? "ok" : ""), lb = el("label"), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!e.ok;
      cb.onchange = () => { const ds = JSON.parse(JSON.stringify(p.disciplinas)); ds[di].etapas[ei].ok = cb.checked; ds[di].etapas[ei].data = cb.checked ? h : null;
        salvarParcial(p, { disciplinas: ds }, `${cb.checked ? "Concluída" : "Reaberta"}: ${d.d} — ${e.t}`); if (cb.checked) toast(`✓ ${e.t} — ${p.nome}`); };
      lb.append(cb, el("span", null, e.t)); li.append(lb, el("span", e.ok ? "tag-ok" : "tag-falta", e.ok ? (e.data ? "feito " + dm(e.data) : "feito") : "falta")); ul.append(li);
    });
    box.append(ul); c.append(box);
  });
  const f2 = el("div", "pp-foot");
  f2.append(it("Recebido", brl(r.recebido)));
  (p.prestadores || []).forEach(x => { const pago = (x.pagamentos || []).filter(y => y.pago).reduce((s, y) => s + y.valor, 0); f2.append(it(`${x.nome} (${x.disc})`, `pago ${brl(pago)} de ${brl(x.valor)}`)); });
  if (r.custo) f2.append(it("Margem", `${brl(r.margem)} · ${Math.round(r.margemPct * 100)}%`));
  c.append(f2);
  const acts = el("div", "bar-actions pp-acts"), ab = el("button", "btn sm pri", "Abrir ficha completa ›"); ab.type = "button"; ab.onclick = () => abrirFicha(p.id);
  const rc = el("button", "btn sm", "Recolher ▴"); rc.type = "button"; rc.onclick = alternar;
  acts.append(ab, rc); c.append(acts);
  return c;
}

/* ===== liberação para cálculo e contagem do prazo em dias úteis ===== */
function dadosLiberacao(p, data) {
  const d = { liberadoEm: data, inicio: data };
  if (p.prazoDias) d.prazo = somarDias(data, p.prazoDias, p.prazoUteis !== false);
  if (["orcamento", "negociacao", "fechado"].includes(p.status)) d.status = "execucao";
  return d;
}
async function liberar(p, data, dias) {
  const base = { ...p, prazoDias: dias || p.prazoDias || 0 }, extra = dadosLiberacao(base, data);
  const ps = JSON.parse(JSON.stringify(p.parcelas || [])), ent = ps.find(x => x.entrada) || ps[0];
  if (ent && !ent.pago) { ent.pago = true; ent.pagoEm = data; }
  await salvarParcial(p, { ...extra, prazoDias: base.prazoDias, prazoUteis: p.prazoUteis !== false, parcelas: ps },
    `Liberado para cálculo em ${dBR(data)}${ent ? " — entrada recebida" : ""}${extra.prazo ? ` — entrega prevista para ${dBR(extra.prazo)} (${base.prazoDias} dias úteis)` : ""}`);
  toast(extra.prazo ? `Prazo iniciado: entrega em ${dBR(extra.prazo)}` : "Liberado para cálculo.");
}
export function situacaoPrazo(p) {
  const h = hojeISO(), uteis = p.prazoUteis !== false;
  if (!p.liberadoEm) return null;
  if (!p.prazo) return { txt: "Liberado — informe o prazo em dias úteis", cls: "" };
  const total = p.prazoDias || diasUteisEntre(p.liberadoEm, p.prazo), usados = Math.min(total, uteis ? diasUteisEntre(p.liberadoEm, h) : difDias(p.liberadoEm, h));
  const faltam = uteis ? diasUteisEntre(h, p.prazo) : difDias(h, p.prazo), atraso = h > p.prazo ? (uteis ? diasUteisEntre(p.prazo, h) : difDias(p.prazo, h)) : 0;
  const und = uteis ? "úteis" : "corridos";
  if (["entregue", "concluido"].includes(p.status)) return { txt: `Entregue · prazo era ${dBR(p.prazo)}`, cls: "", pct: 1 };
  if (atraso) return { txt: `Prazo vencido há ${atraso} dia(s) ${und} — entrega era ${dBR(p.prazo)}`, cls: "late", pct: 1 };
  return { txt: `Dia ${usados} de ${total} ${und} · faltam ${faltam} · entrega ${dBR(p.prazo)}`, cls: faltam <= 3 ? "soon" : "", pct: total ? usados / total : 0 };
}
function renderPrazo(p) {
  const box = $("#fPrazo"); box.textContent = ""; const h = hojeISO(), sp = situacaoPrazo(p);
  if (!p.liberadoEm) {
    $("#fPrazoTxt").textContent = "aguardando liberação";
    box.append(el("p", "note", "Quando o cliente pagar a entrada, toque em “Liberado para cálculo”: a entrada fica marcada como recebida e o prazo começa a contar em dias úteis."));
    const g = el("div", "lib"), l1 = el("label", "f"), dias = el("input"); dias.type = "number"; dias.min = 1; dias.max = 365; dias.value = p.prazoDias || ""; dias.placeholder = "Ex.: 20"; l1.append("Prazo (dias úteis)", dias);
    const l2 = el("label", "f"), dt = el("input"); dt.type = "date"; dt.value = h; dt.max = h; l2.append("Data da liberação", dt);
    const b = el("button", "btn hot", "Liberado para cálculo ▶"); b.type = "button";
    b.onclick = () => { const n = parseInt(dias.value) || 0; if (!n) { toast("Informe o prazo em dias úteis."); dias.focus(); return; } liberar(p, dt.value || h, n); };
    g.append(l1, l2, b); box.append(g); return;
  }
  $("#fPrazoTxt").textContent = `liberado em ${dBR(p.liberadoEm)}`;
  const bar = el("div", "gauge-bar"), i = el("i"); i.style.width = Math.round((sp?.pct || 0) * 100) + "%"; if (sp?.cls === "late") i.classList.add("over"); bar.append(i);
  box.append(el("div", "lib-st " + (sp?.cls || ""), sp?.txt || ""), bar);
  const des = el("button", "btn sm", "Desfazer liberação"); des.type = "button";
  armar(des, "Desfazer liberação", () => salvarParcial(p, { liberadoEm: null, prazo: "" }, "Liberação para cálculo desfeita"));
  box.append(el("div", "bar-actions"));
  box.lastChild.append(des);
}

/* ===== ficha ===== */
function abrirFicha(id) { aberto = id; ["#vLista", "#vForm"].forEach(s => $(s).hidden = true); $("#vFicha").hidden = false; render(); scrollTo({ top: 0 }); }
function fecharFicha() { aberto = null; $("#vFicha").hidden = true; $("#vForm").hidden = true; $("#vLista").hidden = false; render(); }
async function salvarParcial(p, mud, log) {
  if (ro() && Object.keys(mud).length) { toast("Somente visualização: você pode registrar anotações."); return; }
  const hist = (p.historico || []).concat(log ? [{ d: agoraISO(), t: log }] : []);
  try { await updateDoc(ref(p.id), { ...mud, historico: hist, atualizadoEm: Date.now() }); } catch (e) { falha(e); }
}
function renderFicha(p) {
  const r = resumo(p), h = hojeISO();
  /* topo */
  const hero = $("#fHero"); hero.textContent = "";
  const a = el("div"); a.append(el("h1", null, p.nome), el("div", "sub", [p.cliente, p.local, p.tipologia].filter(Boolean).join(" · ")));
  const sel = el("select"); sel.setAttribute("aria-label", "Situação"); ST.forEach(([k, n]) => { const o = el("option", null, n); o.value = k; sel.append(o); }); sel.value = p.status;
  sel.onchange = () => salvarParcial(p, { status: sel.value, ...(sel.value === "fechado" && !p.fechamento ? { fechamento: h } : {}) }, `Situação alterada para “${STN[sel.value]}”`);
  a.append(sel);
  const C = 2 * Math.PI * 40, pct = r.pct;
  const ring = new DOMParser().parseFromString(`<svg class="ring" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gr" x1="0" x2="1"><stop offset="0" stop-color="#4fb3c6"/><stop offset="1" stop-color="#4cc58c"/></linearGradient></defs><circle class="bg" cx="48" cy="48" r="40" fill="none" stroke-width="8"/><circle class="fg" cx="48" cy="48" r="40" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 48 48)"/><text x="48" y="50" text-anchor="middle" font-size="18">${Math.round(pct * 100)}%</text><text class="s" x="48" y="64" text-anchor="middle">etapas</text></svg>`, "image/svg+xml").documentElement;
  hero.append(a, document.importNode(ring, true));
  $("#fPctTxt").textContent = `${r.feitas} de ${r.total} etapas`;
  renderPrazo(p);
  /* fluxo */
  const pp = $("#fPipe"); pp.textContent = ""; const idx = FLUXO.indexOf(p.status);
  FLUXO.forEach((k, i) => pp.append(el("div", p.status === "perdido" ? "" : i < idx ? "done" : i === idx ? "now" : "", STN[k])));
  if (p.status === "perdido") pp.append(el("div", "lost", "Não fechado"));
  /* disciplinas */
  const dbx = $("#fDisc"); dbx.textContent = "";
  (p.disciplinas || []).forEach((d, di) => {
    const f = d.etapas.filter(e => e.ok).length, box = el("div", "disc-box"), h3 = el("h3"); h3.append(d.d + (d.valor ? " · " + brl(d.valor) : ""), el("span", null, `${f}/${d.etapas.length}`)); box.append(h3);
    if (d.d === "Estrutural") box.append(el("div", "sis", "Sistema estrutural: " + (d.sistema || "A definir")));
    const ul = el("ul", "chk");
    d.etapas.forEach((e, ei) => { const li = el("li", e.ok ? "ok" : ""), lb = el("label"), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!e.ok;
      cb.onchange = () => { const ds = JSON.parse(JSON.stringify(p.disciplinas)); ds[di].etapas[ei].ok = cb.checked; ds[di].etapas[ei].data = cb.checked ? h : null;
        salvarParcial(p, { disciplinas: ds }, `${cb.checked ? "Concluída" : "Reaberta"}: ${d.d} — ${e.t}`); if (cb.checked) toast(`✓ ${e.t}`); };
      lb.append(cb, el("span", null, e.t)); li.append(lb); if (e.ok && e.data) li.append(el("span", "chk-d", dm(e.data))); ul.append(li); });
    box.append(ul); dbx.append(box);
  });
  /* orçamento */
  const g = (alvo, itens) => { alvo.textContent = ""; itens.forEach(([k, v, num]) => { const d = el("div"); d.append(el("span", null, k), el("b", num ? "num" : "", v || "—")); alvo.append(d); }); };
  g($("#fOrc"), [["Valor orçado", brl(r.orcado), 1], ["Desconto", brl(p.desconto || 0), 1], ["Valor fechado", brl(r.fechado), 1], ["Data do orçamento", dBR(p.orcData)], ["Validade", dBR(p.validade)], ["Data de fechamento", dBR(p.fechamento)],
    ["Entrada", p.entrada?.valor ? `${brl(p.entrada.valor)} · ${dBR(p.entrada.data)}` : "—"], ["Parcelamento", (p.parcelas || []).filter(x => !x.entrada).length ? `${(p.parcelas || []).filter(x => !x.entrada).length}× ${({ mensal: "mensal", quinzenal: "quinzenal", etapa: "por etapa" })[p.periodicidade] || ""}` : "—"], ["Forma de pagamento", p.forma || "—"],
    ["Início", dBR(p.inicio)], ["Prazo de entrega", p.prazo ? dBR(p.prazo) : p.prazoDias ? `${p.prazoDias} dias ${p.prazoUteis !== false ? "úteis" : "corridos"} após o sinal` : "—"], ["Recebido / a receber", `${brl(r.recebido)} / ${brl(r.aReceber)}`, 1]]);
  /* parcelas */
  const pb = $("#fParc"); pb.textContent = ""; const pl = p.parcelas || [];
  $("#fParcTxt").textContent = pl.length ? `${pl.filter(x => x.pago).length} de ${pl.length} recebidas` : "";
  if (!pl.length) pb.append(el("p", "note", "Nenhuma parcela lançada. Use “Editar” → Entrada e parcelamento."));
  pl.forEach((x, i) => { const late = !x.pago && x.venc && x.venc < h, row = el("div", "parc" + (x.pago ? " ok" : "") + (late ? " late" : "")), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!x.pago; cb.setAttribute("aria-label", "Recebida");
    cb.onchange = () => { const ps = JSON.parse(JSON.stringify(pl)); ps[i].pago = cb.checked; ps[i].pagoEm = cb.checked ? h : null; const extra = {};
      if (cb.checked && x.entrada && !p.liberadoEm) Object.assign(extra, dadosLiberacao(p, h));
      salvarParcial(p, { parcelas: ps, ...extra }, `${cb.checked ? "Recebida" : "Desmarcada"}: ${x.desc || "parcela"} (${brl(x.valor)})${extra.prazo ? ` — entrega prevista para ${dBR(extra.prazo)}` : ""}`); };
    const t = el("div"); t.append(el("div", "d", x.desc || `Parcela ${i + 1}`), el("div", "m", x.pago ? (x.pagoEm ? `Recebida em ${dBR(x.pagoEm)}` : "Recebido anteriormente") : x.venc ? (late ? `Venceu em ${dBR(x.venc)}` : `Vence em ${dBR(x.venc)}`) : "Sem data"));
    row.append(cb, t, el("span", "v", brl(x.valor))); pb.append(row); });
  if (r.semParcela > 0 && pl.length) pb.append(el("p", "note", `${brl(r.semParcela)} do valor fechado ainda não estão em nenhuma parcela.`));
  /* prestadores */
  const prb = $("#fPrest"); prb.textContent = ""; const prs = p.prestadores || [];
  $("#fPrestTxt").textContent = prs.length ? `${brl(r.pagoPrest)} pagos · ${brl(r.aPagar)} a pagar` : "";
  if (!prs.length) prb.append(el("p", "note", "Nenhum prestador. Use “Editar” → Prestadores para lançar a proposta do Augusto (elétrico e hidro) ou de outro parceiro."));
  prs.forEach((x, xi) => {
    const bx = el("div", "disc-box"), h3 = el("h3"); const pago = (x.pagamentos || []).filter(y => y.pago).reduce((s, y) => s + y.valor, 0);
    h3.append(`${x.nome} · ${x.disc}`, el("span", null, `${brl(pago)} de ${brl(x.valor)}`)); bx.append(h3);
    (x.pagamentos || []).forEach((y, yi) => { const late = !y.pago && y.venc && y.venc < h, row = el("div", "parc" + (y.pago ? " ok" : "") + (late ? " late" : "")), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!y.pago; cb.setAttribute("aria-label", "Pago");
      cb.onchange = () => { const all = JSON.parse(JSON.stringify(prs)); all[xi].pagamentos[yi].pago = cb.checked; all[xi].pagamentos[yi].pagoEm = cb.checked ? h : null;
        salvarParcial(p, { prestadores: all }, `${cb.checked ? "Pago a" : "Desmarcado pagamento a"} ${x.nome}: ${y.desc || "pagamento"} (${brl(y.valor)})`); if (cb.checked) toast(`Baixa: ${brl(y.valor)} pago a ${x.nome}`); };
      const t = el("div"); t.append(el("div", "d", y.desc || `Pagamento ${yi + 1}`), el("div", "m", y.pago ? (y.pagoEm ? `Pago em ${dBR(y.pagoEm)}` : "Pago") : y.venc ? (late ? `Venceu em ${dBR(y.venc)}` : `Pagar até ${dBR(y.venc)}`) : "Sem data"));
      row.append(cb, t, el("span", "v", brl(y.valor))); bx.append(row); });
    prb.append(bx);
  });
  if (prs.length) prb.append(el("p", "note", `Margem do projeto: ${brl(r.fechado)} fechado − ${brl(r.custo)} de prestadores = ${brl(r.margem)} (${Math.round(r.margemPct * 100)}%).`));
  /* dados */
  g($("#fDados"), [["Cliente", p.cliente], ["Contato", p.contato], ["Local", p.local], ["Tipologia", p.tipologia], ["Área", p.area ? `${p.area.toLocaleString("pt-BR")} m²` : ""], ["Pavimentos", p.pav ? String(p.pav) : ""],
    ["Escopo", p.descricao], ["Valor por m²", p.area ? brl(Math.round(r.fechado / p.area)) + "/m²" : "", 1], ["Observações", p.obs]]);
  /* histórico */
  const hl = $("#fHist"); hl.textContent = "";
  const hs = (p.historico || []).slice().reverse();
  if (!hs.length) hl.append(el("li", null, "Sem registros ainda."));
  hs.forEach(x => { const li = el("li"); li.append(el("time", null, x.d.slice(8, 10) + "/" + x.d.slice(5, 7) + " " + x.d.slice(11)), el("span", null, x.t)); hl.append(li); });
  $("#fEditar").onclick = () => abrirForm(p);
  $("#fPdf").onclick = () => pdfProjetos([p]).catch(falha);
  $("#fNotaAdd").onclick = () => { const v = $("#fNota").value.trim(); if (!v) return; $("#fNota").value = ""; salvarParcial(p, {}, `Anotação${ro() ? " (" + nome + ")" : ""}: ` + v); };
  sel.disabled = ro();
}
$("#voltar").onclick = fecharFicha;

/* ===== formulário ===== */
function modelo() { const h = hojeISO(); return { nome: "", cliente: "", contato: "", local: "", tipologia: "Residencial unifamiliar", area: 0, pav: 0, descricao: "", status: "orcamento", obs: "",
  disciplinas: ["Estrutural", "Elétrico", "Hidrossanitário"].map(novaDisc), desconto: 0, orcData: h, validade: addDias(h, 15), fechamento: "", inicio: "", prazo: "",
  entrada: { valor: 0, data: "" }, forma: "Pix", periodicidade: "mensal", nParc: 0, primeiro: "", parcelas: [], historico: [] }; }
function abrirForm(p, base) {
  editId = p ? p.id : null; edit = JSON.parse(JSON.stringify(base ? base : p ? (({ id, ...x }) => x)(p) : modelo()));
  const av = $("#formAviso"); av.hidden = !base; av.textContent = "";
  if (base) { av.append(el("b", null, "Lido da proposta — confira antes de salvar.")); [...(base._avisos || []), base.prazoDias ? `Prazo contratual: ${base.prazoDias} dias ${base.prazoUteis ? "úteis" : "corridos"} após o sinal — a data de entrega é calculada quando você marcar o sinal como recebido.` : ""].filter(Boolean).forEach(t => av.append(el("span", null, "• " + t))); }
  ["#vLista", "#vFicha"].forEach(s => $(s).hidden = true); $("#vForm").hidden = false; scrollTo({ top: 0 });
  $("#formTit").textContent = p ? "Editar projeto" : "Novo projeto"; $("#excluir").hidden = !p;
  const set = (id, v) => $(id).value = v ?? "";
  set("#pNome", edit.nome); set("#pCliente", edit.cliente); set("#pContato", edit.contato); set("#pLocal", edit.local); set("#pTipo", edit.tipologia);
  set("#pArea", edit.area ? String(edit.area).replace(".", ",") : ""); set("#pPav", edit.pav || ""); set("#pDesc", edit.descricao);
  set("#oPrazoDias", edit.prazoDias || ""); set("#oData", edit.orcData); set("#oValid", edit.validade); set("#oDesc", edit.desconto ? fmtIn(edit.desconto) : ""); set("#oFechData", edit.fechamento); set("#oInicio", edit.inicio); set("#oPrazo", edit.prazo);
  set("#eValor", edit.entrada?.valor ? fmtIn(edit.entrada.valor) : ""); set("#eData", edit.entrada?.data); set("#eForma", edit.forma); set("#eN", edit.nParc || 0); set("#ePer", edit.periodicidade || "mensal"); set("#e1", edit.primeiro);
  const s = $("#pStatus"); s.textContent = ""; ST.forEach(([k, n]) => { const o = el("option", null, n); o.value = k; s.append(o); }); s.value = edit.status; set("#pObs", edit.obs);
  desenharDisc(); desenharParc(); desenharPrest(); calc();
}
function lerForm() {
  const v = id => $(id).value.trim();
  Object.assign(edit, { nome: v("#pNome"), cliente: v("#pCliente"), contato: v("#pContato"), local: v("#pLocal"), tipologia: $("#pTipo").value,
    area: parseFloat(v("#pArea").replace(/\./g, "").replace(",", ".")) || 0, pav: parseInt(v("#pPav")) || 0, descricao: v("#pDesc"),
    orcData: $("#oData").value, validade: $("#oValid").value, desconto: parseValor(v("#oDesc")) || 0, fechamento: $("#oFechData").value, inicio: $("#oInicio").value, prazo: $("#oPrazo").value,
    entrada: { valor: parseValor(v("#eValor")) || 0, data: $("#eData").value }, forma: $("#eForma").value, nParc: parseInt($("#eN").value) || 0, periodicidade: $("#ePer").value, primeiro: $("#e1").value,
    status: $("#pStatus").value, obs: v("#pObs"), prazoDias: parseInt($("#oPrazoDias").value) || 0 });
}
function calc() {
  const orc = edit.disciplinas.reduce((s, d) => s + (d.valor || 0), 0), desc = parseValor($("#oDesc").value) || 0, fech = Math.max(0, orc - desc);
  $("#oOrcado").value = brl(orc); $("#oFechado").value = brl(fech);
  const ent = parseValor($("#eValor").value) || 0, n = parseInt($("#eN").value) || 0, saldo = Math.max(0, fech - ent);
  const prog = edit.parcelas.reduce((s, x) => s + (x.valor || 0), 0), custo = (edit.prestadores || []).reduce((s, x) => s + (x.valor || 0), 0);
  if ($("#prCalc")) $("#prCalc").textContent = custo ? `Prestadores: ${brl(custo)} · margem ${brl(fech - custo)} (${fech ? Math.round((fech - custo) / fech * 100) : 0}%)` : "";
  $("#eCalc").textContent = `Valor fechado ${brl(fech)} · entrada ${brl(ent)} (${fech ? Math.round(ent / fech * 100) : 0}%) · saldo ${brl(saldo)}${n ? ` em ${n}× de ${brl(Math.floor(saldo / n))}` : ""}` + (edit.parcelas.length ? ` · parcelas lançadas: ${brl(prog)}${prog !== fech ? " (diferença " + brl(fech - prog) + ")" : " ✓"}` : "");
}
function desenharDisc() {
  const ch = $("#pDisc"); ch.textContent = "";
  Object.keys(DISCIPLINAS).forEach(d => { const tem = edit.disciplinas.some(x => x.d === d), b = el("button", "chip", (tem ? "✓ " : "+ ") + d); b.type = "button"; b.setAttribute("aria-pressed", String(tem));
    b.onclick = () => { lerForm(); if (tem) { if (edit.disciplinas.find(x => x.d === d).etapas.some(e => e.ok) && !b.dataset.c) { b.dataset.c = 1; b.textContent = "Remover " + d + "?"; return; } edit.disciplinas = edit.disciplinas.filter(x => x.d !== d); } else edit.disciplinas.push(novaDisc(d)); desenharDisc(); calc(); };
    ch.append(b); });
  const box = $("#pDiscBox"); box.textContent = "";
  edit.disciplinas.forEach((d, di) => {
    const sec = el("div", "pj-sec"), h = el("div", "pj-sec-h"); h.append(el("b", null, d.d));
    const lv = el("label", "f inline-f"); lv.append("Valor (R$)"); const iv = el("input", "valor"); iv.inputMode = "decimal"; iv.placeholder = "0,00"; iv.value = d.valor ? fmtIn(d.valor) : ""; iv.oninput = () => { d.valor = parseValor(iv.value) || 0; calc(); }; lv.append(iv); h.append(lv); sec.append(h);
    if (d.d === "Estrutural") sec.append(configEstrutural(d));
    const ul = el("ul", "chk");
    d.etapas.forEach((e, ei) => { const li = el("li"), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!e.ok; cb.onchange = () => { e.ok = cb.checked; e.data = cb.checked ? (e.data || hojeISO()) : null; };
      const tx = el("input", "chk-t"); tx.value = e.t; tx.maxLength = 80; tx.oninput = () => e.t = tx.value;
      const rm = el("button", "x", "×"); rm.type = "button"; rm.title = "Remover etapa"; rm.onclick = () => { lerForm(); d.etapas.splice(ei, 1); desenharDisc(); };
      li.append(cb, tx, rm); ul.append(li); });
    sec.append(ul);
    const add = el("button", "btn sm", "+ Etapa"); add.type = "button"; add.onclick = () => { lerForm(); d.etapas.push({ t: "Nova etapa", ok: false, data: null }); desenharDisc(); setTimeout(() => { const ins = $("#pDiscBox").querySelectorAll(".pj-sec")[di].querySelectorAll(".chk-t"); ins[ins.length - 1]?.select(); }); };
    sec.append(add); box.append(sec);
  });
}
function configEstrutural(d) {
  d.config = { ...CFG_PADRAO, ...(d.config || {}) };
  const cf = d.config, box = el("div", "cfg"), regen = () => { lerForm(); d.etapas = mesclar(etapasEstrutural(cf, d.sistema), d.etapas); desenharDisc(); };
  box.append(el("p", "cfg-t", "Responda para montar o checklist:"));
  const q = (rot, ctrl) => { const l = el("label", "f"); l.append(rot, ctrl); box.append(l); };
  const sel = (ops, val, on) => { const s = el("select"); ops.forEach(([v, n]) => { const o = el("option", null, n); o.value = v; s.append(o); }); s.value = val; s.onchange = () => on(s.value); return s; };
  q("1. Vai ser calculado no TQS?", sel([["alugar", "Sim — precisa alugar a licença"], ["propria", "Sim — licença já disponível"], ["nao", "Não — outro software"]], cf.tqs, v => { cf.tqs = v; regen(); }));
  q("2. Sistema estrutural — metálico ou concreto?", sel(SISTEMAS.map(x => [x, x]), d.sistema || "A definir", v => { d.sistema = v; regen(); }));
  const fl = el("div", "f"); fl.append("3. Fundação (pode marcar mais de uma)"); const ch = el("div", "chips");
  FUNDACOES.forEach(f => { const on = cf.fund.includes(f), b = el("button", "chip", (on ? "✓ " : "") + f); b.type = "button"; b.setAttribute("aria-pressed", String(on));
    b.onclick = () => { cf.fund = on ? cf.fund.filter(x => x !== f) : cf.fund.concat(f).sort((a, b) => FUNDACOES.indexOf(a) - FUNDACOES.indexOf(b)); regen(); }; ch.append(b); });
  fl.append(ch); box.append(fl);
  const np = el("input"); np.type = "number"; np.min = 1; np.max = 30; np.value = cf.npav; np.onchange = () => { cf.npav = Math.max(1, Math.min(30, parseInt(np.value) || 1)); regen(); };
  q("4. Quantos pavimentos? (gera vigas e lajes de cada pavimento)", np);
  const sn = (rot, k) => q(rot, sel([["1", "Sim"], ["0", "Não"]], cf[k] ? "1" : "0", v => { cf[k] = v === "1"; regen(); }));
  sn("5. Tem elementos de coberta (vigas e lajes)?", "coberta"); sn("6. Tem escada?", "escada"); sn("7. Tem rampa?", "rampa"); sn("8. Tem piscina?", "piscina");
  sn("9. Tem reservatório superior?", "rsup"); sn("10. Tem reservatório inferior?", "rinf");
  box.append(el("p", "note", `Checklist gerado: ${d.etapas.length} etapas. Você ainda pode renomear, excluir ou incluir etapas abaixo.`));
  return box;
}
const FORMAS_PREST = [["50-50", "50% no início + 50% na entrega"], ["avista", "À vista"], ["2x", "2 parcelas iguais"], ["3x", "3 parcelas iguais"]];
function desenharPrest() {
  const box = $("#prBox"); box.textContent = ""; edit.prestadores ||= [];
  edit.prestadores.forEach((x, xi) => {
    const sec = el("div", "pj-sec"), g = el("div", "grid");
    const f = (rot, ctrl, full) => { const l = el("label", "f" + (full ? " full" : "")); l.append(rot, ctrl); g.append(l); };
    const nm = el("input"); nm.maxLength = 40; nm.value = x.nome || ""; nm.setAttribute("list", "dlPrest"); nm.oninput = () => x.nome = nm.value; f("Prestador", nm);
    const ds = el("select"); ["Elétrico", "Hidrossanitário", "Elétrico + Hidrossanitário", "Desenho (desenhista)", "Estrutural", "Outra"].forEach(o => ds.append(el("option", null, o))); ds.value = x.disc || "Elétrico"; ds.onchange = () => x.disc = ds.value; f("Disciplina", ds);
    const vl = el("input", "valor"); vl.inputMode = "decimal"; vl.placeholder = "0,00"; vl.value = x.valor ? fmtIn(x.valor) : ""; vl.oninput = () => { x.valor = parseValor(vl.value) || 0; calc(); }; f("Valor da proposta dele (R$)", vl);
    const fm = el("select"); FORMAS_PREST.forEach(([v, n]) => { const o = el("option", null, n); o.value = v; fm.append(o); }); fm.value = x.forma || "50-50"; fm.onchange = () => x.forma = fm.value; f("Como você paga", fm);
    sec.append(g);
    const rows = el("div", "pj-rows");
    (x.pagamentos || []).forEach((y, yi) => {
      const row = el("div", "pj-row"), d = el("input"); d.placeholder = "Descrição"; d.maxLength = 50; d.value = y.desc || ""; d.oninput = () => y.desc = d.value;
      const v = el("input", "valor"); v.inputMode = "decimal"; v.value = y.valor ? fmtIn(y.valor) : ""; v.oninput = () => y.valor = parseValor(v.value) || 0;
      const dt = el("input"); dt.type = "date"; dt.value = y.venc || ""; dt.oninput = () => y.venc = dt.value;
      const lb = el("label", "check sm"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!y.pago; cb.onchange = () => { y.pago = cb.checked; y.pagoEm = cb.checked ? (y.pagoEm || hojeISO()) : null; }; lb.append(cb, "Pago");
      const rm = el("button", "x", "×"); rm.type = "button"; rm.onclick = () => { x.pagamentos.splice(yi, 1); desenharPrest(); };
      row.append(d, v, dt, lb, rm); rows.append(row); });
    sec.append(rows);
    const acts = el("div", "bar-actions"), gr = el("button", "btn sm", "Gerar pagamentos"); gr.type = "button";
    gr.onclick = () => { if (!x.valor) { toast("Informe o valor da proposta do prestador."); vl.focus(); return; }
      const v = x.valor, mk = (desc, val) => ({ desc, valor: val, venc: "", pago: false });
      x.pagamentos = x.forma === "avista" ? [mk("À vista", v)] : x.forma === "2x" ? [mk("1ª parcela", Math.round(v / 2)), mk("2ª parcela", v - Math.round(v / 2))]
        : x.forma === "3x" ? [mk("1ª parcela", Math.floor(v / 3)), mk("2ª parcela", Math.floor(v / 3)), mk("3ª parcela", v - 2 * Math.floor(v / 3))] : [mk("50% no início", Math.round(v / 2)), mk("50% na entrega", v - Math.round(v / 2))];
      desenharPrest(); };
    const rm = el("button", "btn sm danger", "Remover prestador"); rm.type = "button"; rm.onclick = () => { edit.prestadores.splice(xi, 1); desenharPrest(); calc(); };
    acts.append(gr, rm); sec.append(acts); box.append(sec);
  });
}
$("#prAdd").onclick = () => { edit.prestadores ||= []; const tem = d => edit.disciplinas.some(x => x.d === d);
  const disc = tem("Elétrico") && tem("Hidrossanitário") ? "Elétrico + Hidrossanitário" : tem("Elétrico") ? "Elétrico" : tem("Hidrossanitário") ? "Hidrossanitário" : "Outra";
  edit.prestadores.push({ nome: "Augusto", disc, valor: 0, forma: "50-50", pagamentos: [] }); desenharPrest(); };
$("#prDes").onclick = () => { edit.prestadores ||= []; edit.prestadores.push({ nome: "", disc: "Desenho (desenhista)", valor: 0, forma: "avista", pagamentos: [] }); desenharPrest(); setTimeout(() => { const ins = $("#prBox").querySelectorAll(".pj-sec"); ins[ins.length - 1]?.querySelector("input")?.focus(); }); };
function desenharParc() {
  const box = $("#eParc"); box.textContent = "";
  edit.parcelas.forEach((x, i) => {
    const row = el("div", "pj-row");
    const d = el("input"); d.placeholder = "Descrição"; d.maxLength = 50; d.value = x.desc || ""; d.oninput = () => x.desc = d.value;
    const v = el("input", "valor"); v.inputMode = "decimal"; v.placeholder = "Valor"; v.value = x.valor ? fmtIn(x.valor) : ""; v.oninput = () => { x.valor = parseValor(v.value) || 0; calc(); };
    const dt = el("input"); dt.type = "date"; dt.value = x.venc || ""; dt.oninput = () => x.venc = dt.value;
    const lb = el("label", "check sm"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!x.pago; cb.onchange = () => { x.pago = cb.checked; x.pagoEm = cb.checked ? (x.pagoEm || hojeISO()) : null; }; lb.append(cb, "Recebida");
    const rm = el("button", "x", "×"); rm.type = "button"; rm.onclick = () => { edit.parcelas.splice(i, 1); desenharParc(); calc(); };
    row.append(d, v, dt, lb, rm); box.append(row);
  });
}
$("#eGerar").onclick = () => {
  lerForm();
  const orc = edit.disciplinas.reduce((s, d) => s + (d.valor || 0), 0), fech = Math.max(0, orc - edit.desconto), ent = edit.entrada.valor, n = edit.nParc, saldo = Math.max(0, fech - ent);
  if (!fech) { toast("Informe primeiro os valores das disciplinas."); return; }
  if (edit.parcelas.some(x => x.pago) && !$("#eGerar").dataset.c) { $("#eGerar").dataset.c = 1; $("#eGerar").textContent = "Substituir parcelas (há recebidas)?"; setTimeout(() => { delete $("#eGerar").dataset.c; $("#eGerar").textContent = "Gerar parcelas"; }, 4000); return; }
  delete $("#eGerar").dataset.c; $("#eGerar").textContent = "Gerar parcelas";
  const ps = [];
  if (ent) ps.push({ desc: "Entrada", valor: ent, venc: edit.entrada.data || edit.fechamento || hojeISO(), pago: false, entrada: true });
  const base = edit.primeiro || addMeses(edit.entrada.data || hojeISO(), 1), p1 = n ? Math.floor(saldo / n) : 0;
  const nomesEtapa = edit.disciplinas.flatMap(d => [`Entrega ${d.d.toLowerCase()}`]);
  for (let i = 0; i < n; i++) {
    const venc = edit.periodicidade === "mensal" ? addMeses(base, i) : edit.periodicidade === "quinzenal" ? addDias(base, 15 * i) : (i === 0 ? base : "");
    ps.push({ desc: edit.periodicidade === "etapa" ? (nomesEtapa[i] || `Parcela ${i + 1}`) : `Parcela ${i + 1}/${n}`, valor: i === n - 1 ? saldo - p1 * (n - 1) : p1, venc, pago: false });
  }
  edit.parcelas = ps; desenharParc(); calc(); toast(`${ps.length} parcela(s) geradas. Ajuste valores e datas se precisar.`);
};
$("#eAdd").onclick = () => { edit.parcelas.push({ desc: "", valor: 0, venc: "", pago: false }); desenharParc(); };
["#oDesc", "#eValor", "#eN"].forEach(s => $(s).addEventListener("input", calc));
$("#novo").onclick = () => abrirForm(null);
const cancelar = () => { $("#vForm").hidden = true; edit = null; if (editId && projs.some(p => p.id === editId)) abrirFicha(editId); else fecharFicha(); editId = null; };
$("#cancelar").onclick = cancelar; $("#cancelar2").onclick = cancelar;
$("#vForm").addEventListener("submit", async ev => {
  ev.preventDefault(); lerForm();
  if (!edit.nome) { toast("Informe o nome do projeto."); $("#pNome").focus(); return; }
  if (!edit.disciplinas.length) { toast("Escolha pelo menos uma disciplina."); return; }
  edit.disciplinas.forEach(d => d.etapas = d.etapas.filter(e => e.t.trim()));
  edit.parcelas = edit.parcelas.filter(x => x.valor > 0);
  edit.prestadores = (edit.prestadores || []).filter(x => x.valor > 0).map(x => ({ ...x, nome: (x.nome || "Prestador").trim(), pagamentos: (x.pagamentos || []).filter(y => y.valor > 0) }));
  const antes = editId ? projs.find(p => p.id === editId) : null;
  const log = !antes ? "Projeto cadastrado" : antes.status !== edit.status ? `Situação alterada para “${STN[edit.status]}”` : "Dados do projeto atualizados";
  if (edit.status === "fechado" && !edit.fechamento) edit.fechamento = hojeISO();
  edit.historico = (edit.historico || []).concat([{ d: agoraISO(), t: log }]);
  if (!edit.prazo && edit.prazoDias && edit.entrada?.data) edit.prazo = somarDias(edit.entrada.data, edit.prazoDias, edit.prazoUteis);
  const dados = { ...limpar(edit), atualizadoEm: Date.now() };
  $("#salvar").disabled = true;
  try {
    let id = editId;
    if (editId) await updateDoc(ref(editId), dados); else id = (await addDoc(collection(db, "users", uid, "proj"), { ...dados, criadoEm: Date.now() })).id;
    toast(editId ? "Projeto atualizado." : "Projeto cadastrado."); edit = null; editId = null; $("#vForm").hidden = true; abrirFicha(id);
  } catch (e) { falha(e); }
  $("#salvar").disabled = false;
});
armar($("#excluir"), "Excluir projeto", async () => { try { await deleteDoc(ref(editId)); toast("Projeto excluído."); edit = null; editId = null; fecharFicha(); } catch (e) { falha(e); } });

/* ===== ler proposta (PDF, Word ou foto) ===== */
let lidas = [];
$("#lerBtn").onclick = () => { $("#lerIn").value = ""; $("#lerIn").click(); };
$("#lerIn").onchange = async () => {
  const fs = [...$("#lerIn").files]; if (!fs.length) return;
  const card = $("#propCard"); card.hidden = false; card.scrollIntoView({ block: "nearest", behavior: "smooth" }); $("#propList").textContent = ""; $("#propMsg").textContent = "Lendo…"; lidas = [];
  for (const f of fs) {
    try { const t = await lerArquivo(f, m => $("#propMsg").textContent = `${f.name}: ${m}`); lidas.push({ arquivo: f.name, r: interpretarProposta(t), status: "orcamento", pagos: 0, desconto: 0 }); }
    catch (e) { console.error(e); lidas.push({ arquivo: f.name, erro: e.message === "formato" ? "Formato não suportado (use PDF, Word .docx ou foto)." : e.message === "sem_internet" ? "Sem internet para carregar o leitor." : "Não foi possível ler este arquivo." }); }
  }
  renderLidas();
};
function renderLidas() {
  const box = $("#propList"); box.textContent = ""; const ok = lidas.filter(x => !x.erro);
  $("#propMsg").textContent = `${ok.length} de ${lidas.length} proposta(s) lida(s). Confira, escolha a situação e cadastre.`;
  lidas.forEach((x, i) => {
    const row = el("div", "prop");
    if (x.erro) { row.append(el("b", null, x.arquivo), el("span", "err", x.erro)); box.append(row); return; }
    const p = projetoDeProposta(x.r, x), r = resumo(p);
    const t = el("div", "prop-t"); t.append(el("b", null, p.nome), el("span", null, [p.cliente, p.local, Object.keys(x.r.disciplinas).join(", ")].filter(Boolean).join(" · ")));
    const info = el("div", "prop-i"); info.append(el("span", "num", brl(r.fechado)), el("span", null, x.r.prazoDias ? `${x.r.prazoDias} dias ${x.r.prazoUteis ? "úteis" : "corridos"}` : "prazo ?"), el("span", null, (x.r.pagamento || []).map(q => q.pct + "%").join(" + ") || "pagamento ?"));
    if (x.r.avisos.length) info.append(el("span", "warn", `${x.r.avisos.length} ponto(s) a conferir`));
    const ctl = el("div", "prop-c"), sel = el("select");
    [["orcamento", "Proposta (orçamento)"], ["fechado", "Aprovada — aguardando sinal"], ["execucao", "Aprovada — sinal recebido"]].forEach(([v, n]) => { const o = el("option", null, n); o.value = v; sel.append(o); });
    sel.value = x.pagos ? "execucao" : x.status; sel.onchange = () => { x.status = sel.value === "execucao" ? "execucao" : sel.value; x.pagos = sel.value === "execucao" ? 1 : 0; };
    const ds = el("input", "valor"); ds.inputMode = "decimal"; ds.placeholder = "Desconto R$"; ds.value = x.desconto ? fmtIn(x.desconto) : ""; ds.oninput = () => x.desconto = parseValor(ds.value) || 0;
    const rv = el("button", "btn sm", "Revisar e salvar"); rv.type = "button"; rv.onclick = () => { abrirForm(null, projetoDeProposta(x.r, x)); };
    ctl.append(sel, ds, rv); row.append(t, info, ctl); box.append(row);
  });
  $("#propTodas").hidden = ok.length < 1;
}
$("#propTodas").onclick = async () => {
  const ok = lidas.filter(x => !x.erro); $("#propTodas").disabled = true;
  try { for (const x of ok) await addDoc(collection(db, "users", uid, "proj"), { ...limpar(projetoDeProposta(x.r, x)), atualizadoEm: Date.now(), criadoEm: Date.now() }); toast(`${ok.length} cadastrada(s).`); $("#propCard").hidden = true; lidas = []; }
  catch (e) { falha(e); } $("#propTodas").disabled = false;
};
$("#propFechar").onclick = () => { $("#propCard").hidden = true; lidas = []; };

/* ===== relatório semanal ===== */
function semanaPadrao() { const s = segunda(hojeISO()), ant = addDias(s, -7), wd = (new Date().getDay() + 6) % 7; return wd <= 2 && !rels.some(r => r.id === ant) ? ant : s; }
function montarSemana(ini) {
  const fim = addDias(ini, 6), dentro = d => d && d.slice(0, 10) >= ini && d.slice(0, 10) <= fim, etapas = [], receb = [], mov = [], pagos = [];
  projs.forEach(p => {
    (p.disciplinas || []).forEach(d => d.etapas.forEach(e => { if (e.ok && dentro(e.data)) etapas.push({ data: e.data, proj: p.nome, disc: d.d, etapa: e.t }); }));
    (p.parcelas || []).forEach(x => { if (x.pago && dentro(x.pagoEm)) receb.push({ data: x.pagoEm, proj: p.nome, desc: x.desc || "Parcela", valor: x.valor }); });
    (p.historico || []).forEach(h => { if (dentro(h.d) && /^Situação|^Projeto cadastrado|^Anotação|^Liberado/.test(h.t)) mov.push({ data: h.d.slice(0, 10), proj: p.nome, t: h.t }); });
    (p.prestadores || []).forEach(x => (x.pagamentos || []).forEach(y => { if (y.pago && dentro(y.pagoEm)) pagos.push({ data: y.pagoEm, proj: p.nome, desc: `${x.nome} — ${y.desc || "pagamento"}`, valor: y.valor }); }));
  });
  const ate = addDias(hojeISO(), 15), venc = [];
  projs.forEach(p => (p.parcelas || []).forEach(x => { if (!x.pago && x.venc && x.venc <= ate && p.status !== "perdido") venc.push({ data: x.venc, proj: p.nome, desc: x.desc || "Parcela", valor: x.valor }); }));
  const ativos = projs.filter(p => ["orcamento", "negociacao", ...ATIVOS].includes(p.status)).map(p => { const r = resumo(p); return { nome: p.nome, cliente: p.cliente || "", status: STN[p.status], pct: Math.round(r.pct * 100), prox: r.proxEtapa.map(x => `${x.d}: ${x.e.t}`).join(" · "), prazo: p.prazo || "", fechado: r.fechado, aReceber: r.aReceber }; });
  const s = a => a.sort((x, y) => x.data.localeCompare(y.data));
  return { id: ini, ini, fim, nome, etapas: s(etapas), receb: s(receb), mov: s(mov), venc: s(venc), pagos: s(pagos), totalPagos: pagos.reduce((t, x) => t + x.valor, 0), projetos: ativos, totalReceb: receb.reduce((t, x) => t + x.valor, 0) };
}
function renderSemana() {
  if (!semRef) semRef = semanaPadrao();
  const r = montarSemana(semRef), atual = semRef === segunda(hojeISO()), arq = rels.find(x => x.id === semRef);
  $("#semPer").textContent = `${atual ? "esta semana" : "semana passada"} · ${dm(r.ini)} a ${dm(r.fim)}`;
  $("#semResumo").textContent = `${r.etapas.length} etapa(s) concluída(s), ${r.receb.length} recebimento(s) somando ${brl(r.totalReceb)}, ${r.mov.length} movimentação(ões) e ${r.venc.length} parcela(s) a vencer nos próximos 15 dias.`;
  $("#semPdf").textContent = arq ? "Baixar PDF (arquivado)" : "Gerar PDF e arquivar";
  let tg = $("#semTg"); if (!tg) { tg = el("button", "btn sm"); tg.id = "semTg"; tg.type = "button"; $("#semTodos").after(tg); }
  tg.textContent = atual ? "Ver semana passada" : "Ver esta semana"; tg.onclick = () => { semRef = atual ? addDias(segunda(hojeISO()), -7) : segunda(hojeISO()); renderSemana(); };
}
$("#semPdf").onclick = async () => { try { const arq = rels.find(x => x.id === semRef); if (arq) return await pdfSemana(arq);
  const r = montarSemana(semRef); r.arquivadoEm = Date.now(); await setDoc(doc(db, "users", uid, "projrel", r.id), JSON.parse(JSON.stringify(r))); toast("Relatório arquivado."); await pdfSemana(r); } catch (e) { falha(e); } };
$("#semTodos").onclick = () => { const l = projs.filter(p => p.status !== "perdido"); if (!l.length) return toast("Nenhum projeto cadastrado."); pdfProjetos(l).catch(falha); };
function renderRels() {
  const box = $("#relList"); box.textContent = "";
  rels.forEach(r => { const row = el("div", "arq-row"), ic = el("div", "arq-ic"); ic.append(Object.assign(el("b"), { textContent: dm(r.ini) }), "sem.");
    const t = el("div"); t.append(el("div", "d", `Semana de ${dm(r.ini)} a ${dm(r.fim)}`), el("div", "m", `${r.etapas?.length || 0} etapa(s) · ${brl(r.totalReceb || 0)} recebidos`));
    const a = el("div", "arq-acts"), b = el("button", "btn sm pri", "Baixar PDF"); b.onclick = () => pdfSemana(r).catch(falha);
    const x = el("button", "btn sm danger", "Excluir"); armar(x, "Excluir", async () => { try { await deleteDoc(doc(db, "users", uid, "projrel", r.id)); } catch (e) { falha(e); } });
    a.append(b, x); row.append(ic, t, a); box.append(row); });
}

/* ===== PDF ===== */
async function iniciarPdf(tit, sub, linha) {
  await carregar(JSPDF); await carregar(AUTOTABLE);
  const { jsPDF } = window.jspdf, pdf = new jsPDF({ unit: "mm", format: "a4" }), W = 210, H = 297, M = 14, CW = W - 2 * M, k = { pdf, W, H, M, CW, y: 0 };
  const fill = c => pdf.setFillColor(...c), cor = c => pdf.setTextColor(...c), fonte = (e = "normal", t = 9) => { pdf.setFont("helvetica", e); pdf.setFontSize(t); };
  Object.assign(k, { fill, cor, fonte });
  k.espaco = h => { if (k.y + h > H - 18) { pdf.addPage(); k.y = 18; } };
  k.titulo = (txt, s) => { k.espaco(16); k.y += 3; fill(COR.laranja); pdf.rect(M, k.y - 3.2, 1.4, 4.6, "F"); fonte("bold", 11); cor(COR.grafite); pdf.text(txt, M + 4, k.y + 0.6); if (s) { fonte("normal", 8); cor(COR.suave); pdf.text(s, W - M, k.y + 0.6, { align: "right" }); } k.y += 5; };
  k.tabela = (head, body, o = {}) => { pdf.autoTable({ startY: k.y, head: [head], body, margin: { left: M, right: M, top: 18, bottom: 18 }, theme: "plain",
    styles: { font: "helvetica", fontSize: 8.2, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 }, textColor: COR.texto, lineColor: COR.linha, overflow: "linebreak" },
    headStyles: { fontStyle: "bold", fontSize: 7.2, textColor: COR.suave, fillColor: COR.fundo }, bodyStyles: { lineWidth: { bottom: 0.15 } }, ...o }); k.y = pdf.lastAutoTable.finalY + 5; };
  k.vazio = t => { fonte("normal", 8.5); cor(COR.suave); pdf.text(t, M, k.y); k.y += 7; };
  k.barra = (p, x, y, w, h = 2.6) => { fill(COR.linha); pdf.roundedRect(x, y, w, h, h / 2, h / 2, "F"); if (p > 0) { fill(p >= 1 ? COR.verde : COR.ciano); pdf.roundedRect(x, y, Math.max(h, w * Math.min(1, p)), h, h / 2, h / 2, "F"); } };
  const logo = await logoPdf(); let lx = M;
  if (logo) { const lh = 15, lw = lh * logo.w / logo.h; pdf.addImage(logo.url, "PNG", M, 8.5, lw, lh); lx = M + lw + 5; }
  fonte("bold", 15); cor(COR.grafite); pdf.text("ALICERCE", lx, 16.5, { charSpace: 1.6 }); fonte("bold", 8); cor(COR.laranja); pdf.text("PROJ", lx, 21.5, { charSpace: 2.4 });
  fonte("bold", 13); cor(COR.grafite); pdf.text(tit, W - M, 15, { align: "right" }); fonte("normal", 9.5); cor(COR.suave); pdf.text(sub, W - M, 20.5, { align: "right" }); fonte("normal", 7.5); pdf.text(linha, W - M, 25.5, { align: "right" });
  fill(COR.laranja); pdf.rect(M, 30, 22, 1.1, "F"); fill(COR.grafite); pdf.rect(M + 22, 30.35, CW - 22, 0.4, "F"); k.y = 40;
  k.fim = (rod, arq) => { const n = pdf.getNumberOfPages(); for (let i = 1; i <= n; i++) { pdf.setPage(i); pdf.setDrawColor(...COR.linha); pdf.setLineWidth(0.2); pdf.line(M, H - 12, W - M, H - 12); fonte("normal", 7); cor(COR.suave); pdf.text(rod, M, H - 7.5); pdf.text(`Página ${i} de ${n}`, W - M, H - 7.5, { align: "right" }); } pdf.save(arq); };
  return k;
}
function fichaPdf(k, p) {
  const { pdf, M, CW, W } = k, r = resumo(p);
  k.espaco(50); k.titulo(p.nome, STN[p.status]);
  k.tabela(["CLIENTE", "CONTATO", "LOCAL", "TIPOLOGIA", "ÁREA"], [[p.cliente || "—", p.contato || "—", p.local || "—", p.tipologia || "—", p.area ? p.area.toLocaleString("pt-BR") + " m2" : "—"]]);
  if (p.descricao) { k.fonte("normal", 8.5); k.cor(COR.texto); const l = pdf.splitTextToSize("Escopo: " + p.descricao, CW); pdf.text(l, M, k.y); k.y += l.length * 4 + 2; }
  k.tabela(["ORÇADO", "DESCONTO", "FECHADO", "ORÇAMENTO", "FECHAMENTO", "PRAZO"], [[brl(r.orcado), brl(p.desconto || 0), brl(r.fechado), dBR(p.orcData), dBR(p.fechamento), dBR(p.prazo)]], { styles: { fontSize: 8.4, fontStyle: "bold", textColor: COR.grafite, cellPadding: 2 } });
  k.fonte("bold", 8); k.cor(COR.grafite); pdf.text(`Andamento: ${r.feitas} de ${r.total} etapas`, M, k.y + 2.2); pdf.text(`${Math.round(r.pct * 100)}%`, W - M, k.y + 2.2, { align: "right" }); k.barra(r.pct, M + 52, k.y, CW - 52 - 14); k.y += 8;
  (p.disciplinas || []).forEach(d => {
    const f = d.etapas.filter(e => e.ok).length; k.espaco(14);
    k.fonte("bold", 9); k.cor(COR.petroleo); pdf.text(`${d.d}${d.sistema ? " (" + d.sistema + ")" : ""}${d.valor ? " · " + brl(d.valor) : ""}`, M, k.y + 2); k.fonte("normal", 8); k.cor(COR.suave); pdf.text(`${f}/${d.etapas.length}`, W - M, k.y + 2, { align: "right" }); k.y += 4;
    k.tabela(["", "ETAPA", "CONCLUÍDA EM"], d.etapas.map(e => [e.ok ? "OK" : "–", e.t, e.ok ? dBR(e.data) : "—"]), { columnStyles: { 0: { cellWidth: 10, halign: "center", fontStyle: "bold" }, 2: { cellWidth: 30, halign: "right", textColor: COR.suave } },
      didParseCell: c => { if (c.section === "body" && c.column.index === 0) c.cell.styles.textColor = d.etapas[c.row.index]?.ok ? COR.verde : COR.suave; } });
  });
  const pl = p.parcelas || [];
  k.titulo("Entrada e parcelamento", `${brl(r.recebido)} recebidos · ${brl(r.aReceber)} a receber`);
  if (pl.length) k.tabela(["DESCRIÇÃO", "VENCIMENTO", "SITUAÇÃO", "VALOR"], pl.map(x => [x.desc || "Parcela", dBR(x.venc), x.pago ? (x.pagoEm ? `Recebida ${dBR(x.pagoEm)}` : "Recebido") : (x.venc && x.venc < hojeISO() ? "Atrasada" : "A receber"), brl(x.valor)]),
    { columnStyles: { 3: { halign: "right", fontStyle: "bold" } }, didParseCell: c => { if (c.section === "body" && c.column.index === 2) c.cell.styles.textColor = pl[c.row.index].pago ? COR.verde : (pl[c.row.index].venc < hojeISO() ? COR.vermelho : COR.amarelo); } });
  else k.vazio("Nenhuma parcela lançada.");
  const prs = p.prestadores || [];
  if (prs.length) { k.titulo("Prestadores", `${brl(r.pagoPrest)} pagos · ${brl(r.aPagar)} a pagar · margem ${brl(r.margem)} (${Math.round(r.margemPct * 100)}%)`);
    k.tabela(["PRESTADOR", "DISCIPLINA", "PAGAMENTO", "SITUAÇÃO", "VALOR"], prs.flatMap(x => (x.pagamentos || []).map(y => [x.nome, x.disc, y.desc || "—", y.pago ? `Pago ${y.pagoEm ? dBR(y.pagoEm) : ""}` : "A pagar", brl(y.valor)])),
      { columnStyles: { 4: { halign: "right", fontStyle: "bold" } } }); }
  if (p.obs) { k.fonte("italic", 8.5); k.cor(COR.texto); const l = pdf.splitTextToSize("Obs.: " + p.obs, CW); k.espaco(l.length * 4); pdf.text(l, M, k.y); k.y += l.length * 4 + 4; }
}
async function pdfProjetos(lista) {
  const um = lista.length === 1;
  const k = await iniciarPdf(um ? "Ficha do projeto" : "Carteira de projetos", um ? (lista[0].cliente || "") : `${lista.length} projetos`, `${nome} · ${new Date().toLocaleDateString("pt-BR")}`);
  if (!um) { const rs = lista.map(resumo);
    k.titulo("Visão geral");
    k.tabela(["PROJETO", "CLIENTE", "SITUAÇÃO", "ANDAMENTO", "FECHADO", "A RECEBER"], lista.map((p, i) => [p.nome, p.cliente || "—", STN[p.status], `${Math.round(rs[i].pct * 100)}%`, brl(rs[i].fechado), brl(rs[i].aReceber)]),
      { columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right", fontStyle: "bold" } }, foot: [["Total", "", "", "", brl(rs.reduce((s, r) => s + r.fechado, 0)), brl(rs.reduce((s, r) => s + r.aReceber, 0))]],
        footStyles: { fontStyle: "bold", textColor: COR.grafite, lineWidth: { top: 0.4 }, lineColor: COR.grafite, halign: "right" } });
    k.pdf.addPage(); k.y = 18; }
  lista.forEach((p, i) => { if (i) { k.pdf.addPage(); k.y = 18; } fichaPdf(k, p); });
  const slug = (um ? lista[0].nome : "carteira").normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  k.fim(`Alicerce Proj · ${um ? lista[0].nome : "Carteira de projetos"}`, `Alicerce-Proj-${slug}.pdf`);
}
async function pdfSemana(r) {
  const k = await iniciarPdf("Relatório semanal", `${dBR(r.ini)} a ${dBR(r.fim)}`, `${r.nome || nome} · ${r.arquivadoEm ? "arquivado em " + new Date(r.arquivadoEm).toLocaleDateString("pt-BR") : "gerado em " + new Date().toLocaleDateString("pt-BR")}`);
  k.titulo("Etapas concluídas na semana", String(r.etapas.length));
  r.etapas.length ? k.tabela(["DATA", "PROJETO", "DISCIPLINA", "ETAPA"], r.etapas.map(e => [dm(e.data), e.proj, e.disc, e.etapa]), { columnStyles: { 0: { cellWidth: 14, textColor: COR.suave } } }) : k.vazio("Nenhuma etapa concluída nesta semana.");
  k.titulo("Recebimentos da semana", brl(r.totalReceb));
  r.receb.length ? k.tabela(["DATA", "PROJETO", "DESCRIÇÃO", "VALOR"], r.receb.map(x => [dm(x.data), x.proj, x.desc, brl(x.valor)]), { columnStyles: { 0: { cellWidth: 14, textColor: COR.suave }, 3: { halign: "right", fontStyle: "bold", textColor: COR.verde } } }) : k.vazio("Nenhum recebimento nesta semana.");
  if (r.pagos) { k.titulo("Pagamentos a prestadores na semana", brl(r.totalPagos || 0));
    r.pagos.length ? k.tabela(["DATA", "PROJETO", "PRESTADOR / PARCELA", "VALOR"], r.pagos.map(x => [dm(x.data), x.proj, x.desc, brl(x.valor)]), { columnStyles: { 0: { cellWidth: 14, textColor: COR.suave }, 3: { halign: "right", fontStyle: "bold", textColor: COR.vermelho } } }) : k.vazio("Nenhum pagamento a prestadores nesta semana."); }
  k.titulo("Movimentações");
  r.mov.length ? k.tabela(["DATA", "PROJETO", "REGISTRO"], r.mov.map(x => [dm(x.data), x.proj, x.t]), { columnStyles: { 0: { cellWidth: 14, textColor: COR.suave } } }) : k.vazio("Nenhuma movimentação registrada.");
  k.titulo("Parcelas a vencer (15 dias) e atrasadas");
  r.venc.length ? k.tabela(["VENCIMENTO", "PROJETO", "DESCRIÇÃO", "VALOR"], r.venc.map(x => [dm(x.data), x.proj, x.desc, brl(x.valor)]), { columnStyles: { 0: { cellWidth: 20 }, 3: { halign: "right", fontStyle: "bold" } } }) : k.vazio("Nada a vencer.");
  k.titulo("Situação dos projetos");
  r.projetos.length ? k.tabela(["PROJETO", "SITUAÇÃO", "ANDAMENTO", "PRÓXIMA ETAPA", "PRAZO", "A RECEBER"], r.projetos.map(p => [p.nome + (p.cliente ? "\n" + p.cliente : ""), p.status, p.pct + "%", p.prox || "—", dBR(p.prazo), brl(p.aReceber)]),
    { columnStyles: { 2: { halign: "right" }, 5: { halign: "right", fontStyle: "bold" } } }) : k.vazio("Nenhum projeto em andamento.");
  k.fim(`Alicerce Proj · Relatório semanal ${dBR(r.ini)} a ${dBR(r.fim)}`, `Alicerce-Proj-semana-${r.ini}.pdf`);
}

/* ===== projetos compartilhados (somente leitura + anotações) ===== */
function assinarProjs() {
  unsubProj?.(); projs = []; aberto = null; ["#vFicha", "#vForm"].forEach(s => $(s).hidden = true); $("#vLista").hidden = false;
  unsubProj = onSnapshot(collection(db, "users", dono, "proj"), s => { projs = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, e => { console.error(e); toast("Sem acesso a estes projetos."); });
}
function renderDonos() {
  const box = $("#donos"); box.textContent = ""; box.hidden = !donos.length;
  if (!donos.length) return;
  [{ uid, nome: "Meus projetos" }, ...donos.map(d => ({ uid: d.uid, nome: `Projetos de ${d.nome}` }))].forEach(d => {
    const b = el("button", "chip", d.nome); b.type = "button"; b.setAttribute("aria-pressed", String((dono || uid) === d.uid));
    b.onclick = () => { if (dono === d.uid) return; dono = d.uid; assinarProjs(); render(); }; box.append(b); });
  if (ro()) box.append(el("span", "note", "Somente visualização — você pode registrar anotações na ficha."));
}
document.addEventListener("click", e => { if (ro() && e.target.matches?.('input[type="checkbox"]') && e.target.closest("#lista,#vFicha")) { e.preventDefault(); toast("Somente visualização: só o responsável marca etapas e pagamentos."); } }, true);
const emailKey = e => String(e || "").trim().toLowerCase();
function renderShare() {
  const box = $("#shList"); if (!box) return; box.textContent = "";
  const ids = meuPerfil.projCom || [], nomes = meuPerfil.projComNomes || {};
  if (!ids.length) box.append(el("p", "note", "Ninguém vê seus projetos ainda."));
  ids.forEach(u => { const r = el("div", "share-row"); r.append(el("span", null, nomes[u] || "Pessoa")); const b = el("button", "btn sm danger", "Parar de compartilhar"); b.type = "button";
    armar(b, "Parar de compartilhar", async () => { try { await updateDoc(doc(db, "users", uid), { projCom: arrayRemove(u), [`projComNomes.${u}`]: deleteField() }); } catch (e) { falha(e); } }); r.append(b); box.append(r); });
}
$("#shBtn").onclick = () => { $("#shPanel").hidden = !$("#shPanel").hidden; };
$("#shFechar").onclick = () => $("#shPanel").hidden = true;
$("#shAdd").onclick = async () => {
  const e = emailKey($("#shEmail").value); if (!e.includes("@")) { toast("Informe um e-mail válido."); return; }
  try { const s = await getDoc(doc(db, "perfis", e)); if (!s.exists()) { toast("Não há conta com esse e-mail. Peça para a pessoa criar a conta no Alicerce primeiro."); return; }
    const p = s.data(); if (p.uid === uid) { toast("Esse é o seu e-mail."); return; }
    await updateDoc(doc(db, "users", uid), { projCom: arrayUnion(p.uid), [`projComNomes.${p.uid}`]: p.nome || "Pessoa" }); $("#shEmail").value = ""; toast(`${p.nome || "A pessoa"} agora vê seus projetos (somente leitura e anotações).`);
  } catch (x) { falha(x); }
};

/* ===== licença do TQS (custo mensal) ===== */
const mesAtual = () => hojeISO().slice(0, 7), nomeMes = m => ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+m.slice(5) - 1] + "/" + m.slice(2, 4);
async function salvarTqs(d) { try { await setDoc(doc(db, "users", uid, "projcfg", "tqs"), d); } catch (e) { falha(e); } }
function renderTqs() {
  const box = $("#tqsBox"); if (!box || ro()) return; box.textContent = "";
  const t = tqs || { valor: 0, meses: [] }, M = mesAtual(), ano = M.slice(0, 4);
  const doMes = t.meses.find(x => x.m === M), anoPago = t.meses.filter(x => x.m.startsWith(ano) && x.pago).reduce((s, x) => s + x.valor, 0);
  const usando = projs.filter(p => ["fechado", "execucao"].includes(p.status) && (p.disciplinas || []).some(d => d.config?.tqs === "alugar" && d.etapas.some(e => !e.ok))).length;
  $("#tqsTxt").textContent = doMes ? (doMes.pago ? `${nomeMes(M)} pago` : `${nomeMes(M)} a pagar`) : "mês atual não registrado";
  const top = el("div", "tqs-top"), lv = el("label", "f"), iv = el("input", "valor"); iv.inputMode = "decimal"; iv.placeholder = "0,00"; iv.value = t.valor ? fmtIn(t.valor) : ""; lv.append("Mensalidade (R$)", iv);
  const sv = el("button", "btn sm", "Salvar valor"); sv.type = "button"; sv.onclick = () => salvarTqs({ ...t, valor: parseValor(iv.value) || 0 });
  const reg = el("button", "btn sm pri", doMes ? "Mês atual registrado ✓" : `Registrar ${nomeMes(M)}`); reg.type = "button"; reg.disabled = !!doMes;
  reg.onclick = () => { const v = parseValor(iv.value) || t.valor; if (!v) { toast("Informe a mensalidade do TQS."); iv.focus(); return; } salvarTqs({ valor: v, meses: [...t.meses, { m: M, valor: v, pago: false }].sort((a, b) => b.m.localeCompare(a.m)) }); };
  top.append(lv, sv, reg); box.append(top);
  box.append(el("p", "note", `Pago em ${ano}: ${brl(anoPago)} · ${usando} projeto(s) ativo(s) usando TQS alugado.${t.valor && usando ? ` Rateio do mês: ${brl(Math.round(t.valor / usando))} por projeto.` : ""}`));
  const ul = el("div", "tqs-list");
  t.meses.slice(0, 12).forEach((x, i) => { const row = el("div", "parc" + (x.pago ? " ok" : "")), cb = el("input", "ck"); cb.type = "checkbox"; cb.checked = !!x.pago; cb.setAttribute("aria-label", "Pago");
    cb.onchange = () => { const ms = JSON.parse(JSON.stringify(t.meses)); ms[i].pago = cb.checked; ms[i].pagoEm = cb.checked ? hojeISO() : null; salvarTqs({ ...t, meses: ms }); };
    const tx = el("div"); tx.append(el("div", "d", `TQS — ${nomeMes(x.m)}`), el("div", "m", x.pago ? `Pago${x.pagoEm ? " em " + dBR(x.pagoEm) : ""}` : "A pagar"));
    const rm = el("button", "x", "×"); rm.type = "button"; rm.title = "Remover mês"; rm.onclick = () => salvarTqs({ ...t, meses: t.meses.filter((_, j) => j !== i) });
    const v = el("span", "v", brl(x.valor)); v.append(rm); row.append(cb, tx, v); ul.append(row); });
  box.append(ul);
}

/* ===== login ===== */
const ERROS = { "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/wrong-password": "E-mail ou senha incorretos.", "auth/user-not-found": "E-mail ou senha incorretos.", "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos.", "auth/network-request-failed": "Sem conexão com a internet." };
$("#authForm").addEventListener("submit", async ev => { ev.preventDefault(); $("#aErr").hidden = true; $("#aBtn").disabled = true;
  try { await signInWithEmailAndPassword(auth, $("#aEmail").value.trim(), $("#aSenha").value); } catch (e) { $("#aErr").textContent = ERROS[e.code] || "Não foi possível entrar."; $("#aErr").hidden = false; }
  $("#aBtn").disabled = false; });
$("#aEsqueci").onclick = async () => { const e = $("#aEmail").value.trim(); if (!e) { toast("Digite seu e-mail no campo acima."); return; } try { await sendPasswordResetEmail(auth, e); toast("Enviamos o link para o seu e-mail."); } catch (x) { toast("Não foi possível enviar o link."); } };
armar($("#sairBtn"), "Sair", () => signOut(auth));
onAuthStateChanged(auth, async u => {
  subs.splice(0).forEach(f => f()); unsubProj?.(); unsubProj = null; projs = []; rels = []; aberto = null; donos = []; dono = null; meuPerfil = {}; tqs = null;
  if (!u) { uid = null; $("#app").hidden = true; $("#auth").hidden = false; return; }
  uid = u.uid; $("#auth").hidden = true; $("#app").hidden = false;
  try { const s = await getDoc(doc(db, "users", uid)); nome = s.data()?.nome || u.displayName || u.email.split("@")[0]; } catch (e) { nome = u.displayName || ""; }
  dono = uid; assinarProjs();
  subs.push(onSnapshot(doc(db, "users", uid), s => { meuPerfil = s.data() || {}; render(); }, e => console.error(e)));
  subs.push(onSnapshot(query(collection(db, "users"), where("projCom", "array-contains", uid)), s => { donos = s.docs.map(d => ({ uid: d.id, nome: d.data().nome || "Outra pessoa" })); if (dono !== uid && !donos.some(x => x.uid === dono)) { dono = uid; assinarProjs(); } render(); }, e => console.error(e)));
  subs.push(onSnapshot(doc(db, "users", uid, "projcfg", "tqs"), s => { tqs = s.data() || null; render(); }, e => console.error(e)));
  subs.push(onSnapshot(collection(db, "users", uid, "projrel"), s => { rels = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.id.localeCompare(a.id)); render(); }, e => console.error(e)));
  render();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../" }).catch(() => {});
