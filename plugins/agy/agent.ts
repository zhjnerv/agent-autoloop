// Antigravity CLI print mode runs one turn and exits. The conversation ID, not --continue, binds later work to its task.
import { execFileSync } from "node:child_process";
import type { Adapter, Reading, Usage } from "../../worker/agents.ts";

const MODE = { read: "plan", edit: "accept-edits", full: "auto" };

function stepUsage(value: any): Usage | undefined {
  if (!value || typeof value !== "object") return;
  const usage: Usage = {};
  for (const [from, to] of [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cache_read_tokens", "cached"],
  ] as const) {
    if (typeof value[from] === "number" && Number.isFinite(value[from]) && value[from] >= 0) usage[to] = value[from];
  }
  return Object.keys(usage).length ? usage : undefined;
}

export default {
  command: (turn) => [
    turn.program ?? "agy",
    "--output-format=stream-json",
    `--mode=${MODE[turn.access]}`,
    `--add-dir=${turn.folder}`,
    ...(turn.access === "full" ? ["--dangerously-skip-permissions"] : []),
    ...(turn.model ? [`--model=${turn.model}`] : []),
    ...(turn.effort ? [`--effort=${turn.effort}`] : []),
    ...(turn.resume ? [`--conversation=${turn.resume}`] : []),
    `--print=${turn.prompt}`,
  ],
  read(stdout, code, stderr): Reading {
    const reading: Reading = {};
    const steps = new Map<number, Usage>();
    let final: any;
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      if (event.event === "init" && typeof event.conversation_id === "string" && event.conversation_id) {
        reading.session = event.conversation_id;
      } else if (event.event === "step_update" && event.step_update && typeof event.step_update === "object") {
        const step = event.step_update;
        if (typeof step.conversation_id === "string" && step.conversation_id) reading.session = step.conversation_id;
        if (
          (step.step_type === "user_input" && step.state === "DONE") ||
          ["agent_response", "tool"].includes(step.step_type)
        )
          reading.started = true;
        final = undefined;
        const usage = stepUsage(step.usage);
        if (step.state === "DONE" && Number.isSafeInteger(step.step_index) && usage) steps.set(step.step_index, usage);
      } else if (event.event === "result" && event.result && typeof event.result === "object") {
        final = event.result;
        if (typeof final.conversation_id === "string" && final.conversation_id) reading.session = final.conversation_id;
      }
    }
    // result.usage can include earlier conversation turns. Count only this process's completed steps, once per index.
    for (const usage of steps.values()) {
      reading.usage ??= {};
      for (const field of ["input", "output", "cached"] as const) {
        if (usage[field] !== undefined) reading.usage[field] = (reading.usage[field] ?? 0) + usage[field];
      }
    }
    if (final) {
      reading.finished = true;
      if (final.status === "SUCCESS" && typeof final.response === "string" && final.response.trim()) {
        reading.text = final.response;
        reading.started = true;
      } else
        reading.error =
          typeof final.error === "string" && final.error.trim()
            ? final.error
            : `agy 没有完成并留下实际结果：${String(final.status ?? "缺少状态")}`;
    }
    if (code !== null && (code !== 0 || !reading.finished)) {
      delete reading.text;
      reading.error =
        reading.error ||
        (code !== 0 ? `agy 退出码 ${code}：${stderr.trim().slice(-300) || "未完成"}` : "agy 未返回最终结果");
    }
    return reading;
  },
  check(program) {
    try {
      // /model is handled by the CLI itself, without an inference call; do not print its account/configuration output.
      const response = execFileSync(program ?? "agy", ["--output-format=json", "--print=/model"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const status = JSON.parse(response);
      return status.status === "SUCCESS" &&
        status.command?.name === "model" &&
        typeof status.command?.data?.id === "string"
        ? null
        : "agy 当前配置不可用：先在本机运行 agy 完成登录并选择模型";
    } catch {
      return "agy 无法启动或读取模型配置：核对程序路径，并在本机运行 agy 完成登录";
    }
  },
} satisfies Adapter;
