// Failure modes: a partial response is treated as finished; a resumed turn selects another conversation; a failed or
// waiting result is accepted; cumulative session totals or repeated step updates overcharge the current run; permission
// modes silently broaden access, and a login status check invokes a model or leaks configuration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import agy from "../plugins/agy/agent.ts";
import type { Turn } from "../worker/agents.ts";

const turn: Turn = {
  prompt: 'Read the supplied context; literal $(do-not-run) and "quotes".',
  session: "new-job-session",
  resume: null,
  cwd: "/workspace",
  access: "read",
  folder: "/runs/one",
  contextFile: "/runs/one/context.json",
  program: "/bin/agy",
  model: "example-model",
  effort: "medium",
};
const line = (event: unknown) => JSON.stringify(event) + "\n";
const init = line({ event: "init", conversation_id: "conversation-one", init: { permission_mode: "request-review" } });
const step = (index: number, usage?: object, extra = {}) =>
  line({
    event: "step_update",
    step_update: {
      conversation_id: "conversation-one",
      step_index: index,
      state: "DONE",
      step_type: "agent_response",
      usage,
      ...extra,
    },
  });
const result = (status = "SUCCESS", extra = {}) =>
  line({
    event: "result",
    result: {
      conversation_id: "conversation-one",
      status,
      response: "已完成",
      num_turns: 2,
      usage: { input_tokens: 9000, output_tokens: 900, cache_read_tokens: 8000 },
      ...extra,
    },
  });

test("agy runs one literal prompt in plan mode and resumes only the specified conversation", () => {
  const args = agy.command(turn);
  assert.equal(args[0], turn.program);
  assert.ok(args.includes("--output-format=stream-json"));
  assert.ok(args.includes("--mode=plan"));
  assert.ok(!args.includes("--disable-slash-commands"), "agy 1.5.1 ignores --mode when slash commands are disabled");
  assert.ok(args.includes("--model=example-model"));
  assert.ok(args.includes("--effort=medium"));
  assert.ok(args.includes("--add-dir=/runs/one"));
  assert.equal(args.at(-1), `--print=${turn.prompt}`);
  assert.ok(
    !args.some((x) => x.startsWith("--conversation") || x === "--continue" || x === "--dangerously-skip-permissions"),
  );
  const resumed = agy.command({ ...turn, resume: "original-session" });
  assert.ok(resumed.includes("--conversation=original-session"));
  assert.ok(resumed.includes("--mode=plan"));
  assert.ok(agy.command({ ...turn, access: "edit" }).includes("--mode=accept-edits"));
  assert.ok(agy.command({ ...turn, access: "full" }).includes("--dangerously-skip-permissions"));
});

test("an accepted turn carries its session but no partial response; only a successful result completes it", () => {
  const accepted = line({
    event: "step_update",
    step_update: { conversation_id: "conversation-one", step_index: 0, state: "DONE", step_type: "user_input" },
  });
  assert.equal(agy.read(init, null, "").session, "conversation-one");
  assert.ok(!agy.read(init, null, "").started);
  const partial = agy.read(init + accepted + step(1, undefined, { state: "ACTIVE", text_delta: "尚未完成" }), null, "");
  assert.equal(partial.started, true);
  assert.equal(partial.text, undefined);
  assert.equal(partial.finished, undefined);
  const complete = agy.read(init + accepted + result(), null, "");
  assert.equal(complete.text, "已完成");
  assert.equal(complete.finished, true);
  assert.equal(complete.started, true);
  const truncated = agy.read(init + accepted + '{"event":"result",', 1, "connection lost");
  assert.equal(truncated.session, "conversation-one");
  assert.equal(truncated.started, true);
  assert.equal(truncated.text, undefined);
  assert.ok(truncated.error);
});

test("only current invocation steps count, with repeated updates deduplicated and final session totals ignored", () => {
  const output =
    init +
    step(2, { input_tokens: 10, output_tokens: 5, cache_read_tokens: 4 }) +
    step(2, { input_tokens: 10, output_tokens: 5, cache_read_tokens: 4 }) +
    step(3, { input_tokens: 2, output_tokens: 1 }) +
    result();
  assert.deepEqual(agy.read(output, 0, "").usage, { input: 12, output: 6, cached: 4 });
  assert.equal(agy.read(output, 0, "").sessionUsage, undefined);
  assert.equal(agy.read(result(), 0, "").usage, undefined);
  const failed = agy.read(
    init + step(1, { input_tokens: 4, output_tokens: 2 }) + result("ERROR", { error: "model unavailable" }),
    1,
    "",
  );
  assert.deepEqual(failed.usage, { input: 4, output: 2 });
  assert.match(failed.error!, /model unavailable/);
});

test("waiting, canceled, errors, empty responses and nonzero exits never become successful business results", () => {
  for (const status of ["WAITING", "RUNNING", "CANCELED", "INTERRUPTED", "INVALID", "ERROR"]) {
    const reading = agy.read(init + result(status), 0, "");
    assert.equal(reading.text, undefined);
    assert.equal(reading.finished, true);
    assert.ok(reading.error, status);
  }
  assert.ok(agy.read(init + result("SUCCESS", { response: "" }), 0, "").error);
  assert.ok(agy.read(init + result(), 1, "process failed").error);
  assert.ok(agy.read(init, 0, "").error);
  assert.doesNotThrow(() => agy.read('null\n42\n[]\n{"event":"step_update","step_update":null}\n', null, ""));
});

test("a later incomplete or failed turn cannot reuse an earlier result", () => {
  const incomplete = agy.read(init + result() + step(8, undefined, { state: "ACTIVE" }), null, "");
  assert.equal(incomplete.text, undefined);
  assert.equal(incomplete.finished, undefined);
  const failed = agy.read(init + result() + result("ERROR", { error: "later failure" }), 1, "");
  assert.equal(failed.text, undefined);
  assert.match(failed.error!, /later failure/);
});

test("doctor checks the configured CLI model command without starting a model or printing authentication output", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-agy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const program = join(dir, "agy");
  const write = (status: string) => {
    writeFileSync(
      program,
      `#!/bin/sh\n[ "$*" = "--output-format=json --print=/model" ] || exit 7\nprintf '%s\\n' '${JSON.stringify({ status, command: { name: "model", data: { id: "example-model" } }, response: "DO_NOT_LOG_CONFIG" })}'\n`,
    );
    chmodSync(program, 0o755);
  };
  write("SUCCESS");
  assert.equal(agy.check!(program), null);
  write("ERROR");
  const error = agy.check!(program);
  assert.ok(error);
  assert.ok(!error.includes("DO_NOT_LOG_CONFIG"));
});

test("the installed agent plugin imports without the source checkout's host and worker directories", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-autoloop-agy-installed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "agent.ts");
  copyFileSync(join(import.meta.dirname, "../plugins/agy/agent.ts"), file);
  const script = `const module = await import(${JSON.stringify(pathToFileURL(file).href)}); if(typeof module.default.command !== 'function') process.exit(3);`;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(done.status, 0, done.stderr);
});
