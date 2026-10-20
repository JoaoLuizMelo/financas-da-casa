// Finanças da Casa — aviso diário de vencimentos no WhatsApp (gratuito, via CallMeBot).
// Roda no GitHub Actions todo dia; lê os dados com uma conta de serviço do Firebase.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { hojeISO, vencimentos, textoLembrete } from "../public/nucleo.js";

const conta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!conta.project_id) { console.error("Defina o segredo FIREBASE_SERVICE_ACCOUNT com o JSON da conta de serviço."); process.exit(1); }
initializeApp({ credential: cert(conta) });
const db = getFirestore();
const lista = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
const hoje = hojeISO(); // o workflow define TZ=America/Recife
const testar = process.argv.includes("--testar");

const privados = await db.collection("privado").get();
for (const p of privados.docs) {
  const uid = p.id, cfg = p.data();
  const num = String(cfg.whatsapp || "").replace(/\D/g, ""), chave = String(cfg.callmebotKey || "").trim();
  if (num.length < 10 || !chave) continue;
  const pendentes = (await db.collection(`users/${uid}/lancamentos`).where("pago", "==", false).get()).docs.map(d => ({ id: d.id, ...d.data(), uid }));
  const compras = [...new Map([
    ...lista(await db.collection("compras").where("comprador", "==", uid).get()),
    ...lista(await db.collection("compras").where("dono", "==", uid).get())
  ].map(c => [c.id, c])).values()];
  const idsCartao = new Set(compras.map(c => c.cartao));
  lista(await db.collection("cartoes").where("dono", "==", uid).get()).forEach(c => idsCartao.add(c.id));
  const cartoes = [], faturas = {};
  for (const id of idsCartao) {
    const s = await db.doc(`cartoes/${id}`).get(); if (!s.exists) continue;
    cartoes.push({ id, ...s.data() });
    (await db.collection(`cartoes/${id}/faturas`).get()).docs.forEach(f => faturas[`${id}_${f.id}`] = f.data());
  }
  const itens = vencimentos({
    pendentes, compras, cartoes, faturas, hoje, dias: +cfg.dias || 5,
    incluirFaturaDe: (parc, ct) => ct.dono === uid || parc.uid === uid,
    rotuloFatura: ct => ct.dono === uid ? `Fatura ${ct.nome}` : `Sua parte na fatura ${ct.nome}`
  });
  if (!itens.length && !testar) { console.log(`${uid}: nada a avisar`); continue; }
  const texto = itens.length ? textoLembrete(itens, hoje) : "Finanças da Casa: teste de aviso — nenhum vencimento nos próximos dias.";
  const fone = num.length <= 11 ? "55" + num : num;
  const url = `https://api.callmebot.com/whatsapp.php?phone=%2B${fone}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(chave)}`;
  const r = await fetch(url);
  console.log(`${uid}: ${itens.length} item(ns), CallMeBot respondeu ${r.status}`);
  await new Promise(ok => setTimeout(ok, 3000)); // o CallMeBot pede intervalo entre mensagens
}
