# Telegram 本人私聊通道

[Telegram 插件](../plugins/telegram/channel.ts) 沿用 [通道接口](../host/channels.ts)，通过 Bot API 长轮询接收回答。无需公网 Webhook，不修改内核，不依赖第三方运行时包。

## 功能

- 把问题发成纯文字和按钮；选择后更新同一条消息，显示中台的处理结果。
- 接受对机器人原卡片的文字回复。普通聊天消息和 `/start` 不自动创建任务。
- 同时校验本人用户 ID、私聊 Chat ID、原消息及卡片对应关系，中台再校验通道身份和回答权限。
- 保存消息映射与更新游标；重启后继续编辑原消息，中台暂时不可达时保留回答等待重试。

只让一个接收程序使用同一 Bot；不能与现役 Webhook 或另一个 getUpdates 消费者共享。

## 首次配置

先将插件复制到安装数据目录的 `plugins/telegram/channel.ts`。默认数据目录为 `~/.agent-autoloop`，也可由 `AGENT_AUTOLOOP_HOME` 指定。

在数据目录的 `secrets/telegram.env` 填写：

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
TELEGRAM_CHAT_ID=
```

值分别是专用 Bot Token、已核实的本人数字用户 ID 和对应私聊数字 Chat ID；本插件要求后二者相同。目录权限设为 0700、文件为 0600。通过本人向 Bot 发 `/start` 并核对实际 sender 获取目标，不根据显示名推断身份。

插件直接读取这个文件，不调用全局环境加载，也不需要给 systemd 设置 Token 环境变量。`config.json` 的 `channels.telegram` 可以只写插件名和中台通道密钥：

```json
{
  "channels": {
    "telegram": {
      "use": "telegram",
      "key": "填写中台为 telegram 创建的 channel 密钥"
    }
  }
}
```

将对应项合入现有配置，不替换其他通道。首次配置时使用 `agent-autoloop key new channel telegram` 创建中台密钥；已经存在的通道复用原密钥，避免无意替换身份。

`rules.json` 的对应通道写本人白名单，`answerers` 中填写相同的数字 ID 字符串：

```json
{
  "channels": {
    "telegram": {
      "name": "Telegram",
      "answerers": ["填写已核实的本人数字用户ID"]
    }
  }
}
```

如需自定义文件位置，可在 `config.json` 的通道项设置 `envFile` 和 `stateFile`，使用绝对路径。默认状态文件为数据目录的 `channels/telegram/state.sqlite`。不要把这些私有文件提交到 Git。

先运行 `agent-autoloop check`，再重启本实例。启用后通道会开始领取并投递卡片，应在确认收件目标和实际发送范围后操作。协议中的发送、送达报告和回答约定见 [通道协议](protocol.md#通道把卡片送到你面前)。

## 验证与边界

[专项测试](../tests/telegram.test.ts) 使用本地假 HTTP 服务，覆盖发送/编辑、本人及原消息校验、重启恢复、重复更新、报告丢失、游标顺序、文字回复、429 等待、409 冲突和 Token 日志脱敏。测试不会发送真实消息。

```sh
node --disable-warning=ExperimentalWarning --test tests/telegram.test.ts
npm run typecheck
npm run format:check
npm run test:quick
```

消息 ID 保存后，若中台送达确认丢失，重试会编辑原消息。若 Telegram 已发送消息但响应丢失，或进程在保存消息 ID 前退出，重试仍可能重复发送；不承诺平台级严格去重。

总文本超过 4096 字符时报告失败，不截掉选项或结果。原消息被删除或无法编辑时报告失败。429 按 retry_after 等待；409 接收冲突时本通道停止工作，解决其他消费者占用后再重启。已存在 Webhook 时拒绝启动，不擅自删除 Webhook。

Token 或 env 设置变化后重启服务。更换 Bot 或私聊目标时核对身份并指定新的状态文件；不要为绕过错误删除原映射记录。

## 备份

在项目原生备份之外，同时保留插件、私有 env 和 Telegram 状态数据库。运行中的 SQLite 应使用一致性备份方式；仅复制单个活动数据库文件可能漏掉 WAL 中的更新。

原生 restore 不会恢复这些额外文件，需要配套还原并再次验证。消息状态与中台送达记录要保持对应，不把单独恢复中台数据库称作通道已经恢复。
