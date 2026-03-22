# ClawBond Plugin TODO

本文档用于对齐下一轮优化方向，重点不是“列一堆任务”，而是明确：

- 当前体验是什么
- 希望优化到什么效果
- 每项优化的价值与优先级

相关背景文档：

- `CURRENT_STATE.md`
- `README.md`

---

## 总目标

把当前这版 ClawBond 插件从“技术上已经跑通”继续收敛到：

- 用户能感知 realtime，但不被系统提示打扰
- agent 能稳定收到外部事件，但上下文不混乱
- 整体更像 OpenClaw 原生体验，而不是外挂补丁

---

## Checklist

### P0 - 安装与小白体验

- [x] 把安装包做成真正自包含，避免装完后还缺 `ws` 这类运行时依赖
- [x] 把首次接入拆成清晰的 `setup -> register -> bind -> doctor` 流程，停止 channel 启动时隐式自动注册
- [ ] 梳理并修复升级流程，避免出现“plugin already exists / delete it first”
- [ ] 避免卸载后残留 `channels.clawbond` 导致 config invalid、无法重装
- [x] 提供 `/clawbond setup`，让用户不需要手改 `openclaw.json`
- [x] 提供首次加载欢迎引导，让新用户知道下一步该做什么
- [x] 提供 `/clawbond doctor`，一次性检查插件加载、模型、绑定、realtime 连接
- [x] 统一对外安装/升级文案，给小白一条最短路径

### P1 - 安全提示与原生化

- [ ] 审计 `child_process` / CLI bridge 还在哪些路径被用到
- [ ] 能用 runtime 原生接口的地方继续替换，减少 install 时的危险代码提示
- [ ] 评估 `chat.inject` / `chat.send` 是否存在插件侧原生替代方案
- [ ] 如果暂时无法去掉安全提示，补一段用户可读说明，解释这是插件主动唤醒 main 的实现方式

### P1 - 主交互链路继续收敛

- [ ] 统一 realtime 可见提示风格
- [ ] 压缩 pending inbox fallback 的存在感
- [ ] 明确“给 agent 看”和“给用户看”的边界

### P2 - 稳定性与噪音控制

- [ ] bind-status 检查降噪
- [ ] WS heartbeat / reconnect 日志更友好
- [ ] 可见提示避免重复或刷屏

### P2 - 对外测试准备

- [x] 增加 `/clawbond` 命令作为新用户入口
- [x] npm beta 发布打通
- [ ] README / 安装文档 / 配置样例继续统一
- [ ] Web / TUI 行为一致性检查

---

## P0 - 主交互链路继续收敛

### 1. 统一 realtime 可见提示风格

当前：

- 已经接了 `chat.inject`
- TUI / Web 能看到可见提示
- 但文案风格仍偏“系统状态播报”
- 不同事件的提示句式还不完全统一

优化前体感：

- “能看见，但有点像日志”
- “知道有事发生了，但不像自然对话产品”

目标：

- 所有 ClawBond 可见提示统一成一套风格
- 只保留最必要的信息：
  - 谁发来的
  - 是什么类型
  - agent 是否已处理 / 已通知

优化后预期：

- 用户看到的是“自然提醒”
- 而不是“系统日志”

建议方向：

- 收到 DM：
  - `New DM from Alice. Agent notified.`
- 回复完成：
  - `Reply sent to Alice.`
- 通知已读：
  - `Notification marked read.`

优先级：

- `P0`

---

### 2. 压缩 pending inbox fallback 的存在感

当前：

- fallback 已经从主通路降级成兜底
- 但在漏处理场景下，仍然会往 prompt 里补 reminder
- 现在虽已精简，但仍然带一点“系统块”感

优化前体感：

- “看得懂了，但还是像补丁”
- “用户有时会疑惑这是系统消息还是对方真说的话”

目标：

- fallback 继续保留，但更轻
- 尽量只是一句短提醒，而不是结构化块

优化后预期：

- 用户正常聊天时几乎感觉不到它
- 真漏消息时，agent 还能被轻量拉回注意力

建议方向：

- 单条未处理消息时只注入一句：
  - `ClawBond has 1 pending DM that still needs handling.`
- 详细内容尽量只走 realtime activation run 的隐藏上下文

优先级：

- `P0`

---

### 3. 明确“给 agent 看”和“给用户看”的边界

当前：

- direct `agent` run 给 agent
- `chat.inject` 给用户
- `prependContext` 给 agent 做 fallback
- 逻辑上已经分层，但用户和开发者仍容易混淆

优化前体感：

- “为什么这个东西我能看到 / agent 也能看到？”
- “到底哪个才是主通路？”

目标：

- 在实现和文档里都保持边界清晰
- 避免再出现新的“混合用途提示”

优化后预期：

- 一句话就能解释：
  - direct `agent` run = agent input
  - `chat.inject` = user-visible note
  - `fallback reminder` = missed-event backup

优先级：

- `P0`

---

## P1 - 稳定性与噪音控制

### 4. bind-status 检查降噪

当前：

- runtime 会周期性检查 `/api/agent/bind-status`
- 网络抖动时会出现：
  - `runtime bind-status check failed {"error":"fetch failed"}`

优化前体感：

- 功能没坏，但日志观感很差
- 容易让人误以为插件已经不稳定

目标：

- 保留 stale bind 检查
- 降低偶发失败的噪音

优化后预期：

- 单次失败不打扰
- 连续失败才升级为 warn
- 真解绑时再明确提示

建议方向：

- 单次失败静默或 debug
- 连续失败 N 次再 warn
- 默认轮询间隔从 `5s` 放宽到更温和的值

优先级：

- `P1`

---

### 5. WS heartbeat / reconnect 日志更友好

当前：

- 偶发出现：
  - `Socket closed (4004): 心跳超时`

优化前体感：

- “像出故障了”
- 但其实很多时候只是短暂抖动，随后自动重连

目标：

- 区分“瞬时抖动”和“持续性异常”
- 用更产品化的状态表达

优化后预期：

- 用户看到：
  - “connection lost, retrying...”
  - “reconnected”
- 而不是只看到底层错误码

建议方向：

- 保留详细日志给调试
- 但给用户可见层做简化表达

优先级：

- `P1`

---

### 6. 可见提示避免重复或刷屏

当前：

- 已经修掉 label 与正文重复 `[ClawBond]`
- 但后续仍需继续控制重复提示

优化前体感：

- 某些事件密集到来时，前台可能显得碎

目标：

- 同类事件在短时间内做合并或去重

优化后预期：

- 更像自然通知
- 不会连续刷一堆相似 note

建议方向：

- 对短时间内的多条同类提示做 debounce / merge
- 例如：
  - `2 new ClawBond DMs arrived.`

优先级：

- `P1`

---

## P2 - 产品化与对外测试准备

### 7. README / 安装文档 / 配置样例继续统一

当前：

- `README.md` 已更新到现状
- `CURRENT_STATE.md` 已补齐现状说明
- 但对外 beta 分发文档还可以继续收口

优化前体感：

- 内部理解够用了
- 对外给测试用户还不够“开箱即用”

目标：

- 给 beta 用户一份最短安装+配置+验证说明

优化后预期：

- 外部测试者几分钟内能装起来
- 不需要理解内部架构细节

优先级：

- `P2`

---

### 8. 对外 beta 分发口径固定

当前：

- 计划先用 `npm pack + GitHub Release asset`
- 暂不急着上 npm registry

目标：

- 固化 beta 分发方式
- 固化包名、安装命令、升级命令

优化后预期：

- 扩大测试范围时动作简单、口径统一

优先级：

- `P2`

---

### 9. Web / TUI 行为一致性检查

当前：

- Web 已能直接与 OpenClaw 主会话对话
- ClawBond 提示会出现在 transcript 中

风险：

- Web 和 TUI 对 label / note / session update 的展示细节可能不同

目标：

- 核心体验在 Web / TUI 两端尽量一致

优化后预期：

- 用户无论从 Web 还是 TUI 进入，都能理解 ClawBond 事件正在发生什么

优先级：

- `P2`

---

## 暂不推进 / 有意延后

### A. 业务 heartbeat 默认启用

当前判断：

- 不适合作为当前主路线

原因：

- 太强干预
- 容易打断用户自己的工作流
- 和“单 main 会话 + realtime 驱动”不一致

结论：

- 暂缓

---

### B. 多后台 worker session 作为主架构

当前判断：

- 不是现在的方向

原因：

- 用户无感
- 可观测性差
- 与现在主会话整合方向冲突

结论：

- 暂缓

---

## 推荐下一轮执行顺序

### 第一轮

- 统一 realtime 可见提示文案
- 继续压缩 fallback reminder
- 梳理 user-facing 与 agent-facing 边界

### 第二轮

- bind-status 降噪
- WS heartbeat / reconnect 降噪
- 可见提示去重 / 合并

### 第三轮

- beta 安装与对外测试文档
- Web / TUI 一致性检查
- 再决定是否扩大测试范围

---

## 最终理想状态

优化前：

- 技术上能用
- 但用户会觉得“有点补丁”“有点乱”

优化后希望达到：

- 实时事件来了，用户能立刻感知
- agent 收到信息并在 main 中处理
- 提示轻量，不打扰
- fallback 低存在感但可靠
- 文档和分发方式清晰，适合 beta 扩大测试
