// «Їж, щоб рости» — сервер підписки за Telegram Stars (Cloudflare Worker).
//
// Що потрібно в Cloudflare (Settings → Variables and Secrets / Bindings):
//   BOT_TOKEN       секрет — токен бота з BotFather (НІКОМУ не показувати)
//   WEBHOOK_SECRET  секрет — будь-який довгий випадковий рядок (лише латиниця, цифри, _ і -)
//   PRICE_STARS     змінна — ціна за місяць у Stars, напр. 150
//   APP_URL         змінна — адреса міні-додатку, напр. https://sviato-slave.github.io/Project_bot/
//   SUPPORT         змінна — контакт підтримки, напр. @nickname
//   ADMIN_ID        змінна (необов'язково) — твій Telegram ID для команд /stats і /refund
//   SUBS            KV-сховище (binding) — тут зберігаються підписки
//
// Після публікації відкрий у браузері:  https://<твій-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>

const MONTH = 30 * 24 * 60 * 60;          // єдиний період, який дозволяє Telegram
const GRACE_MS = 12 * 60 * 60 * 1000;     // запас на продовження підписки
const enc = new TextEncoder();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": originOf(env.APP_URL),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname === "/webhook" && req.method === "POST") return await webhook(req, env);
      if (url.pathname === "/api/status" && req.method === "POST") return json(await status(req, env), 200, cors);
      if (url.pathname === "/api/invoice" && req.method === "POST") return json(await invoice(req, env), 200, cors);
      if (url.pathname === "/setup") return json(await setup(url, env));
      return new Response("ok");
    } catch (e) {
      const code = e.status || 500;
      return json({ error: e.message || "error" }, code, url.pathname.startsWith("/api/") ? cors : {});
    }
  },
};

/* ---------- helpers ---------- */
const originOf = u => { try { return new URL(u).origin; } catch { return "*"; } };
const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const fail = (status, message) => Object.assign(new Error(message), { status });
const price = env => Math.max(1, parseInt(env.PRICE_STARS || "150", 10));

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!j.ok) throw fail(502, `${method}: ${j.description || "telegram error"}`);
  return j.result;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

// Перевірка підпису initData від Telegram (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyInit(initData, env) {
  if (!initData || typeof initData !== "string") throw fail(401, "no initData");
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) throw fail(401, "no hash");
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  const sig = hex(await hmac(secret, dcs));
  if (sig.length !== hash.length || !timingSafe(sig, hash)) throw fail(401, "bad signature");
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 7 * 24 * 3600)) throw fail(401, "initData expired");
  const user = JSON.parse(p.get("user") || "null");
  if (!user || !user.id) throw fail(401, "no user");
  return user;
}
function timingSafe(a, b) { let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function readBody(req) { try { return await req.json(); } catch { throw fail(400, "bad json"); } }
async function getSub(env, uid) { const v = await env.SUBS.get(`sub:${uid}`); return v ? JSON.parse(v) : null; }

/* ---------- API for the mini app ---------- */
async function status(req, env) {
  const { initData } = await readBody(req);
  const user = await verifyInit(initData, env);
  const sub = await getSub(env, user.id);
  const paid = !!(sub && sub.until + GRACE_MS > Date.now());
  return { paid, until: sub ? sub.until : 0, price: price(env) };
}

async function invoice(req, env) {
  const { initData } = await readBody(req);
  const user = await verifyInit(initData, env);
  const link = await tg(env, "createInvoiceLink", {
    title: "Їж, щоб рости — підписка",
    description: "Меню на весь тиждень, список покупок, заготовка, заміни страв і свій розклад. Продовжується щомісяця, скасувати можна будь-коли.",
    payload: `sub:${user.id}`,
    currency: "XTR",
    prices: [{ label: "Місяць доступу", amount: price(env) }],
    subscription_period: MONTH,
  });
  return { link };
}

/* ---------- Telegram webhook ---------- */
async function webhook(req, env) {
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  const u = await req.json();

  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const ok = q.currency === "XTR" && q.total_amount === price(env) && q.invoice_payload === `sub:${q.from.id}`;
    await tg(env, "answerPreCheckoutQuery", ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: "Рахунок застарів. Відкрий додаток і спробуй ще раз." });
    return new Response("ok");
  }

  const m = u.message;
  if (!m) return new Response("ok");

  if (m.successful_payment) {
    const sp = m.successful_payment;
    const until = sp.subscription_expiration_date ? sp.subscription_expiration_date * 1000 : Date.now() + MONTH * 1000;
    await env.SUBS.put(`sub:${m.from.id}`, JSON.stringify({
      until, charge: sp.telegram_payment_charge_id, amount: sp.total_amount,
      recurring: !!sp.is_recurring, updated: Date.now(),
    }));
    if (!sp.is_recurring || sp.is_first_recurring) {
      await tg(env, "sendMessage", { chat_id: m.chat.id, text: `Дякую! Підписка активна до ${dateUA(until)}. Повний доступ уже відкритий — онови додаток.`, reply_markup: appButton(env) });
    }
    return new Response("ok");
  }

  const text = (m.text || "").trim();
  const isAdmin = env.ADMIN_ID && String(m.from.id) === String(env.ADMIN_ID);

  if (text.startsWith("/start")) {
    await tg(env, "sendMessage", { chat_id: m.chat.id, reply_markup: appButton(env), text:
      "Привіт! Це «Їж, щоб рости» — меню на масу чи рельєф з домашньої їжі, підігнане під твої калорії й бюджет.\n\n" +
      "1. Відкрий додаток кнопкою нижче.\n2. У «Профілі» введи вагу, зріст, активність і ціль.\n3. Отримай меню, список покупок і план заготовки.\n\n" +
      `Калькулятор і меню на понеділок — безкоштовно. Повний тиждень — ${price(env)} ⭐ на місяць.` });
  } else if (text.startsWith("/paysupport")) {
    await tg(env, "sendMessage", { chat_id: m.chat.id, text:
      `Питання щодо оплати чи повернення — пиши ${env.SUPPORT || "у цей чат"}. Відповімо протягом 1–2 днів.\n\n` +
      "Скасувати підписку: Налаштування Telegram → Мої зірки → Підписки. Доступ лишиться до кінця оплаченого місяця." });
  } else if (text.startsWith("/terms")) {
    await tg(env, "sendMessage", { chat_id: m.chat.id, text:
      `Умови: підписка ${price(env)} ⭐ на 30 днів, продовжується автоматично, поки ти її не скасуєш. ` +
      "Додаток дає орієнтовний план харчування для здорових дорослих 18+ і не є медичною порадою. " +
      `Якщо щось не працює — /paysupport, розглянемо повернення.` });
  } else if (isAdmin && text.startsWith("/stats")) {
    const list = await env.SUBS.list({ prefix: "sub:" });
    let active = 0;
    for (const k of list.keys) { const s = JSON.parse((await env.SUBS.get(k.name)) || "{}"); if (s.until > Date.now()) active++; }
    await tg(env, "sendMessage", { chat_id: m.chat.id, text: `Активних підписок: ${active} (усього записів: ${list.keys.length}).` });
  } else if (isAdmin && text.startsWith("/refund")) {
    const [, uid] = text.split(/\s+/);
    const sub = uid && await getSub(env, uid);
    if (!sub) { await tg(env, "sendMessage", { chat_id: m.chat.id, text: "Формат: /refund <user_id>. Підписку не знайдено." }); }
    else {
      await tg(env, "refundStarPayment", { user_id: Number(uid), telegram_payment_charge_id: sub.charge });
      await env.SUBS.put(`sub:${uid}`, JSON.stringify({ ...sub, until: 0, refunded: Date.now() }));
      await tg(env, "sendMessage", { chat_id: m.chat.id, text: `Повернено ${sub.amount} ⭐ користувачу ${uid}.` });
    }
  }
  return new Response("ok");
}

const appButton = env => ({ inline_keyboard: [[{ text: "Відкрити додаток", web_app: { url: env.APP_URL } }]] });
const dateUA = ms => new Date(ms).toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "Europe/Kyiv" });

/* ---------- one-time setup ---------- */
async function setup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) throw fail(403, "wrong key");
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET", "APP_URL"].filter(k => !env[k]);
  if (!env.SUBS) missing.push("SUBS (KV)");
  if (missing.length) throw fail(400, "не вистачає: " + missing.join(", "));
  const hook = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "pre_checkout_query"], drop_pending_updates: true,
  });
  const cmds = await tg(env, "setMyCommands", { commands: [
    { command: "start", description: "Відкрити додаток" },
    { command: "paysupport", description: "Питання щодо оплати" },
    { command: "terms", description: "Умови підписки" },
  ] });
  const me = await tg(env, "getMe");
  return { ok: true, bot: "@" + me.username, webhook: hook, commands: cmds, price: price(env) };
}
