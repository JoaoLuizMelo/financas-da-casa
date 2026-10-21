// Alicerce — leitura de nota fiscal no próprio celular (gratuita, sem servidor)
// Usa Tesseract.js (OCR) e jsQR (QR Code da NFC-e), carregados sob demanda.

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js";
const JSQR = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

const carregados = {};
function carregar(src) {
  return carregados[src] ??= new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => { delete carregados[src]; erro(new Error("sem_internet")); };
    document.head.append(s);
  });
}

/* reduz, converte para cinza e reforça o contraste — melhora muito cupom térmico */
async function prepararCanvas(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < px.length; i += 4) { const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = y; if (y < min) min = y; if (y > max) max = y; }
  const esc = 255 / Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) { const y = (px[i] - min) * esc; px[i] = px[i + 1] = px[i + 2] = y; }
  const original = g.getImageData(0, 0, c.width, c.height);
  g.putImageData(img, 0, 0);
  return { canvas: c, original };
}

/* ===== interpretação do texto ===== */
const DINHEIRO = /(\d{1,3}(?:[.\s]\d{3})*,\d{2})(?!\d)/g;
const paraCentavos = s => Math.round(parseFloat(s.replace(/[.\s]/g, "").replace(",", ".")) * 100);

export function extrairValor(texto) {
  const linhas = texto.split(/\n/).map(l => l.trim()).filter(Boolean);
  const chaves = [
    /valor\s*(a\s*)?pag(ar|o)/i, /total\s*a\s*pagar/i, /valor\s*total\s*(da\s*nota|do\s*documento|dos?\s*servi[cç]os?)?/i,
    /valor\s*l[ií]quido/i, /total\s*(geral|r\$)/i, /^\s*total\b/i, /valor\s*do\s*documento/i, /\btotal\b/i
  ];
  for (const re of chaves) {
    for (let i = 0; i < linhas.length; i++) {
      if (!re.test(linhas[i])) continue;
      if (/troco|desconto|tributos|impostos?\s*aprox|lei\s*12\.?741/i.test(linhas[i])) continue;
      const aqui = [...linhas[i].matchAll(DINHEIRO)].map(m => paraCentavos(m[1]));
      if (aqui.length) return aqui[aqui.length - 1];
      const prox = linhas[i + 1] && [...linhas[i + 1].matchAll(DINHEIRO)].map(m => paraCentavos(m[1]));
      if (prox && prox.length) return prox[prox.length - 1];
    }
  }
  const todos = [...texto.matchAll(DINHEIRO)].map(m => paraCentavos(m[1])).filter(v => v > 0 && v < 1e9);
  return todos.length ? Math.max(...todos) : null;
}

export function extrairData(texto) {
  const prefer = texto.match(/(emiss[aã]o|data|vencimento)[^\n]{0,25}?(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})/i);
  const m = prefer ? prefer.slice(2) : (texto.match(/(\d{2})[\/.-](\d{2})[\/.-](20\d{2}|\d{2})(?!\d)/) || []).slice(1);
  if (m.length < 3) return null;
  let [d, mm, y] = m.map(Number);
  if (y < 100) y += 2000;
  if (mm < 1 || mm > 12 || d < 1 || d > 31 || y < 2015 || y > 2100) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function cnpjValido(c) {
  c = String(c).replace(/\D/g, "");
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
export function extrairCnpj(texto) {
  for (const m of texto.matchAll(/(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})[\/\s]?(\d{4})[-\s]?(\d{2})/g)) {
    const c = m.slice(1).join("");
    if (cnpjValido(c)) return c;
  }
  return null;
}
export const formatarCnpj = c => c ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : "";

export function extrairEmitente(texto) {
  const linhas = texto.split(/\n/).map(l => l.trim()).filter(l => l.length >= 4);
  const ruido = /documento auxiliar|nota fiscal|nfc-?e|cupom|danfe|cnpj|cpf|ie[:\s]|inscri|endere|rua |av\.|avenida|cep|fone|tel|www|http|consumidor|extrato|^\d/i;
  const l = linhas.slice(0, 8).find(x => !ruido.test(x) && /[A-Za-zÀ-ú]{3}/.test(x));
  return l ? l.replace(/\s{2,}/g, " ").slice(0, 60) : "";
}

export function extrairDocumento(texto) {
  const nfse = texto.match(/(nfs-?e|nota fiscal de servi[cç]os?)[^\n]{0,30}?n[ºo°.]?\s*[:\-]?\s*(\d{1,10})/i);
  if (nfse) return `NFS-e ${+nfse[2]}`;
  const nf = texto.match(/\b(nf-?e|nfc-?e|nota)[^\n]{0,20}?n[ºo°.]?\s*[:\-]?\s*(\d{1,10})/i);
  if (nf) return `${/nfc/i.test(nf[1]) ? "NFC-e" : "NF"} ${+nf[2]}`;
  const rec = texto.match(/recibo[^\n]{0,15}?n[ºo°.]?\s*[:\-]?\s*(\d{1,10})/i);
  if (rec) return `Recibo ${+rec[1]}`;
  if (/documento de arrecada[cç][aã]o do simples|\bdas\b.*simples/i.test(texto)) return "DAS";
  return "";
}

/* QR Code da NFC-e: chave de 44 dígitos (CNPJ do emitente, ano/mês, número) e, na emissão offline, o valor */
export function lerQrNfce(conteudo) {
  if (!conteudo) return null;
  const p = (conteudo.match(/[?&]p=([^&]+)/i) || [])[1];
  const partes = (p ? decodeURIComponent(p) : conteudo).split("|");
  const chave = (partes[0].match(/\d{44}/) || [])[0];
  if (!chave) return null;
  const out = { chave, cnpj: chave.slice(6, 20), anoMes: `20${chave.slice(2, 4)}-${chave.slice(4, 6)}`, numero: String(+chave.slice(25, 34)) };
  if (partes.length >= 5 && /^\d{1,2}$/.test(partes[3]) && /^\d+(\.\d{1,2})?$/.test(partes[4])) {
    out.dia = partes[3].padStart(2, "0"); out.valor = Math.round(parseFloat(partes[4]) * 100);
  }
  return out;
}

/* categoria sugerida pelo texto (usada quando o emitente ainda não foi aprendido) */
const PISTAS = [
  [/simples nacional|documento de arrecada[cç][aã]o|darf|receita federal|\biss(qn)?\b|\binss\b|guia de recolhimento/i, "despesa", "Empresa — indiretas", "Impostos"],
  [/contabil|contador|escrit[oó]rio cont/i, "despesa", "Empresa — indiretas", "Contador"],
  [/crea\b|confea|anuidade/i, "despesa", "Empresa — indiretas", "Taxas e anuidades (CREA etc.)"],
  [/nfs-?e|nota fiscal de servi[cç]o|recibo de pagamento aut[oô]nomo|\brpa\b/i, "despesa", "Empresa — indiretas", "Prestadores de serviço"],
  [/neoenergia|celpe|energia el[eé]trica|kwh/i, "despesa", "Contas da casa", "Energia elétrica"],
  [/compesa|saneamento|[aá]gua e esgoto/i, "despesa", "Contas da casa", "Água"],
  [/internet|fibra|banda larga|provedor/i, "despesa", "Contas da casa", "Internet"],
  [/\bg[aá]s\b|ultragaz|liquig[aá]s|supergasbras|copergas/i, "despesa", "Contas da casa", "Gás"],
  [/hotel|pousada|hospedagem|airbnb/i, "despesa", "Caruaru", "Estadia"],
  [/restaurante|lanchonete|padaria|churrascaria|refei[cç][aã]o|self[- ]?service|pizzaria|marmita/i, "despesa", "Caruaru", "Alimentação"],
  [/posto|combust[ií]vel|gasolina|etanol|diesel|ped[aá]gio|recarga|estacionamento|uber|99app/i, "despesa", "Caruaru", "Transporte"],
  [/supermercado|atacad|mercadinho|hortifruti|a[cç]ougue|assa[ií]/i, "despesa", "Despesas pessoais", "Mercado"],
  [/farm[aá]cia|drogaria|cl[ií]nica|laborat[oó]rio|hospital/i, "despesa", "Despesas pessoais", "Saúde"]
];
export function sugerirPorTexto(texto, PLANO) {
  for (const [re, t, g, c] of PISTAS) {
    if (!re.test(texto)) continue;
    const gi = PLANO[t].findIndex(x => x.g === g); const ci = gi >= 0 ? PLANO[t][gi].i.indexOf(c) : -1;
    if (ci >= 0) return { tipo: t, codigo: `${gi}|${ci}` };
  }
  return null;
}

/* ===== leitura completa ===== */
export async function lerNota(file, aoProgredir = () => {}) {
  aoProgredir(0.02, "Preparando a imagem…");
  const { canvas, original } = await prepararCanvas(file);
  let qr = null;
  try {
    await carregar(JSQR);
    const r = window.jsQR(original.data, original.width, original.height);
    qr = lerQrNfce(r?.data);
  } catch (e) { /* QR é opcional */ }
  aoProgredir(0.08, "Carregando o leitor (só na primeira vez demora)…");
  await carregar(TESSERACT);
  const res = await window.Tesseract.recognize(canvas, "por", {
    logger: m => { if (m.status === "recognizing text") aoProgredir(0.1 + 0.9 * m.progress, "Lendo a nota…"); }
  });
  const texto = res.data.text || "";
  const cnpj = qr?.cnpj && cnpjValido(qr.cnpj) ? qr.cnpj : extrairCnpj(texto);
  let data = extrairData(texto);
  if (!data && qr?.dia) data = `${qr.anoMes}-${qr.dia}`;
  return {
    texto,
    valor: qr?.valor || extrairValor(texto),
    data,
    cnpj,
    emitente: extrairEmitente(texto),
    documento: extrairDocumento(texto) || (qr ? `NFC-e ${qr.numero}` : ""),
    qr: !!qr,
    confianca: res.data.confidence
  };
}
