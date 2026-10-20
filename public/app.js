// Finanças da Casa — aplicativo (Firebase Auth + Firestore, plano gratuito)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, getDoc, arrayUnion, arrayRemove, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { PLANO, AMB_NOME, MESES, pad, hojeISO, addMeses, addMes, diasNoMes, difDias, dm, mesCurto, brl, parseValor, fmtIn, grupoDe, ambitoDe, mesFatura, valorParcela, vencFatura, fechamentoFatura, parcelasNoMes, vencimentos, textoLembrete } from "./nucleo.js";
import { lerNota, sugerirPorTexto, formatarCnpj } from "./ocr.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ===== utilitários de interface ===== */
const $ = s => document.querySelector(s);
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const SER = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"], OUTROS = "var(--s8)";
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3600); }
function falha(e) { console.error(e); toast(e?.code === "permission-denied" ? "Você não tem permissão para alterar este item." : e?.code === "unavailable" ? "Sem conexão. A alteração será enviada quando a internet voltar." : "Não foi possível salvar. Tente de novo."); }
function armar(btn, rotulo, acao) { // confirmação em dois toques
  let armado = false;
  btn.onclick = async () => {
    if (!armado) { armado = true; btn.classList.add("armed"); btn.textContent = "Confirmar"; setTimeout(() => { armado = false; btn.classList.remove("armed"); btn.textContent = rotulo; }, 4000); return; }
    armado = false; btn.classList.remove("armed"); btn.textContent = rotulo; await acao();
  };
}
const emailKey = e => String(e || "").trim().toLowerCase();

/* ===== estado ===== */
let uid = null, perfil = {}, privado = {}, sharers = [];
let mes = hojeISO().slice(0, 7), filtro = "eu", ambF = "todos", vista = "resumo";
let tipo = "despesa", editId = null, editCompra = null, editCartao = null, ocr = null;
try { vista = localStorage.getItem("fc-vista") || "resumo"; } catch (e) {}

/* ===== assinaturas em tempo real ===== */
const subs = new Map(), res = new Map();
function assinar(key, q, mapear) {
  if (subs.has(key)) return;
  subs.set(key, onSnapshot(q, s => { res.set(key, s.docs.map(d => mapear ? mapear(d) : { id: d.id, ...d.data() })); agendar(); },
    e => { console.error(key, e); res.set(key, []); agendar(); }));
}
function cancelarTudo() { for (const u of subs.values()) u(); subs.clear(); res.clear(); }
const membros = () => [uid, ...sharers.map(s => s.uid)];
function sincronizar() {
  const quero = new Set();
  for (const u of membros()) {
    quero.add(`lm:${u}:${mes}`); quero.add(`pd:${u}`); quero.add(`cp:${u}`); if (u !== uid) quero.add(`ko:${u}`);
  }
  ["cd", "ko", "ka", "rg", "eu", "pv", "sh"].forEach(k => quero.add(`${k}:${uid}`));
  for (const ct of cartoes()) quero.add(`ft:${ct.id}`);
  for (const k of [...subs.keys()]) if (!quero.has(k)) { subs.get(k)(); subs.delete(k); res.delete(k); }
  for (const k of quero) {
    if (subs.has(k)) continue;
    const [t, a, b] = k.split(":");
    if (t === "lm") assinar(k, query(collection(db, "users", a, "lancamentos"), where("mes", "==", b)), d => ({ id: d.id, ...d.data(), uid: a }));
    else if (t === "pd") assinar(k, query(collection(db, "users", a, "lancamentos"), where("pago", "==", false)), d => ({ id: d.id, ...d.data(), uid: a }));
    else if (t === "cp") assinar(k, query(collection(db, "compras"), where("comprador", "==", a)));
    else if (t === "cd") assinar(k, query(collection(db, "compras"), where("dono", "==", a)));
    else if (t === "ko") assinar(k, query(collection(db, "cartoes"), where("dono", "==", a)));
    else if (t === "ka") assinar(k, query(collection(db, "cartoes"), where("autorizados", "array-contains", a)));
    else if (t === "ft") assinar(k, collection(db, "cartoes", a, "faturas"), d => ({ id: a + "_" + d.id, ...d.data() }));
    else if (t === "rg") assinar(k, collection(db, "users", a, "regras"));
    else if (t === "eu") subs.set(k, onSnapshot(doc(db, "users", a), s => { perfil = s.data() || {}; agendar(); }, e => console.error(e)));
    else if (t === "pv") subs.set(k, onSnapshot(doc(db, "privado", a), s => { privado = s.data() || {}; agendar(); }, e => console.error(e)));
    else if (t === "sh") subs.set(k, onSnapshot(query(collection(db, "users"), where("compartilhaCom", "array-contains", a)),
      s => { sharers = s.docs.map(d => ({ uid: d.id, nome: d.data().nome || "Sem nome", cor: d.data().cor || 0 })); if (filtro !== "eu" && !chipsValidos().includes(filtro)) filtro = "eu"; agendar(); },
      e => { console.error(e); sharers = []; agendar(); }));
  }
}
const juntar = pref => { const m = new Map(); for (const [k, v] of res) if (k.startsWith(pref)) v.forEach(x => m.set(x.id, x)); return [...m.values()]; };
const cartoes = () => juntar("ko:").concat(juntar("ka:")).filter((x, i, a) => a.findIndex(y => y.id === x.id) === i);
const compras = () => juntar("cp:").concat(juntar("cd:")).filter((x, i, a) => a.findIndex(y => y.id === x.id) === i);
const faturas = () => Object.fromEntries(juntar("ft:").map(f => [f.id, f]));
const regras = () => Object.fromEntries((res.get(`rg:${uid}`) || []).map(r => [r.id, r]));
const lancMes = () => juntar("lm:").filter(l => l.mes === mes);
const pendentes = () => juntar("pd:");
let pendRender = false;
function agendar() { if (pendRender) return; pendRender = true; requestAnimationFrame(() => { pendRender = false; if (!uid) return; sincronizar(); render(); }); }

/* ===== pessoas e visibilidade ===== */
function nomeDe(u) {
  if (u === uid) return perfil.nome || auth.currentUser?.displayName || "Eu";
  const s = sharers.find(x => x.uid === u); if (s) return s.nome;
  const c = compras().find(x => x.comprador === u); if (c?.compradorNome) return c.compradorNome;
  const k = cartoes().find(x => x.dono === u); if (k?.donoNome) return k.donoNome;
  return "Outra pessoa";
}
const corDe = u => `var(--p${(u === uid ? perfil.cor : sharers.find(x => x.uid === u)?.cor) || (u === uid ? 0 : 1)})`;
const chipsValidos = () => ["eu", ...sharers.map(s => "par:" + s.uid), ...(sharers.length > 1 ? ["todos"] : [])];
function visivel() {
  if (filtro.startsWith("par:")) return new Set([uid, filtro.slice(4)]);
  if (filtro === "todos") return new Set(membros());
  return new Set([uid]);
}
const passaPessoa = l => visivel().has(l.uid);
const passaAmb = l => ambF === "todos" || ambitoDe(l) === ambF;
const parcelas = m => parcelasNoMes(compras(), cartoes(), faturas(), m);
const doMes = () => lancMes().concat(parcelas(mes));
const visiveis = () => doMes().filter(l => passaPessoa(l) && passaAmb(l));
function somar(arr) { let rec = 0, des = 0, pen = 0; arr.forEach(l => { if (l.tipo === "receita") rec += l.valor; else { des += l.valor; if (!l.pago) pen += l.valor; } }); return { rec, des, pen, res: rec - des }; }

/* ===== render ===== */
function render() {
  $("#mesLbl").textContent = (() => { const [y, m] = mes.split("-").map(Number); return `${MESES[m - 1]} ${y}`; })();
  $("#whoName").textContent = ""; $("#whoName").append("Olá, ", Object.assign(el("b"), { textContent: nomeDe(uid) }));
  renderChips(); renderVista();
  const v = visiveis(), t = somar(v);
  $("#sRec").textContent = brl(t.rec); $("#sDes").textContent = brl(t.des); $("#sPen").textContent = brl(t.pen);
  $("#sSalLbl").textContent = ambF === "empresa" ? "Resultado da empresa" : "Saldo do mês"; $("#sSal").textContent = brl(t.res);
  renderVenc();
  const des = v.filter(l => l.tipo === "despesa"), rec = v.filter(l => l.tipo === "receita");
  donut($("#dGrupo"), "Despesas por grupo", agrupar(des, grupoDe), "Sem despesas no mês");
  donut($("#dCat"), "Despesas por categoria", agrupar(des, l => l.categoria), "Sem despesas no mês");
  donut($("#dRec"), "Receitas por origem", agrupar(rec, l => l.categoria), "Sem receitas no mês");
  tabelaResultado($("#ambSec"), $("#ambBody"), $("#ambFoot"), doMes().filter(passaPessoa), ambF === "todos" ? ["pessoal", "empresa"] : [],
    a => { const td = el("td"); td.append(el("span", "tag " + (a === "empresa" ? "emp" : "pes"), AMB_NOME[a])); return td; }, (l, a) => ambitoDe(l) === a);
  const vs = [...visivel()];
  tabelaResultado($("#pesSec"), $("#pesBody"), $("#pesFoot"), v, vs.length > 1 ? vs : [],
    u => { const td = el("td"); const d = el("span", "dot"); d.style.cssText = `display:inline-block;margin-right:6px;background:${corDe(u)}`; td.append(d, nomeDe(u)); return td; }, (l, u) => l.uid === u);
  tabela($("#prestBody"), $("#prestFoot"), $("#prestSec"), v.filter(l => l.tipo === "despesa" && l.categoria === "Prestadores de serviço"),
    l => { const p = (l.contraparte || "Não informado").trim(), j = (l.projeto || "—").trim(); return { key: p + "|" + j, p, j }; },
    r => [[r.p], [r.j, "wrap"], [String(r.n), "r"], [brl(r.v), "r"], [brl(r.ab), "r" + (r.ab ? " warn" : "")]], true);
  tabela($("#cliBody"), $("#cliFoot"), $("#cliSec"), v.filter(l => l.tipo === "receita" && ambitoDe(l) === "empresa"),
    l => { const c = (l.contraparte || "Não informado").trim(), o = l.categoria, j = (l.projeto || "—").trim(); return { key: c + "|" + o + "|" + j, c, o, j }; },
    r => [[r.c], [r.o], [r.j, "wrap"], [brl(r.v), "r"], [brl(r.ab), "r" + (r.ab ? " warn" : "")]], false);
  renderLista(v); renderCartoes();
}
function renderChips() {
  const box = $("#chips"); box.textContent = "";
  const mk = (id, nome, cor) => { const b = el("button", "chip"); b.setAttribute("aria-pressed", String(filtro === id)); if (cor) { const d = el("span", "dot"); d.style.background = cor; b.append(d); } b.append(nome); b.onclick = () => { filtro = id; render(); }; box.append(b); };
  mk("eu", "Só eu", corDe(uid));
  sharers.forEach(s => mk("par:" + s.uid, `Balanço: eu + ${s.nome}`));
  if (sharers.length > 1) mk("todos", "Balanço: todos");
  document.querySelectorAll("#amb button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.a === ambF)));
}
function renderVista() { document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.v === vista))); ["resumo", "lanc", "cartoes"].forEach(x => $("#v-" + x).hidden = x !== vista); }

/* gráfico de rosca com legenda; tocar numa fatia mostra valor e % no centro */
function donut(alvo, titulo, itens, vazio) {
  alvo.textContent = ""; alvo.append(el("span", "eyebrow", titulo));
  const total = itens.reduce((s, x) => s + x.v, 0);
  if (!total) { alvo.append(el("div", "nodata", vazio)); return; }
  let lista = itens.filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  if (lista.length > 7) { const resto = lista.slice(6); lista = lista.slice(0, 6).concat([{ n: `Outros (${resto.length})`, v: resto.reduce((s, x) => s + x.v, 0), outros: true }]); }
  lista.forEach((x, i) => x.cor = x.outros ? OUTROS : SER[i]);
  const R = 78, C = 2 * Math.PI * R, GAP = lista.length > 1 ? 2.5 : 0;
  const svg = sv("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": titulo });
  svg.append(sv("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: "var(--line)", "stroke-width": 26 }));
  const g = sv("g", { transform: "rotate(-90 100 100)" }); svg.append(g);
  const t1 = sv("text", { x: 100, y: 84, "text-anchor": "middle", class: "c1" }), t2 = sv("text", { x: 100, y: 106, "text-anchor": "middle", class: "c2" }), t3 = sv("text", { x: 100, y: 124, "text-anchor": "middle", class: "c3" });
  svg.append(t1, t2, t3);
  const leg = el("div", "leg"), sl = [], lb = [];
  const centro = i => {
    sl.forEach((s, j) => s.classList.toggle("on", j === i)); lb.forEach((b, j) => b.classList.toggle("on", j === i));
    if (i == null) { t1.textContent = "Total"; t2.textContent = brl(total); t3.textContent = lista.length + (lista.length > 1 ? " itens" : " item"); }
    else { const x = lista[i]; t1.textContent = x.n.length > 22 ? x.n.slice(0, 21) + "…" : x.n; t2.textContent = brl(x.v); t3.textContent = (x.v / total * 100).toFixed(1).replace(".", ",") + "%"; }
  };
  let off = 0;
  lista.forEach((x, i) => {
    const len = x.v / total * C;
    const c = sv("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: x.cor, "stroke-width": 26, class: "sl", "stroke-dasharray": `${Math.max(len - GAP, .5)} ${C}`, "stroke-dashoffset": -off, tabindex: 0 });
    const tt = sv("title", {}); tt.textContent = `${x.n}: ${brl(x.v)}`; c.append(tt);
    c.addEventListener("mouseenter", () => centro(i)); c.addEventListener("click", () => centro(i)); c.addEventListener("focus", () => centro(i));
    g.append(c); sl.push(c); off += len;
    const b = el("button"); b.type = "button"; const sw = el("span", "sw"); sw.style.background = x.cor;
    b.append(sw, el("span", "n", x.n), el("span", "v", brl(x.v)), el("span", "pc", Math.round(x.v / total * 100) + "%"));
    b.onmouseenter = () => centro(i); b.onclick = () => centro(i); leg.append(b); lb.push(b);
  });
  svg.addEventListener("mouseleave", () => centro(null)); leg.addEventListener("mouseleave", () => centro(null));
  centro(null); alvo.append(svg, leg);
}
function agrupar(arr, chave) { const m = {}; arr.forEach(l => { const k = chave(l); m[k] = (m[k] || 0) + l.valor; }); return Object.entries(m).map(([n, v]) => ({ n, v })); }
function tabelaResultado(sec, body, foot, arr, chaves, celula, pertence) {
  sec.hidden = !chaves.length || !arr.length; body.textContent = ""; foot.textContent = "";
  if (sec.hidden) return;
  chaves.forEach(k => { const x = somar(arr.filter(l => pertence(l, k))); const tr = el("tr"); tr.append(celula(k), el("td", "r", brl(x.rec)), el("td", "r", brl(x.des)), el("td", "r " + (x.res < 0 ? "out" : "in"), brl(x.res))); body.append(tr); });
  const x = somar(arr.filter(l => chaves.some(k => pertence(l, k)))); const tr = el("tr"); tr.append(el("td", "", "Total"), el("td", "r", brl(x.rec)), el("td", "r", brl(x.des)), el("td", "r " + (x.res < 0 ? "out" : "in"), brl(x.res))); foot.append(tr);
}
function tabela(body, foot, sec, arr, chaveFn, cols, comQtd) {
  const map = {}; arr.forEach(l => { const k = chaveFn(l); (map[k.key] = map[k.key] || { ...k, n: 0, v: 0, ab: 0 }); map[k.key].n++; map[k.key].v += l.valor; if (!l.pago) map[k.key].ab += l.valor; });
  const rows = Object.values(map).sort((a, b) => b.v - a.v); sec.hidden = !rows.length; body.textContent = ""; foot.textContent = "";
  let tv = 0, ta = 0, tn = 0; rows.forEach(r => { const tr = el("tr"); cols(r).forEach(([t, c]) => tr.append(el("td", c || "", t))); body.append(tr); tv += r.v; ta += r.ab; tn += r.n; });
  if (rows.length) { const tr = el("tr"); tr.append(el("td", "", "Total")); const sp = el("td"); sp.colSpan = comQtd ? 1 : 2; tr.append(sp); if (comQtd) tr.append(el("td", "r", String(tn))); tr.append(el("td", "r", brl(tv)), el("td", "r", brl(ta))); foot.append(tr); }
}

/* ===== vencimentos e WhatsApp ===== */
function listaVenc() {
  const dias = +privado.dias || 5;
  const lista = vencimentos({
    pendentes: pendentes().filter(l => passaPessoa(l) && passaAmb(l)), compras: compras(), cartoes: cartoes(), faturas: faturas(), hoje: hojeISO(), dias,
    incluirFaturaDe: (p, ct) => passaAmb(p) && (ct.dono === uid || passaPessoa(p)),
    rotuloFatura: ct => ct.dono === uid ? `Fatura ${ct.nome}` : `Sua parte na fatura ${ct.nome} (${ct.donoNome || "titular"})`
  });
  return { lista, dias };
}
function renderVenc() {
  const { lista, dias } = listaVenc(); $("#vencSec").hidden = !lista.length; $("#vencJanela").textContent = `próximos ${dias} dias e atrasados`;
  const box = $("#vencList"); box.textContent = ""; const h = hojeISO();
  lista.forEach(x => { const r = el("div", "venc-row"), dd = difDias(h, x.data);
    const w = el("span", "when" + (dd < 0 ? " late" : ""), dd < 0 ? `Atrasado ${-dd}d` : dd === 0 ? "Hoje" : dd === 1 ? "Amanhã" : `${dm(x.data)} · ${dd}d`);
    const t = el("div"); t.append(el("span", "d", x.d), el("span", "m", x.m + (x.uid && x.uid !== uid ? " · " + nomeDe(x.uid) : ""))); r.append(w, t, el("span", "num", brl(x.v))); box.append(r); });
  const wa = $("#waBox"); wa.textContent = ""; if (!lista.length) return;
  const num = (privado.whatsapp || "").replace(/\D/g, "");
  if (num.length >= 10) {
    const a = el("a", null, "Enviar lembrete no WhatsApp"); a.href = `https://wa.me/${num.length <= 11 ? "55" + num : num}?text=${encodeURIComponent(textoLembrete(lista, h))}`; a.target = "_blank"; a.rel = "noopener";
    wa.append(a, el("span", "note", privado.callmebotKey ? "O aviso automático também chega todo dia às 7h40." : "Ative o aviso automático em “Conta e compartilhamento”."));
  } else { const b = el("button", "btn sm", "Cadastrar WhatsApp para avisos"); b.onclick = () => abrirAjustes(true); wa.append(b); }
}

/* ===== lista de lançamentos ===== */
function renderLista(v) {
  const li = $("#lista"); li.textContent = ""; $("#lancCount").textContent = `${v.length} ${v.length === 1 ? "item" : "itens"}`;
  if (!v.length) { const e = el("div", "empty"); e.append(el("strong", null, "Nenhum lançamento neste mês"), "Toque em “+ Novo lançamento” ou “Ler nota por foto”."); li.append(e); return; }
  const porDia = {}; v.forEach(l => (porDia[l.data] = porDia[l.data] || []).push(l));
  Object.keys(porDia).sort().reverse().forEach(dia => {
    const g = el("div", "day"); const [y, m, d] = dia.split("-").map(Number); g.append(el("h3", null, `${pad(d)}/${pad(m)} · ${DIAS[new Date(y, m - 1, d).getDay()]}`));
    porDia[dia].sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0) || (a.criadoEm || 0) - (b.criadoEm || 0)).forEach(l => {
      const it = el("div", "item"); const dot = el("span", "dot"); dot.style.background = corDe(l.uid);
      const tx = el("button", "txt"); tx.type = "button";
      const meta = [l.virtual ? "Cartão " + l.cartao.nome : null, `${grupoDe(l)} › ${l.categoria}`, l.contraparte, l.projeto, l.documento, visivel().size > 1 ? nomeDe(l.uid) : null].filter(Boolean).join(" · ");
      tx.append(el("span", "d", l.descricao), el("span", "m", meta)); tx.onclick = () => l.virtual ? abrirCompra(l.compra) : abrirForm(l);
      const val = el("span", "v " + (l.tipo === "receita" ? "in" : "out"), (l.tipo === "receita" ? "+ " : "− ") + brl(l.valor));
      let pill;
      if (l.virtual) pill = el("span", "pill " + (l.pago ? "ok" : "fat"), l.pago ? "Fatura paga" : "Na fatura");
      else {
        pill = el("button", "pill " + (l.pago ? "ok" : "pend"), l.tipo === "receita" ? (l.pago ? "Recebido" : "A receber") : (l.pago ? "Pago" : "A pagar")); pill.type = "button";
        pill.disabled = l.uid !== uid;
        pill.onclick = async () => { pill.disabled = true; try { await updateDoc(doc(db, "users", uid, "lancamentos", l.id), { pago: !l.pago }); } catch (e) { falha(e); } pill.disabled = false; };
      }
      it.append(dot, tx, val, pill); g.append(it);
    });
    li.append(g);
  });
}

/* ===== cartões ===== */
function renderCartoes() {
  const box = $("#ccList"); box.textContent = "";
  const vs = visivel(), todasCompras = compras();
  const lista = cartoes().filter(ct => ct.dono === uid || vs.has(ct.dono) || todasCompras.some(c => c.cartao === ct.id && vs.has(c.comprador)) || (ct.autorizados || []).includes(uid));
  if (!lista.length) { const e = el("div", "empty"); e.append(el("strong", null, "Nenhum cartão"), "Cadastre seu cartão ou peça ao titular para autorizar você a lançar compras no dele."); box.append(e); return; }
  lista.forEach(ct => {
    const souDono = ct.dono === uid, verTudo = souDono || vs.has(ct.dono);
    const ps = parcelas(mes).filter(p => p.cartao.id === ct.id && passaAmb(p) && (verTudo || vs.has(p.uid)));
    const tot = ps.reduce((s, p) => s + p.valor, 0), paga = !!faturas()[ct.id + "_" + mes]?.pago;
    const card = el("section", "card cc"), top = el("div", "cc-top"), l = el("div");
    const nm = el("button", "cc-name", ct.nome); nm.style.cssText = "background:none;border:0;padding:0;text-align:left"; nm.onclick = () => souDono ? abrirCartao(ct) : toast(`Cartão de ${ct.donoNome || "outra pessoa"}. Só o titular altera.`);
    l.append(nm, el("div", "cc-meta", `Titular: ${souDono ? "você" : ct.donoNome || "—"} · fecha ${dm(fechamentoFatura(ct, mes))} · vence ${dm(vencFatura(ct, mes))}`));
    const r = el("div", "cc-total"); r.append(el("span", "eyebrow", (verTudo ? "Fatura de " : "Sua parte em ") + mesCurto(mes)), el("strong", null, brl(tot)));
    top.append(l, r); card.append(top);
    const porP = {}; ps.forEach(p => porP[p.uid] = (porP[p.uid] || 0) + p.valor);
    if (tot > 0 && Object.keys(porP).length > 1) {
      const sp = el("div", "split"); sp.append(el("span", "eyebrow", "Quem gastou nesta fatura"));
      const bar = el("div", "split-bar"), leg = el("div", "split-leg");
      Object.entries(porP).sort((a, b) => b[1] - a[1]).forEach(([u, v]) => { const i = el("i"); i.style.width = (v / tot * 100) + "%"; i.style.background = corDe(u); bar.append(i);
        const s = el("span"); const d = el("span", "dot"); d.style.background = corDe(u); s.append(d, `${u === uid ? "Você" : nomeDe(u)}: `, Object.assign(el("b", "num"), { textContent: brl(v) }), ` (${Math.round(v / tot * 100)}%)`); leg.append(s); });
      sp.append(bar, leg); if (souDono) sp.append(el("p", "note", "A parte de cada pessoa entra nas despesas dela.")); card.append(sp);
    }
    const act = el("div", "row-end");
    if (souDono && ct.limite) { const usado = comprometido(ct); act.append(el("span", "cc-meta", `Limite comprometido: ${brl(usado)} de ${brl(ct.limite)} (${Math.round(usado / ct.limite * 100)}%)`)); } else act.append(el("span"));
    if (tot > 0 && souDono) { const b = el("button", "btn sm" + (paga ? "" : " pri"), paga ? "Fatura paga ✓ (desfazer)" : "Marcar fatura como paga");
      b.onclick = async () => { b.disabled = true; try { await setDoc(doc(db, "cartoes", ct.id, "faturas", mes), { pago: !paga }); } catch (e) { falha(e); } b.disabled = false; }; act.append(b); }
    else if (tot > 0) act.append(el("span", "pill " + (paga ? "ok" : "pend"), paga ? "Fatura paga" : "Fatura em aberto"));
    card.append(act);
    const pl = el("div", "parc"); pl.append(el("span", "eyebrow", "Compras nesta fatura"));
    if (!ps.length) pl.append(el("p", "note", "Nenhuma compra nesta fatura."));
    ps.sort((a, b) => b.valor - a.valor).forEach(p => {
      const c = p.compra, row = el("div", "parc-row");
      const d = el("button", "d", c.descricao); d.type = "button"; d.onclick = () => abrirCompra(c);
      const falta = c.parcelas - (p.k + 1); let rest = 0; for (let k = p.k + 1; k < c.parcelas; k++) rest += valorParcela(c, k);
      row.append(d, el("span", "v", brl(p.valor)),
        el("span", "m", `${c.parcelas > 1 ? `Parcela ${p.k + 1} de ${c.parcelas}` : "À vista"} · ${c.comprador === uid ? "você" : nomeDe(c.comprador)} · ${c.categoria}`),
        el("span", "rest", c.parcelas > 1 ? (falta ? `faltam ${falta} · ${brl(rest)}` : "última parcela") : ""));
      if (c.parcelas > 1) { const pg = el("div", "prog"); for (let k = 0; k < c.parcelas; k++) pg.append(el("i", k < p.k ? "done" : k === p.k ? "now" : "")); row.append(pg); }
      pl.append(row);
    });
    card.append(pl);
    const fut = el("div", "fut"); fut.append(el("span", "eyebrow", "Já comprometido nas próximas faturas"));
    const prox = [1, 2, 3, 4, 5, 6].map(k => { const m = addMes(mes, k); return { m, v: parcelas(m).filter(p => p.cartao.id === ct.id && passaAmb(p) && (verTudo || vs.has(p.uid))).reduce((s, p) => s + p.valor, 0) }; });
    const mx = Math.max(...prox.map(x => x.v), 1);
    if (prox.every(x => !x.v)) fut.append(el("p", "note", "Nenhuma parcela futura."));
    else prox.forEach(x => { const rr = el("div", "fut-row"), tr = el("span", "track"), i = el("i"); i.style.width = (x.v / mx * 100) + "%"; tr.append(i); rr.append(el("span", "lbl", mesCurto(x.m)), tr, el("span", "num", brl(x.v))); fut.append(rr); });
    card.append(fut); box.append(card);
  });
}
function comprometido(ct) { const M = hojeISO().slice(0, 7), f = faturas(); let s = 0; compras().filter(c => c.cartao === ct.id).forEach(c => { const b = mesFatura(ct, c.data); for (let k = 0; k < c.parcelas; k++) { const m = addMes(b, k); if (m > M || (m === M && !f[ct.id + "_" + m]?.pago)) s += valorParcela(c, k); } }); return s; }

/* ===== formulário de lançamento ===== */
function catSel() { const [gi, ci] = $("#fCat").value.split("|").map(Number); const g = PLANO[tipo][gi]; return { g, cat: g.i[ci] }; }
function preencherCats(sel, t) { sel.textContent = ""; PLANO[t].forEach((g, gi) => { const og = document.createElement("optgroup"); og.label = `${g.g} (${AMB_NOME[g.a]})`; g.i.forEach((c, ci) => { const o = el("option", null, c); o.value = gi + "|" + ci; og.append(o); }); sel.append(og); }); }
function atualizarEmp() {
  const { g, cat } = catSel(), emp = g.a === "empresa"; $("#empBox").hidden = !emp;
  $("#lblContra").textContent = tipo === "receita" ? "Cliente / contratante" : cat === "Prestadores de serviço" ? "Prestador de serviço" : cat === "Contador" ? "Escritório de contabilidade" : "Fornecedor / órgão";
  $("#fDesc").placeholder = emp ? (tipo === "receita" ? "Ex.: Medição 2 — projeto estrutural" : "Ex.: Detalhamento de armaduras — 1ª parcela") : (g.g === "Caruaru" ? "Ex.: Almoço — obra Caruaru" : "Ex.: Conta de energia — outubro");
  $("#lblData").textContent = tipo === "receita" ? "Data do recebimento" : "Vencimento ou pagamento";
  const dl = (id, campo) => { const s = new Set(lancMes().concat(pendentes()).filter(l => l.uid === uid).map(l => l[campo]).filter(Boolean)); const d = $(id); d.textContent = ""; s.forEach(x => { const o = el("option"); o.value = x; d.append(o); }); };
  dl("#dlContra", "contraparte"); dl("#dlProj", "projeto");
}
function setTipo(t, val) {
  tipo = t; document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === t)));
  preencherCats($("#fCat"), t);
  if (val) $("#fCat").value = val; else if (ambF !== "todos") { const gi = PLANO[t].findIndex(g => g.a === ambF); if (gi >= 0) $("#fCat").value = gi + "|0"; }
  $("#pagoLbl").textContent = t === "receita" ? "Já foi recebido" : "Já está pago"; atualizarEmp();
}
function valorCat(l) { const gi = PLANO[l.tipo].findIndex(g => g.g === grupoDe(l)); if (gi < 0) return null; const ci = PLANO[l.tipo][gi].i.indexOf(l.categoria); return ci < 0 ? null : gi + "|" + ci; }
function fecharPaineis() { ["#form", "#ajPanel", "#formCompra", "#formCartao"].forEach(s => $(s).hidden = true); }
function abrirForm(l) {
  if (l && l.uid !== uid) { toast(`Lançamento de ${nomeDe(l.uid)}. Só essa pessoa pode alterar.`); return; }
  vista = "lanc"; renderVista(); fecharPaineis(); $("#iaBox").hidden = true; ocr = null; editId = l ? l.id : null;
  $("#excluir").hidden = !l;
  setTipo(l ? l.tipo : "despesa", l ? valorCat(l) : null);
  $("#fValor").value = l ? fmtIn(l.valor) : ""; $("#fDesc").value = l ? l.descricao : "";
  $("#fContra").value = l?.contraparte || ""; $("#fProj").value = l?.projeto || ""; $("#fDoc").value = l?.documento || "";
  $("#fData").value = l ? l.data : (mes === hojeISO().slice(0, 7) ? hojeISO() : mes + "-01"); $("#fPago").checked = l ? !!l.pago : false;
  $("#fRep").value = 1; $("#repWrap").hidden = !!l; $("#formTit").textContent = l ? "Editando lançamento" : "Novo lançamento";
  $("#form").hidden = false; $("#form").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
document.querySelectorAll(".seg button").forEach(b => b.onclick = () => setTipo(b.dataset.t));
$("#fCat").onchange = atualizarEmp;
$("#novo").onclick = () => abrirForm(null);
$("#cancelar").onclick = () => { $("#form").hidden = true; editId = null; ocr = null; };
$("#form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const valor = parseValor($("#fValor").value); if (!valor) { toast("Informe um valor maior que zero, ex.: 1.250,00"); $("#fValor").focus(); return; }
  const data = $("#fData").value, descricao = $("#fDesc").value.trim(); if (!data || !descricao) return;
  const { g, cat } = catSel(), emp = g.a === "empresa";
  const base = { tipo, valor, descricao, ambito: g.a, grupo: g.g, categoria: cat, pago: $("#fPago").checked,
    contraparte: emp ? $("#fContra").value.trim() : "", projeto: emp ? $("#fProj").value.trim() : "", documento: emp ? $("#fDoc").value.trim() : "" };
  if (ocr?.cnpj) base.cnpj = ocr.cnpj;
  const btn = $("#salvar"); btn.disabled = true;
  try {
    const col = collection(db, "users", uid, "lancamentos");
    if (editId) { await updateDoc(doc(col, editId), { ...base, data, mes: data.slice(0, 7) }); toast("Lançamento atualizado."); }
    else {
      const n = Math.max(1, Math.min(36, parseInt($("#fRep").value) || 1)), serie = n > 1 ? Date.now().toString(36) : null;
      for (let i = 0; i < n; i++) { const d = addMeses(data, i);
        await addDoc(col, { ...base, descricao: n > 1 ? `${descricao} (${i + 1}/${n})` : descricao, pago: i === 0 ? base.pago : false, documento: i === 0 ? base.documento : "", data: d, mes: d.slice(0, 7), serie, criadoEm: Date.now() + i }); }
      toast(n > 1 ? `${n} lançamentos criados.` : "Lançamento salvo.");
      if (data.slice(0, 7) !== mes) { mes = data.slice(0, 7); }
    }
    if (ocr?.cnpj) setDoc(doc(db, "users", uid, "regras", ocr.cnpj), { codigo: `${tipo}:${$("#fCat").value}`, contraparte: base.contraparte || ocr.emitente || "", nome: ocr.emitente || "" }).catch(console.error);
    $("#form").hidden = true; editId = null; ocr = null; agendar();
  } catch (e) { falha(e); }
  btn.disabled = false;
});
armar($("#excluir"), "Excluir", async () => { try { await deleteDoc(doc(db, "users", uid, "lancamentos", editId)); toast("Lançamento excluído."); $("#form").hidden = true; editId = null; } catch (e) { falha(e); } });

/* ===== leitura de nota por foto (OCR no celular) ===== */
function iaStatus(msg, prog) {
  $("#iaBox").hidden = false; $("#iaMsg").textContent = msg; $("#iaBox").classList.toggle("busy", prog != null);
  $("#ocrBar").hidden = prog == null; if (prog != null) $("#ocrBar i").style.width = Math.round(prog * 100) + "%";
}
$("#fotoBtn").onclick = () => { $("#fotoIn").value = ""; $("#fotoIn").click(); };
$("#fotoIn").onchange = async () => {
  const f = $("#fotoIn").files[0]; if (!f) return;
  abrirForm(null);
  try { $("#iaImg").src = URL.createObjectURL(f); } catch (e) {}
  iaStatus("Preparando a imagem…", 0); $("#salvar").disabled = true;
  try {
    const r = await lerNota(f, (p, msg) => iaStatus(msg, p));
    ocr = r;
    const regra = r.cnpj && regras()[r.cnpj];
    let sug = null, origem = "";
    if (regra?.codigo) { const [t, cod] = regra.codigo.split(":"); sug = { tipo: t, codigo: cod }; origem = "aprendida"; }
    else { sug = sugerirPorTexto(r.texto, PLANO); if (sug) origem = "texto"; }
    setTipo(sug?.tipo || "despesa", sug?.codigo || null);
    if (r.valor) $("#fValor").value = fmtIn(r.valor);
    if (r.data) $("#fData").value = r.data;
    $("#fDesc").value = (regra?.nome || r.emitente || "Nota fiscal").slice(0, 80);
    $("#fContra").value = regra?.contraparte || r.emitente || ""; $("#fDoc").value = r.documento || "";
    $("#fPago").checked = tipo === "despesa" && !/boleto|vencimento|guia|fatura/i.test(r.texto);
    const { g, cat } = catSel(), partes = [];
    partes.push(r.valor ? `Valor encontrado: ${brl(r.valor)}.` : "Não encontrei o valor; digite-o.");
    if (r.cnpj) partes.push(`CNPJ ${formatarCnpj(r.cnpj)}${r.qr ? " (pelo QR Code)" : ""}.`);
    partes.push(origem === "aprendida" ? `Categoria lembrada para este emitente: ${g.g} › ${cat}.` : origem === "texto" ? `Categoria sugerida: ${g.g} › ${cat}.` : "Escolha a categoria; da próxima vez, notas deste emitente já virão classificadas.");
    partes.push("Confira e toque em Salvar.");
    iaStatus(partes.join(" "));
  } catch (e) {
    console.error(e); ocr = null;
    iaStatus(e?.message === "sem_internet" ? "Para a primeira leitura é preciso internet (o leitor é baixado uma vez). Preencha manualmente ou tente de novo." : "Não consegui ler esta foto. Tente com a nota inteira, reta e bem iluminada, ou preencha manualmente.");
  } finally { $("#salvar").disabled = false; }
};

/* ===== compras no cartão ===== */
function calcCompra() {
  const v = parseValor($("#cValor").value), n = Math.max(1, parseInt($("#cParc").value) || 1), ct = cartoes().find(x => x.id === $("#cCartao").value), d = $("#cData").value;
  if (!v || !ct || !d) { $("#cCalc").textContent = "Informe cartão, valor, parcelas e data."; return; }
  const c = { valor: v, parcelas: n }, m0 = mesFatura(ct, d);
  $("#cCalc").textContent = `${n > 1 ? `${n} × ${brl(valorParcela(c, 1))}${valorParcela(c, 0) !== valorParcela(c, 1) ? ` (1ª de ${brl(valorParcela(c, 0))})` : ""}` : "À vista: " + brl(v)} · 1ª parcela na fatura de ${mesCurto(m0)} (vence ${dm(vencFatura(ct, m0))})${n > 1 ? ` · última em ${mesCurto(addMes(m0, n - 1))}` : ""}`;
}
["#cValor", "#cParc", "#cData", "#cCartao"].forEach(s => $(s).addEventListener("input", calcCompra));
function cartoesQuePossoUsar() { return cartoes().filter(ct => ct.dono === uid || (ct.autorizados || []).includes(uid)); }
function abrirCompra(c) {
  if (c && c.comprador !== uid) { toast(`Compra registrada por ${nomeDe(c.comprador)}. Só essa pessoa pode alterar.`); return; }
  const usaveis = cartoesQuePossoUsar();
  if (!usaveis.length) { toast("Cadastre seu cartão ou peça ao titular para autorizar você."); vista = "cartoes"; renderVista(); return; }
  vista = "cartoes"; renderVista(); fecharPaineis(); editCompra = c ? c.id : null;
  const sc = $("#cCartao"); sc.textContent = ""; usaveis.forEach(k => { const o = el("option", null, k.dono === uid ? k.nome : `${k.nome} (de ${k.donoNome || "outra pessoa"})`); o.value = k.id; sc.append(o); }); if (c) sc.value = c.cartao;
  sc.disabled = !!c;
  preencherCats($("#cCat"), "despesa");
  if (c) { const v = valorCat({ ...c, tipo: "despesa" }); if (v) $("#cCat").value = v; } else { const gi = PLANO.despesa.findIndex(g => g.g === "Despesas pessoais"); $("#cCat").value = gi + "|0"; }
  $("#cDesc").value = c ? c.descricao : ""; $("#cValor").value = c ? fmtIn(c.valor) : ""; $("#cParc").value = c ? c.parcelas : 1; $("#cData").value = c ? c.data : hojeISO();
  $("#compraTit").textContent = c ? "Editando compra no cartão" : "Nova compra no cartão"; $("#cExcluir").hidden = !c;
  calcCompra(); $("#formCompra").hidden = false; $("#formCompra").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
$("#novaCompra").onclick = () => abrirCompra(null);
$("#cCancelar").onclick = () => { $("#formCompra").hidden = true; editCompra = null; };
$("#formCompra").addEventListener("submit", async ev => {
  ev.preventDefault();
  const v = parseValor($("#cValor").value); if (!v) { toast("Informe o valor total da compra."); return; }
  const ct = cartoes().find(x => x.id === $("#cCartao").value); if (!ct) return;
  const [gi, ci] = $("#cCat").value.split("|").map(Number), g = PLANO.despesa[gi];
  const d = { cartao: ct.id, dono: ct.dono, comprador: uid, compradorNome: nomeDe(uid), descricao: $("#cDesc").value.trim(), valor: v,
    parcelas: Math.max(1, Math.min(48, parseInt($("#cParc").value) || 1)), data: $("#cData").value, tipo: "despesa", grupo: g.g, ambito: g.a, categoria: g.i[ci] };
  if (!d.descricao || !d.data) return;
  try {
    if (editCompra) await updateDoc(doc(db, "compras", editCompra), d); else await addDoc(collection(db, "compras"), { ...d, criadoEm: Date.now() });
    toast(editCompra ? "Compra atualizada." : "Compra registrada."); $("#formCompra").hidden = true; editCompra = null;
  } catch (e) { falha(e); }
});
armar($("#cExcluir"), "Excluir", async () => { try { await deleteDoc(doc(db, "compras", editCompra)); toast("Compra excluída."); $("#formCompra").hidden = true; editCompra = null; } catch (e) { falha(e); } });

function abrirCartao(ct) {
  vista = "cartoes"; renderVista(); fecharPaineis(); editCartao = ct ? ct.id : null;
  $("#kNome").value = ct ? ct.nome : ""; $("#kFecha").value = ct ? ct.fecha : ""; $("#kVence").value = ct ? ct.vence : ""; $("#kLim").value = ct?.limite ? fmtIn(ct.limite) : "";
  $("#cartaoTit").textContent = ct ? "Editando cartão" : "Novo cartão"; $("#kExcluir").hidden = !ct; $("#kAutWrap").hidden = !ct;
  renderAutorizados(ct); $("#formCartao").hidden = false; $("#kNome").focus();
}
function renderAutorizados(ct) {
  const box = $("#kAutList"); box.textContent = ""; if (!ct) return;
  const ids = ct.autorizados || [];
  if (!ids.length) box.append(el("p", "note", "Ninguém autorizado ainda."));
  ids.forEach(u => { const r = el("div", "share-row"); r.append(el("span", null, ct.autorizadosNomes?.[u] || "Pessoa"));
    const b = el("button", "btn sm danger", "Remover"); b.type = "button";
    armar(b, "Remover", async () => { try { await updateDoc(doc(db, "cartoes", ct.id), { autorizados: arrayRemove(u), [`autorizadosNomes.${u}`]: deleteField() }); renderAutorizados({ ...ct, autorizados: ids.filter(x => x !== u) }); } catch (e) { falha(e); } });
    r.append(b); box.append(r); });
}
async function buscarPessoa(email) {
  const e = emailKey(email); if (!e.includes("@")) { toast("Informe um e-mail válido."); return null; }
  if (e === emailKey(auth.currentUser.email)) { toast("Esse é o seu próprio e-mail."); return null; }
  const s = await getDoc(doc(db, "perfis", e));
  if (!s.exists()) { toast("Não há conta com esse e-mail. A pessoa precisa se cadastrar primeiro."); return null; }
  return s.data();
}
$("#kAutAdd").onclick = async () => {
  const ct = cartoes().find(x => x.id === editCartao); if (!ct) return;
  try { const p = await buscarPessoa($("#kAutEmail").value); if (!p) return;
    await updateDoc(doc(db, "cartoes", ct.id), { autorizados: arrayUnion(p.uid), [`autorizadosNomes.${p.uid}`]: p.nome || "Pessoa" });
    $("#kAutEmail").value = ""; toast(`${p.nome || "Pessoa"} pode lançar compras neste cartão.`); renderAutorizados({ ...ct, autorizados: [...new Set([...(ct.autorizados || []), p.uid])], autorizadosNomes: { ...ct.autorizadosNomes, [p.uid]: p.nome } });
  } catch (e) { falha(e); }
};
$("#cartaoBtn").onclick = () => abrirCartao(null);
$("#kCancelar").onclick = () => { $("#formCartao").hidden = true; editCartao = null; };
$("#formCartao").addEventListener("submit", async ev => {
  ev.preventDefault();
  const fecha = parseInt($("#kFecha").value), vence = parseInt($("#kVence").value);
  if (!(fecha >= 1 && fecha <= 31 && vence >= 1 && vence <= 31)) { toast("Dias de fechamento e vencimento devem estar entre 1 e 31."); return; }
  const lim = parseValor($("#kLim").value), d = { nome: $("#kNome").value.trim(), fecha, vence, limite: lim > 0 ? lim : 0, donoNome: nomeDe(uid) };
  if (!d.nome) return;
  try {
    if (editCartao) await updateDoc(doc(db, "cartoes", editCartao), d); else await addDoc(collection(db, "cartoes"), { ...d, dono: uid, autorizados: [], autorizadosNomes: {} });
    toast("Cartão salvo."); $("#formCartao").hidden = true; editCartao = null;
  } catch (e) { falha(e); }
});
armar($("#kExcluir"), "Excluir cartão", async () => {
  if (compras().some(c => c.cartao === editCartao)) { toast("Este cartão tem compras registradas. Exclua-as antes."); return; }
  try { await deleteDoc(doc(db, "cartoes", editCartao)); toast("Cartão excluído."); $("#formCartao").hidden = true; editCartao = null; } catch (e) { falha(e); }
});

/* ===== conta, compartilhamento e avisos ===== */
function abrirAjustes(focoWa) {
  fecharPaineis(); $("#ajPanel").hidden = false;
  $("#pNome").value = perfil.nome || ""; $("#cfgWa").value = privado.whatsapp || ""; $("#cfgDias").value = privado.dias || 5; $("#cfgKey").value = privado.callmebotKey || "";
  const sw = $("#pCor"); sw.textContent = "";
  for (let i = 0; i < 5; i++) { const b = el("button", "swb"); b.type = "button"; b.style.background = `var(--p${i})`; b.setAttribute("aria-label", "Cor " + (i + 1)); b.setAttribute("aria-pressed", String((perfil.cor || 0) === i)); b.onclick = () => { sw.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); sw.dataset.cor = i; }; sw.append(b); }
  sw.dataset.cor = perfil.cor || 0;
  renderShares(); $("#ajPanel").scrollIntoView({ block: "nearest", behavior: "smooth" }); if (focoWa) $("#cfgWa").focus();
}
function renderShares() {
  const box = $("#shareList"); box.textContent = ""; const ids = perfil.compartilhaCom || [];
  if (!ids.length) box.append(el("p", "note", "Você ainda não compartilha seus dados com ninguém."));
  ids.forEach(u => { const r = el("div", "share-row"); r.append(el("span", null, (perfil.compartilhaNomes || {})[u] || "Pessoa"));
    const b = el("button", "btn sm danger", "Parar de compartilhar"); b.type = "button";
    armar(b, "Parar de compartilhar", async () => { try { await updateDoc(doc(db, "users", uid), { compartilhaCom: arrayRemove(u), [`compartilhaNomes.${u}`]: deleteField() }); } catch (e) { falha(e); } });
    r.append(b); box.append(r); });
  const mine = new Set(ids), pend = sharers.filter(s => !mine.has(s.uid));
  $("#sharersInfo").textContent = sharers.length ? `Compartilham com você: ${sharers.map(s => s.nome).join(", ")}.${pend.length ? ` Compartilhe de volta com ${pend.map(s => s.nome).join(", ")} para que o balanço conjunto apareça também para ${pend.length > 1 ? "elas" : "essa pessoa"}.` : ""}` : "";
}
$("#shareAdd").onclick = async () => {
  try { const p = await buscarPessoa($("#shareEmail").value); if (!p) return;
    await updateDoc(doc(db, "users", uid), { compartilhaCom: arrayUnion(p.uid), [`compartilhaNomes.${p.uid}`]: p.nome || "Pessoa" });
    $("#shareEmail").value = ""; toast(`Agora ${p.nome || "essa pessoa"} vê seus lançamentos.`);
  } catch (e) { falha(e); }
};
$("#cfgSalvar").onclick = async () => {
  const w = $("#cfgWa").value.replace(/\D/g, ""); if (w && w.length < 10) { toast("Informe o número com DDD, ex.: (81) 9 0000-0000."); return; }
  const nome = $("#pNome").value.trim() || perfil.nome || "Eu", cor = +($("#pCor").dataset.cor || 0);
  try {
    await setDoc(doc(db, "users", uid), { nome, cor }, { merge: true });
    await setDoc(doc(db, "perfis", emailKey(auth.currentUser.email)), { uid, nome });
    await setDoc(doc(db, "privado", uid), { whatsapp: w, dias: Math.max(1, Math.min(30, parseInt($("#cfgDias").value) || 5)), callmebotKey: $("#cfgKey").value.trim() }, { merge: true });
    if (nome !== auth.currentUser.displayName) updateProfile(auth.currentUser, { displayName: nome }).catch(() => {});
    toast("Dados salvos."); $("#ajPanel").hidden = true;
  } catch (e) { falha(e); }
};
$("#ajBtn").onclick = () => $("#ajPanel").hidden ? abrirAjustes() : ($("#ajPanel").hidden = true);
$("#ajFechar").onclick = () => $("#ajPanel").hidden = true;
armar($("#sair"), "Sair da conta", () => signOut(auth));

/* ===== navegação e exportação ===== */
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { vista = b.dataset.v; try { localStorage.setItem("fc-vista", vista); } catch (e) {} renderVista(); });
document.querySelectorAll("#amb button").forEach(b => b.onclick = () => { ambF = b.dataset.a; render(); });
$("#prev").onclick = () => { mes = addMes(mes, -1); agendar(); };
$("#next").onclick = () => { mes = addMes(mes, 1); agendar(); };
$("#csv").onclick = () => {
  const v = visiveis().slice().sort((a, b) => a.data.localeCompare(b.data)), q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["Data", "Tipo", "Âmbito", "Grupo", "Categoria", "Descrição", "Prestador/Cliente", "Projeto/Obra", "NF/Recibo", "Cartão", "Pessoa", "Valor", "Situação"];
  const linhas = [head.join(";")].concat(v.map(l => [l.data.split("-").reverse().join("/"), l.tipo === "receita" ? "Receita" : "Despesa", AMB_NOME[ambitoDe(l)], q(grupoDe(l)), q(l.categoria), q(l.descricao), q(l.contraparte), q(l.projeto), q(l.documento), q(l.virtual ? l.cartao.nome : ""), q(nomeDe(l.uid)), (l.tipo === "receita" ? "" : "-") + fmtIn(l.valor), l.pago ? (l.tipo === "receita" ? "Recebido" : "Pago") : (l.tipo === "receita" ? "A receber" : "A pagar")].join(";")));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + linhas.join("\r\n")], { type: "text/csv" })); a.download = `financas-${mes}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ===== login ===== */
let modo = "entrar";
function setModo(m) {
  modo = m; $("#aErr").hidden = true;
  $("#nomeWrap").hidden = m !== "criar"; $("#senhaWrap").hidden = m === "recuperar";
  $("#aSenha").required = m !== "recuperar"; $("#aSenha").autocomplete = m === "criar" ? "new-password" : "current-password";
  $("#aBtn").textContent = { entrar: "Entrar", criar: "Criar conta", recuperar: "Enviar link para redefinir a senha" }[m];
  $("#authSub").textContent = { entrar: "Entre com seu e-mail e senha.", criar: "Crie sua conta. Seus dados ficam visíveis só para você até você decidir compartilhar.", recuperar: "Informe seu e-mail para receber o link de nova senha." }[m];
  $("#aModo").textContent = m === "entrar" ? "Criar conta" : "Já tenho conta"; $("#aEsqueci").hidden = m !== "entrar";
}
$("#aModo").onclick = () => setModo(modo === "entrar" ? "criar" : "entrar");
$("#aEsqueci").onclick = () => setModo("recuperar");
const ERROS = { "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/wrong-password": "E-mail ou senha incorretos.", "auth/user-not-found": "E-mail ou senha incorretos.", "auth/email-already-in-use": "Já existe uma conta com esse e-mail. Use “Já tenho conta”.", "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.", "auth/invalid-email": "E-mail inválido.", "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos.", "auth/network-request-failed": "Sem conexão com a internet.", "auth/admin-restricted-operation": "Novos cadastros estão desativados. Peça ao administrador para liberar." };
$("#authForm").addEventListener("submit", async ev => {
  ev.preventDefault(); const email = $("#aEmail").value.trim(), senha = $("#aSenha").value, btn = $("#aBtn"); btn.disabled = true; $("#aErr").hidden = true;
  try {
    if (modo === "entrar") await signInWithEmailAndPassword(auth, email, senha);
    else if (modo === "criar") {
      const nome = $("#aNome").value.trim(); if (!nome) { $("#aErr").textContent = "Informe seu nome."; $("#aErr").hidden = false; btn.disabled = false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, senha);
      await updateProfile(cred.user, { displayName: nome });
      await prepararConta(cred.user, nome);
    } else { await sendPasswordResetEmail(auth, email); toast("Enviamos o link para o seu e-mail."); setModo("entrar"); }
  } catch (e) { $("#aErr").textContent = ERROS[e.code] || "Não foi possível concluir. Tente de novo."; $("#aErr").hidden = false; console.error(e); }
  btn.disabled = false;
});
async function prepararConta(user, nome) {
  const ref = doc(db, "users", user.uid), s = await getDoc(ref);
  const n = nome || s.data()?.nome || user.displayName || user.email.split("@")[0];
  if (!s.exists()) await setDoc(ref, { nome: n, cor: 0, compartilhaCom: [], compartilhaNomes: {}, criadoEm: Date.now() });
  else if (nome && s.data().nome !== nome) await setDoc(ref, { nome }, { merge: true });
  await setDoc(doc(db, "perfis", emailKey(user.email)), { uid: user.uid, nome: n });
}
onAuthStateChanged(auth, async user => {
  cancelarTudo(); sharers = []; perfil = {}; privado = {}; filtro = "eu";
  if (!user) { uid = null; $("#app").hidden = true; $("#auth").hidden = false; setModo("entrar"); return; }
  uid = user.uid; $("#auth").hidden = true; $("#app").hidden = false;
  try { await prepararConta(user); } catch (e) { console.error(e); }
  agendar();
});

/* ===== instalação como aplicativo (PWA) ===== */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);
