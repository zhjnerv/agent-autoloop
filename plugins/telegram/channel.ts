// A single-owner private chat. Telegram's message IDs and update cursor survive restart; business decisions stay in the hub.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { parseEnv } from "node:util";
import type { Card, ChannelContext } from "../../host/channels.ts";

type Message = { message_id: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean } };
type Update = {
  update_id: number;
  callback_query?: { id: string; from: { id: number }; data?: string; message?: Message };
  message?: Message & { text?: string; reply_to_message?: Message };
};
type Mapping = { card: number; message: number; version: number; reported: number };

class TelegramError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function render(card: Card) {
  const parts = [card.title, card.text].filter(Boolean);
  const open = card.state === "open";
  if (open && card.options.length) parts.push(card.options.map((text, i) => `${i + 1}. ${text}`).join("\n"));
  if (card.state === "decided" || card.state === "done") {
    const choice = card.choice === null ? card.answer : card.options[card.choice];
    if (choice) parts.push(`你选了：${choice}`);
    if (card.state === "decided") parts.push("已记录，等待处理。");
  }
  if (card.kind === "notice" && card.answer) parts.push(`处理说明：${card.answer}`);
  if (card.result) parts.push(card.result);
  if (card.state === "closed" && !card.result) parts.push("已结束。");
  const text = parts.join("\n\n");
  // Fail visibly instead of cutting off a choice or a result beyond Telegram's sendMessage limit.
  if (text.length > 4096) throw new Error("Telegram 卡片超过 4096 字符，请缩短正文或选项");
  return {
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: open
        ? card.options.map((label, i) => [
            {
              text: `${i + 1}. ${Array.from(label).slice(0, 60).join("")}${i === card.recommend ? "（建议）" : ""}`,
              callback_data: `al:${card.id}:${i}`,
            },
          ])
        : [],
    },
  };
}

/** Opens one authenticated connection; each operation is also exercised against a local HTTP stand-in. */
export async function connect({ hub, options, log, signal }: ChannelContext) {
  const home = process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop");
  const envFile = String(options.envFile ?? join(home, "secrets", "telegram.env"));
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = env.TELEGRAM_USER_ID?.trim(),
    chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("Telegram env 缺少 TELEGRAM_BOT_TOKEN");
  if (!owner || !chat || !/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(Number(owner)) || chat !== owner) {
    throw new Error("Telegram 需要已核实的本人 USER_ID 和对应私聊 CHAT_ID");
  }
  const redact = (error: unknown) => String(error).replaceAll(token, "[redacted]");
  let base = "https://api.telegram.org";
  if (options.testApiBase !== undefined) {
    const test = new URL(String(options.testApiBase));
    if (
      test.protocol !== "http:" ||
      test.hostname !== "127.0.0.1" ||
      test.username ||
      test.password ||
      test.pathname !== "/"
    ) {
      throw new Error("测试 API 只允许本机 127.0.0.1 HTTP 服务");
    }
    base = test.origin;
  }
  let limitedUntil = 0;
  async function api<T = any>(method: string, body: object = {}, timeout = 20_000): Promise<T> {
    while (Date.now() < limitedUntil) await pause(limitedUntil - Date.now(), undefined, { signal });
    let response: Response;
    try {
      response = await fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
    } catch {
      throw new Error(`Telegram ${method} 网络请求失败`);
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Telegram ${method} 返回非 JSON 响应`);
    }
    if (!response.ok || !data?.ok) {
      const status = Number(data?.error_code ?? response.status);
      const retry = Number(data?.parameters?.retry_after);
      if (status === 429 && Number.isFinite(retry) && retry > 0)
        limitedUntil = Math.max(limitedUntil, Date.now() + retry * 1000);
      throw new TelegramError(status, `Telegram ${method} ${status}: ${redact(data?.description ?? "请求失败")}`);
    }
    return data.result as T;
  }
  const me = await api<{ id: number; is_bot: boolean }>("getMe");
  if (!me?.is_bot || !Number.isSafeInteger(me.id)) throw new Error("Telegram 机器人身份无效");
  const hook = await api<{ url: string }>("getWebhookInfo");
  if (hook.url) throw new Error("Telegram 已设置 Webhook，请先核对旧接收程序；本通道不会删除它");
  const file = resolve(String(options.stateFile ?? join(home, "channels", "telegram", "state.sqlite")));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  try {
    chmodSync(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (card INTEGER PRIMARY KEY, message INTEGER UNIQUE NOT NULL,
        version INTEGER NOT NULL, reported INTEGER NOT NULL);`);
    const identity = JSON.stringify({ bot: me.id, chat, owner });
    const previous = db.prepare("SELECT value FROM meta WHERE key = 'identity'").get()?.value;
    if (previous !== undefined && previous !== identity)
      throw new Error("Telegram 身份或私聊目标变化，请为新身份指定独立状态文件");
    db.prepare("INSERT OR IGNORE INTO meta VALUES ('identity', ?)").run(identity);
  } catch (error) {
    close();
    throw error;
  }
  const ref = (message: number) => `${chat}:${message}`;
  const byCard = (id: number) => db.prepare("SELECT * FROM messages WHERE card = ?").get(id) as Mapping | undefined;
  const byMessage = (id: number) =>
    db.prepare("SELECT * FROM messages WHERE message = ?").get(id) as Mapping | undefined;

  async function send(card: Card) {
    const payload = render(card);
    let mapping = byCard(card.id);
    let message = mapping?.message;
    if (card.ref !== null) {
      const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(card.ref);
      if (!match || match[1] !== chat || !Number.isSafeInteger(Number(match[2])))
        throw new Error("Telegram 卡片原消息不属于本私聊");
      if (message !== undefined && message !== Number(match[2])) throw new Error("Telegram 原消息与本地记录不一致");
      message = Number(match[2]);
    }
    if (message !== undefined) {
      try {
        await api("editMessageText", { chat_id: chat, message_id: message, ...payload });
      } catch (error) {
        if (!(error instanceof TelegramError && error.status === 400 && /message is not modified/i.test(error.message)))
          throw error;
      }
    } else {
      const sent = await api<Message>("sendMessage", { chat_id: chat, ...payload });
      if (!Number.isSafeInteger(sent?.message_id) || String(sent.chat?.id) !== chat)
        throw new Error("Telegram 未返回本私聊的消息编号");
      message = sent.message_id;
    }
    // Persist the ID before reporting delivery. A lost report can then edit this message after restart, never resend it.
    db.prepare(
      `INSERT INTO messages VALUES (?, ?, ?, ?)
      ON CONFLICT(card) DO UPDATE SET version = excluded.version, reported = excluded.reported`,
    ).run(card.id, message, card.version, card.ref !== null || mapping?.reported ? 1 : 0);
    await hub.delivered(card.id, card.version, ref(message));
    db.prepare("UPDATE messages SET reported = 1 WHERE card = ?").run(card.id);
  }

  const privateMessage = (message?: Message) => message?.chat?.type === "private" && String(message.chat.id) === chat;
  async function handle(update: Update) {
    const callback = update.callback_query,
      message = update.message;
    let mapping: Mapping | undefined;
    let given: { choice?: number; text?: string };
    if (callback) {
      if (String(callback.from?.id) !== owner || !privateMessage(callback.message)) return;
      if (callback.message!.from && callback.message!.from.id !== me.id) return;
      const data = /^al:([1-9][0-9]*):([0-9]+)$/.exec(callback.data ?? "");
      if (!data || !Number.isSafeInteger(Number(data[1])) || !Number.isSafeInteger(Number(data[2]))) return;
      mapping = byMessage(callback.message!.message_id);
      if (!mapping || mapping.card !== Number(data[1])) return;
      given = { choice: Number(data[2]) };
    } else {
      if (!message || String(message.from?.id) !== owner || !privateMessage(message)) return;
      const original = message.reply_to_message;
      if (!original || original.from?.id !== me.id || !privateMessage(original)) return;
      if (typeof message.text !== "string" || !message.text.trim()) return;
      mapping = byMessage(original.message_id);
      if (!mapping) return;
      given = { text: message.text };
    }
    if (!mapping.reported) throw new Error("Telegram 原消息尚未完成送达确认，稍后继续处理回答");
    let acknowledgement: string;
    try {
      const result = await hub.answer(mapping.card, { ...given, by: owner, ref: ref(mapping.message) });
      acknowledgement = result.changed ? "已记录" : "这张卡片已经处理过了";
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 400 && status !== 404) throw error;
      acknowledgement = "回答未被接受，请查看原卡片或缩短文字";
      log(`card ${mapping.card}: ${redact(error)}`);
    }
    // Once the hub committed, a callback that has expired must not hold its update forever.
    if (callback)
      await api("answerCallbackQuery", { callback_query_id: callback.id, text: acknowledgement }).catch((error) =>
        log(redact(error)),
      );
  }

  async function poll(wait = 30) {
    let offset = Number(db.prepare("SELECT value FROM meta WHERE key = 'offset'").get()?.value ?? 0);
    const updates = await api<Update[]>(
      "getUpdates",
      {
        offset,
        timeout: wait,
        limit: 100,
        allowed_updates: ["message", "callback_query"],
      },
      (wait + 15) * 1000,
    );
    if (!Array.isArray(updates)) throw new Error("Telegram 更新列表无效");
    for (const update of updates) {
      if (signal.aborted) return;
      if (!Number.isSafeInteger(update.update_id)) throw new Error("Telegram 更新编号无效");
      if (update.update_id < offset) continue;
      await handle(update);
      // getUpdates confirms only the updates below its next offset; record it after the hub accepted the answer.
      offset = update.update_id + 1;
      db.prepare("INSERT INTO meta VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(offset),
      );
    }
  }
  return { send, poll, close, redact };
}

export default async function telegram(context: ChannelContext): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const connection = await connect({ ...context, signal });
  let conflict = false;
  async function loop(receive: boolean) {
    while (!signal.aborted) {
      let card: Card | null = null;
      try {
        if (receive) await connection.poll();
        else {
          ({ card } = await context.hub.nextCard(10));
          if (card && !signal.aborted) await connection.send(card);
        }
      } catch (error) {
        if (signal.aborted) return;
        context.log(connection.redact(error));
        if (error instanceof TelegramError && error.status === 409) {
          conflict = true;
          stop.abort();
          return;
        }
        if (card) await context.hub.failed(card.id, card.version, connection.redact(error)).catch(() => {});
        await pause(10_000, undefined, { signal }).catch(() => {});
      }
    }
  }
  try {
    await Promise.all([loop(false), loop(true)]);
  } finally {
    stop.abort();
    connection.close();
  }
  if (conflict && !context.signal.aborted) {
    context.log("Telegram 409：另有程序接收这个 Bot，本通道已停止；解决占用后重启服务。");
    await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}
