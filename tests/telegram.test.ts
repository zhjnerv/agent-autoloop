// Failure modes: a lost delivery report sends twice; a forged sender, chat or message answers a card; the update cursor
// advances before the answer commits; restart loses message bindings; API errors leak credentials or ignore retry_after.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Card, ChannelContext } from "../host/channels.ts";
import telegram, { connect } from "../plugins/telegram/channel.ts";

const TOKEN = "123:fake-secret-for-tests";
const card: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "确认结果",
  text: "<b>这是普通文字</b>",
  options: ["继续", "暂停"],
  recommend: 0,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agent-autoloop-telegram-"));
  const envFile = join(directory, "telegram.env");
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\nTELEGRAM_USER_ID=42\n`, { mode: 0o600 });
  const calls: { method: string; body: any; at: number }[] = [];
  const delivered: unknown[][] = [],
    answers: unknown[][] = [],
    lines: string[] = [];
  const stop = new AbortController();
  let handler = (_method: string, _body: any): any => undefined;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text || "{}");
    const method = req.url!.split("/").at(-1)!;
    calls.push({ method, body, at: Date.now() });
    const result =
      handler(method, body) ??
      (
        {
          getMe: { ok: true, result: { id: 123, is_bot: true, username: "fixture_bot" } },
          getWebhookInfo: { ok: true, result: { url: "" } },
          sendMessage: { ok: true, result: { message_id: 70, chat: { id: 42, type: "private" } } },
          editMessageText: { ok: true, result: true },
          getUpdates: { ok: true, result: [] },
          answerCallbackQuery: { ok: true, result: true },
        } as Record<string, unknown>
      )[method];
    res.writeHead(result.ok ? 200 : (result.error_code ?? 500), { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hub = {
    async nextCard() {
      await pause(5);
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      delivered.push(args);
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      return { changed: true };
    },
  };
  const options = {
    envFile,
    stateFile: join(directory, "state.sqlite"),
    testApiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
  const context: ChannelContext = { hub, options, log: (line) => lines.push(line), signal: stop.signal };
  t.after(() => {
    stop.abort();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    context,
    calls,
    delivered,
    answers,
    lines,
    stop,
    envFile,
    on: (next: typeof handler) => {
      handler = next;
    },
  };
}

function click(id: number, overrides: any = {}) {
  return {
    update_id: id,
    callback_query: {
      id: `click-${id}`,
      from: { id: 42 },
      data: "al:5:0",
      message: { message_id: 70, chat: { id: 42, type: "private" }, from: { id: 123, is_bot: true } },
      ...overrides,
    },
  };
}

test("a card sends plain words and buttons, and a settled card edits the same message", async (t) => {
  const f = await fixture(t),
    c = await connect(f.context);
  t.after(() => c.close());
  await c.send(card);
  const sent = f.calls.find((x) => x.method === "sendMessage")!.body;
  assert.match(sent.text, /<b>这是普通文字<\/b>/);
  assert.equal(sent.parse_mode, undefined);
  assert.deepEqual(
    sent.reply_markup.inline_keyboard.map((r: any[]) => r[0].callback_data),
    ["al:5:0", "al:5:1"],
  );
  assert.deepEqual(f.delivered, [[5, 1, "42:70"]]);
  await c.send({ ...card, version: 2, ref: "42:70", state: "done", choice: 0, result: "已完成" });
  const edited = f.calls.find((x) => x.method === "editMessageText")!.body;
  assert.equal(edited.message_id, 70);
  assert.deepEqual(edited.reply_markup.inline_keyboard, []);
  assert.match(edited.text, /已完成/);
  assert.equal(f.calls.filter((x) => x.method === "sendMessage").length, 1);
});

test("a lost hub delivery report survives restart without sending a second message", async (t) => {
  const f = await fixture(t);
  let c = await connect(f.context);
  const delivered = f.context.hub.delivered;
  f.context.hub.delivered = async () => {
    throw new Error("hub disconnected");
  };
  await assert.rejects(c.send(card), /hub disconnected/);
  c.close();
  f.context.hub.delivered = delivered;
  f.on((method) =>
    method === "editMessageText"
      ? { ok: false, error_code: 400, description: "Bad Request: message is not modified" }
      : undefined,
  );
  c = await connect(f.context);
  t.after(() => c.close());
  await c.send(card);
  assert.equal(f.calls.filter((x) => x.method === "sendMessage").length, 1);
  assert.deepEqual(f.delivered, [[5, 1, "42:70"]]);
});

test("only the configured owner on the original private message can answer; replayed updates are skipped", async (t) => {
  const f = await fixture(t);
  let c = await connect(f.context);
  await c.send(card);
  c.close();
  c = await connect(f.context);
  t.after(() => c.close());
  const updates = [
    click(1, { from: { id: 43 } }),
    click(2, { message: { message_id: 70, chat: { id: -42, type: "group" } } }),
    click(3, { message: { message_id: 71, chat: { id: 42, type: "private" } } }),
    click(4, { message: { message_id: 70, chat: { id: 42, type: "private" }, from: { id: 999 } } }),
    click(5, { data: "al:6:0" }),
    click(6),
    click(6),
  ];
  f.on((method) => (method === "getUpdates" ? { ok: true, result: updates } : undefined));
  await c.poll(0);
  await c.poll(0);
  assert.deepEqual(f.answers, [[5, { choice: 0, by: "42", ref: "42:70" }]]);
  assert.equal(f.calls.filter((x) => x.method === "getUpdates").at(-1)!.body.offset, 7);
});

test("a failed answer does not acknowledge updates, and an expired callback acknowledgment cannot lose a committed answer", async (t) => {
  const f = await fixture(t);
  let c = await connect(f.context);
  await c.send(card);
  const answer = f.context.hub.answer;
  f.context.hub.answer = async () => {
    throw new Error("hub unreachable");
  };
  f.on((method) => (method === "getUpdates" ? { ok: true, result: [click(10)] } : undefined));
  await assert.rejects(c.poll(0), /hub unreachable/);
  c.close();
  f.context.hub.answer = answer;
  c = await connect(f.context);
  t.after(() => c.close());
  f.on((method) =>
    method === "getUpdates"
      ? { ok: true, result: [click(10)] }
      : method === "answerCallbackQuery"
        ? { ok: false, error_code: 400, description: "query is too old" }
        : undefined,
  );
  await c.poll(0);
  await c.poll(0);
  assert.equal(f.answers.length, 1);
  const polls = f.calls.filter((x) => x.method === "getUpdates");
  assert.equal(polls[0].body.offset, polls[1].body.offset);
  assert.equal(polls.at(-1)!.body.offset, 11);
});

test("text replies need the same owner and a recorded bot message; ordinary chat never becomes an answer", async (t) => {
  const f = await fixture(t),
    c = await connect(f.context);
  t.after(() => c.close());
  await c.send(card);
  const reply = { message_id: 70, from: { id: 123, is_bot: true }, chat: { id: 42, type: "private" } };
  const message = { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "另选时间", reply_to_message: reply };
  f.on((method) =>
    method === "getUpdates"
      ? {
          ok: true,
          result: [
            { update_id: 1, message: { ...message, reply_to_message: undefined } },
            { update_id: 2, message: { ...message, from: { id: 43 } } },
            { update_id: 3, message: { ...message, reply_to_message: { ...reply, from: { id: 999 } } } },
            { update_id: 4, message },
          ],
        }
      : undefined,
  );
  await c.poll(0);
  assert.deepEqual(f.answers, [[5, { text: "另选时间", by: "42", ref: "42:70" }]]);
});

test("a callback waits for the initial delivery report instead of losing an early click", async (t) => {
  const f = await fixture(t),
    c = await connect(f.context);
  t.after(() => c.close());
  const report = f.context.hub.delivered;
  f.context.hub.delivered = async () => {
    throw new Error("report lost");
  };
  await assert.rejects(c.send(card));
  f.on((method) => (method === "getUpdates" ? { ok: true, result: [click(12)] } : undefined));
  await assert.rejects(c.poll(0), /送达/);
  assert.equal(f.answers.length, 0);
  f.context.hub.delivered = report;
  await c.send(card);
  await c.poll(0);
  assert.equal(f.answers.length, 1);
});

test("rate limits delay the next request and API errors redact the token", async (t) => {
  const f = await fixture(t),
    c = await connect(f.context);
  t.after(() => c.close());
  f.on((method) =>
    method === "sendMessage"
      ? { ok: false, error_code: 429, description: `limited ${TOKEN}`, parameters: { retry_after: 1 } }
      : undefined,
  );
  await assert.rejects(c.send(card), (e: Error) => !e.message.includes(TOKEN) && /429/.test(e.message));
  await c.poll(0);
  const sent = f.calls.find((x) => x.method === "sendMessage")!,
    polled = f.calls.find((x) => x.method === "getUpdates")!;
  assert.ok(polled.at - sent.at >= 950);
  assert.equal(JSON.stringify(f.lines).includes(TOKEN), false);
});

test("a changed bot or chat cannot reuse another identity's saved messages, and a webhook is never removed", async (t) => {
  const f = await fixture(t);
  const c = await connect(f.context);
  c.close();
  writeFileSync(f.envFile, readFileSync(f.envFile, "utf8").replace("CHAT_ID=42", "CHAT_ID=43"));
  await assert.rejects(connect(f.context), /身份|私聊/);
  writeFileSync(f.envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\nTELEGRAM_USER_ID=42\n`);
  f.on((method) =>
    method === "getWebhookInfo" ? { ok: true, result: { url: "https://existing.test/hook" } } : undefined,
  );
  await assert.rejects(connect(f.context), /Webhook/);
  assert.equal(
    f.calls.some((x) => x.method === "deleteWebhook"),
    false,
  );
});

test("oversized cards fail before sending and token loading stays local to the plugin", async (t) => {
  const before = process.env.TELEGRAM_BOT_TOKEN;
  const f = await fixture(t),
    c = await connect(f.context);
  t.after(() => c.close());
  await assert.rejects(c.send({ ...card, text: "x".repeat(4096) }), /4096/);
  assert.equal(
    f.calls.some((x) => x.method === "sendMessage"),
    false,
  );
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, before);
});

test("a polling conflict stops this channel until restart, without another polling request", async (t) => {
  const f = await fixture(t);
  f.on((method) => {
    if (method !== "getUpdates") return undefined;
    setTimeout(() => f.stop.abort(), 60);
    return { ok: false, error_code: 409, description: "Conflict: another getUpdates" };
  });
  await telegram(f.context);
  assert.equal(f.calls.filter((x) => x.method === "getUpdates").length, 1);
  assert.ok(f.lines.some((line) => /409/.test(line)));
});
