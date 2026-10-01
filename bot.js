// Bot de promoções de PS5 -> Telegram. Sem dependências (Node 18+).
// Uso: node bot.js            (envia de verdade)
//      node bot.js --dry      (só mostra o que enviaria, sem mandar nem gravar)
const fs = require("fs");
const path = require("path");

const DRY = process.argv.includes("--dry");
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = path.join(__dirname, "state.json");

// ---------- CONFIGURAÇÃO ----------
const CONFIG = {
  // Só lojas confiáveis (comparado com o nome da loja no Promobit, sem acento/caixa)
  lojasConfiaveis: [
    "amazon", "magazine luiza", "magalu", "mercado livre", "kabum",
    "americanas", "casas bahia", "ponto", "fast shop", "carrefour",
    "playstation", "sony", "submarino", "shoptime", "nuuvem", "girafa",
  ],
  // Mercado Livre/Amazon têm vendedores terceiros; marque true pra aceitar só vendido/entregue pela loja
  // (o Promobit nem sempre informa isso, então fica como aviso na mensagem)
  precoMin: 1500, // abaixo disso é jogo/acessório, não console
  precoMax: 6000, // acima disso ignora (ex.: PS5 Pro). Ajuste como quiser.
  // Re-avisar se o MESMO anúncio baixar de preço pelo menos esse tanto (R$)
  quedaMinimaParaReavisar: 50,
  // Páginas do Promobit a olhar (categoria PS5, páginas 1 e 2)
  paginas: [
    "https://www.promobit.com.br/promocoes/playstation-5/s/",
    "https://www.promobit.com.br/promocoes/playstation-5/s/?page=2",
    "https://www.promobit.com.br/promocoes/playstation-5/s/?page=3",
    "https://www.promobit.com.br/promocoes/playstation-5/s/?page=4",
    "https://www.promobit.com.br/promocoes/games/",
  ],
};

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// É console? (PS5 / PlayStation 5 + palavras de console) e não acessório/jogo
const reConsole = /(ps\s?5|playstation\s?5|play\s?5)/;
const reTipo = /(console|digital|slim|bundle|midia fisica|standard)/;
const reExclui = /(jogo|dualsense|controle|headset|fone|capa|faceplate|suporte|cabo|carregador|base|camera|pulse|midia digital|gift|cartao|psn|assinatura|ps plus|steelbook|volante|case|skin|adesivo)/;

function ehConsole(o) {
  const t = norm(o.offerTitle);
  if (!reConsole.test(t)) return false;
  if (reExclui.test(t) && !/console/.test(t)) return false;
  if (!(reTipo.test(t) || /pro\b/.test(t))) {
    // título tipo "PlayStation 5" puro: aceita só se o preço for de console
  }
  return o.offerPrice >= CONFIG.precoMin && o.offerPrice <= CONFIG.precoMax;
}

function lojaConfiavel(o) {
  const l = norm(o.storeName);
  return CONFIG.lojasConfiaveis.some((x) => l.includes(norm(x)));
}

async function pegarOfertas(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error(`${url} -> sem __NEXT_DATA__ (site mudou?)`);
  const pp = JSON.parse(m[1]).props.pageProps;
  return (pp.serverOffers && pp.serverOffers.offers) || [];
}

const brl = (n) => "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

function mensagem(o, motivo) {
  const link = `https://www.promobit.com.br/oferta/${o.offerSlug}`;
  const antigo = o.offerOldPrice > 1 ? ` (antes ${brl(o.offerOldPrice)}, -${Math.round(o.offerDiscontPercentage)}%)` : "";
  const cupom = o.offerCoupon ? `\n🎟 Cupom: ${o.offerCoupon}` : "";
  return `🎮 ${motivo}\n${o.offerTitle}\n💰 ${brl(o.offerPrice)}${antigo}\n🏬 ${o.storeName}${cupom}\n🔗 ${link}\n⚠️ Confira se é vendido/entregue pela própria loja.`;
}

async function telegram(texto) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: texto, disable_web_page_preview: false }),
  });
  if (!r.ok) throw new Error("Telegram: " + (await r.text()));
}

async function main() {
  if (!DRY && (!TOKEN || !CHAT_ID)) throw new Error("Faltam TELEGRAM_TOKEN e TELEGRAM_CHAT_ID");
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};

  const todas = new Map();
  for (const url of CONFIG.paginas) {
    try {
      for (const o of await pegarOfertas(url)) todas.set(o.offerId, o);
    } catch (e) {
      console.error("Aviso:", e.message);
    }
  }
  if (!todas.size) throw new Error("Nenhuma oferta lida: site fora do ar ou mudou o formato");

  const aEnviar = [];
  for (const o of todas.values()) {
    if (o.offerStatusName && o.offerStatusName !== "APPROVED") continue;
    if (!ehConsole(o) || !lojaConfiavel(o)) continue;
    const visto = state[o.offerId];
    if (!visto) aEnviar.push([o, "NOVA PROMOÇÃO DE PS5"]);
    else if (visto.preco - o.offerPrice >= CONFIG.quedaMinimaParaReavisar)
      aEnviar.push([o, `PREÇO CAIU (era ${brl(visto.preco)})`]);
  }

  console.log(`Lidas ${todas.size} ofertas, ${aEnviar.length} pra enviar.`);
  for (const [o, motivo] of aEnviar) {
    const txt = mensagem(o, motivo);
    if (DRY) { console.log("\n" + txt); continue; }
    await telegram(txt);
    state[o.offerId] = { preco: o.offerPrice, em: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); // grava a cada envio
  }
}

main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
