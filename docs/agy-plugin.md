# agy 后台 Agent

[agy 插件](../plugins/agy/agent.ts) 使用 Antigravity CLI 的单次 print 模式。每轮打印最终结果后退出，问题的回答通过指定 conversation_id 恢复原会话，沿用 [Agent 插件约定](plugins.md#agent-插件)。

## 配置

先在运行用户的交互终端完成 agy 登录，用 `agy models` 查看当前可用模型。插件不会替用户登录或复制凭据。

在私有 rules.json 的 agents 中增加 agy，将需要切换的规则的 to 指向它。示意项如下，program 使用本机程序或包装脚本的绝对路径；model 使用本机查询到的有效标识：

```json
{
  "agy": {
    "name": "Antigravity CLI",
    "worker": "已登记的接单程序编号",
    "use": "agy",
    "program": "/path/to/agy",
    "model": "填写本机可用的模型标识",
    "access": "read",
    "timeout": 3
  }
}
```

作为本机插件使用时，将 agent.ts 放进数据目录的 `plugins/agy/agent.ts`。插件运行时只依赖 Node 标准库；源码中的类型导入由 Node 擦除，不要求本机插件目录旁边存在引擎源码。

| access | 启动参数 |
|---|---|
| read | `--mode=plan` |
| edit | `--mode=accept-edits` |
| full | `--mode=auto --dangerously-skip-permissions`，仅用于明确授权的完整权限任务 |

mode 是 agy 的工具执行策略，不是操作系统文件隔离。后台无法弹出权限确认，所需工具应预先按任务范围授权；不要为方便试跑开启 full。agy 1.5.1 在禁用斜杠命令时会忽略 mode，因此插件没有传 `--disable-slash-commands`。

需要实例专用设置时，可用 program 包装脚本给 agy 传 `--settings`，再原样转交参数。配置只对本次会话生效，模型、权限及其他规则仍应由可信配置决定；尽量放行具体只读工具，不整体开放 MCP 或命令执行。

## 结果和用量

- 输出采用 stream-json，只有最终 SUCCESS 且 response 非空时才交业务结果；WAITING、空结果、失败或中断均不伪报成功。
- 工具运行或模型接受输入后的进度保留会话编号；续办使用明确的 `--conversation`，不使用可能选中其他任务的 `--continue`。
- result.usage 可能包含以前的会话用量。插件仅累加当前进程的已完成 step_update 用量，并按 step_index 去重；没有当前步骤用量时不猜测。
- 只上报实际提供的 input、output、cached 字段，不把 thinking 额外叠加，也不虚构费用。
- doctor 用 CLI 自身处理的 `/model` 核对启动和模型配置，不调用模型；这项检查不能单独证明后端实时可用，切换前还应做隔离问答验收。

## 验证

```sh
node --disable-warning=ExperimentalWarning --test tests/agy.test.ts
npm run typecheck
npm run format:check
npm run test:quick
```

[专项测试](../tests/agy.test.ts) 检查参数传递、原会话续接、成功与失败语义、用量去重、独立安装加载和无推理的 doctor 检查。普通测试使用假输出或假程序，不消耗模型额度；真实验收应使用隔离数据目录，关闭真实通知通道。

官方行为依据为 Antigravity CLI 的 Headless mode 和 Permissions 文档；版本或输出格式变更后重新核对真实事件，不凭显示名猜测会话或用量语义。
