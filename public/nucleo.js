// Finanças da Casa — regras de negócio puras (usadas pelo app e pelo script de lembretes)

/* Plano de contas: âmbito → grupo → categoria */
export const PLANO = {
  despesa: [
    { g: "Caruaru", a: "pessoal", i: ["Alimentação", "Transporte", "Estadia"] },
    { g: "Contas da casa", a: "pessoal", i: ["Energia elétrica", "Água", "Internet", "Gás", "Telefone / celular"] },
    { g: "Despesas pessoais", a: "pessoal", i: ["Mercado", "Moradia", "Saúde", "Educação", "Veículo", "Lazer", "Vestuário", "Outros"] },
    { g: "Empresa — indiretas", a: "empresa", i: ["Prestadores de serviço", "Contador", "Impostos", "Taxas e anuidades (CREA etc.)", "Software e licenças", "Outros"] }
  ],
  receita: [
    { g: "Empresa", a: "empresa", i: ["Serviço prestado à empresa", "Projetos estruturais externos", "Outras receitas da empresa"] },
    { g: "Pessoal", a: "pessoal", i: ["BlaBlaCar", "Reembolso", "Outros"] }
  ]
};
export const AMB_NOME = { pessoal: "Pessoal", empresa: "Empresa" };
export const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
export const MES3 = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

/* datas no formato AAAA-MM-DD / AAAA-MM */
export const pad = n => String(n).padStart(2, "0");
export const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function addMeses(iso, k) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1 + k, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(Math.min(d || 1, last))}`;
}
export const addDias = (iso, k) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + k); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
export const addMes = (m, k) => addMeses(m + "-01", k).slice(0, 7);
export const difMes = (a, b) => { const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number); return (by * 12 + bm) - (ay * 12 + am); };
export const diasNoMes = m => { const [y, mm] = m.split("-").map(Number); return new Date(y, mm, 0).getDate(); };
const utc = iso => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const difDias = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const dm = iso => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };
export const mesCurto = m => { const [y, mm] = m.split("-").map(Number); return `${MES3[mm - 1]}/${String(y).slice(2)}`; };

/* dinheiro em centavos */
export const brl = c => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export function parseValor(s) {
  s = String(s ?? "").trim().replace(/[R$\s]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const v = Math.round(parseFloat(s) * 100);
  return v > 0 ? v : NaN;
}
export const fmtIn = c => (c / 100).toFixed(2).replace(".", ",");

/* classificação de lançamentos antigos sem grupo/âmbito */
export function grupoDe(l) { if (l.grupo) return l.grupo; const g = PLANO[l.tipo]?.find(x => x.i.includes(l.categoria)); return g ? g.g : "Outros"; }
export function ambitoDe(l) { if (l.ambito) return l.ambito; const g = PLANO[l.tipo]?.find(x => x.g === grupoDe(l)); return g ? g.a : "pessoal"; }

/* ===== cartão de crédito =====
   Compra até o dia do fechamento entra na fatura que fecha naquele mês; depois, na do mês seguinte.
   Se o vencimento for depois do fechamento no mesmo mês, a fatura vence no mês do fechamento; senão, no mês seguinte.
   A fatura é identificada pelo mês do vencimento (AAAA-MM). */
export function mesFatura(ct, dataCompra) {
  const [y, m, d] = dataCompra.split("-").map(Number);
  let fech = `${y}-${pad(m)}`;
  if (d > ct.fecha) fech = addMes(fech, 1);
  return ct.vence > ct.fecha ? fech : addMes(fech, 1);
}
/* a primeira parcela absorve o arredondamento */
export const valorParcela = (c, k) => { const p = Math.floor(c.valor / c.parcelas); return k === 0 ? c.valor - p * (c.parcelas - 1) : p; };
export const vencFatura = (ct, m) => `${m}-${pad(Math.min(ct.vence, diasNoMes(m)))}`;
export function fechamentoFatura(ct, m) { const fm = ct.vence > ct.fecha ? m : addMes(m, -1); return `${fm}-${pad(Math.min(ct.fecha, diasNoMes(fm)))}`; }

/* parcelas que caem na fatura do mês m (lista de "lançamentos virtuais") */
export function parcelasNoMes(compras, cartoes, faturas, m) {
  const out = [];
  for (const c of compras) {
    const ct = cartoes.find(x => x.id === c.cartao);
    if (!ct) continue;
    const k = difMes(mesFatura(ct, c.data), m);
    if (k < 0 || k >= c.parcelas) continue;
    out.push({
      id: "cc_" + c.id + "_" + k, virtual: true, compra: c, cartao: ct, k,
      tipo: "despesa", valor: valorParcela(c, k),
      descricao: c.descricao + (c.parcelas > 1 ? ` (${k + 1}/${c.parcelas})` : ""),
      categoria: c.categoria, grupo: c.grupo, ambito: c.ambito,
      uid: c.comprador, data: vencFatura(ct, m), pago: !!faturas[ct.id + "_" + m]?.pago
    });
  }
  return out;
}

/* vencimentos dentro da janela (inclui atrasados) */
export function vencimentos({ pendentes, compras, cartoes, faturas, hoje, dias, incluirFaturaDe, rotuloFatura = ct => `Fatura ${ct.nome}` }) {
  const ate = addDias(hoje, dias);
  const out = pendentes.filter(l => l.tipo === "despesa" && !l.pago && l.data <= ate)
    .map(l => ({ data: l.data, d: l.descricao, m: `${grupoDe(l)} › ${l.categoria}`, v: l.valor, uid: l.uid }));
  const M = hoje.slice(0, 7);
  for (const ct of cartoes) for (const m of [addMes(M, -2), addMes(M, -1), M, addMes(M, 1)]) {
    if (faturas[ct.id + "_" + m]?.pago) continue;
    const v = vencFatura(ct, m);
    if (v > ate) continue;
    const ps = parcelasNoMes(compras, cartoes, faturas, m).filter(p => p.cartao.id === ct.id && incluirFaturaDe(p, ct));
    const tot = ps.reduce((s, p) => s + p.valor, 0);
    if (tot > 0) out.push({ data: v, d: rotuloFatura(ct), m: `${ps.length} parcela${ps.length > 1 ? "s" : ""} · ${mesCurto(m)}`, v: tot, fatura: true });
  }
  return out.sort((a, b) => a.data.localeCompare(b.data));
}

export function textoLembrete(lista, hoje) {
  return "*Finanças da Casa — vencimentos*\n" + lista.map(x => {
    const dd = difDias(hoje, x.data);
    return `• ${dm(x.data)}${dd < 0 ? " (ATRASADO)" : dd === 0 ? " (HOJE)" : ""} — ${x.d}: ${brl(x.v)}`;
  }).join("\n") + `\nTotal: ${brl(lista.reduce((s, x) => s + x.v, 0))}`;
}
