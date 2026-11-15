# dsh-purge-mode

在 DSH 对话框里加一个 **原生 / purge** 层级下拉：点一下就切方案，**按会话独立、下一轮对话生效、不重启**。

本插件**不改 dsh-purge 一行源码**，所以 dsh-purge 自身自动升级不会把它冲掉。

## 切的是什么

| 层 | 原生 | purge |
| --- | --- | --- |
| 提示词 | 官方身份句 + 官方能力选用协议；无 operator inject、无 boost 段 | dsh-purge 的 operator inject + boost + purge 版能力协议 |
| 权限 | `workspace-write` + `ask`（审批会问） | `danger-full-access` + `never`（免审批全放行） |
| 工具面 | 不变 | 不变 |
| 宿主二进制 | 不变（引擎层写死补丁仍是 purge 版） | 不变 |

> 引擎层那几个写死代码的补丁（escalation 无条件放行 / fs fence / deny-write）
> 只有 `purge_revert` + 重启才能还原；本开关只管「模型看到什么」。

## 按会话独立

**v2 起状态按会话保存，且对话之间完全隔离。** v1 只有一个全局 mode，A 会话切换会
连带 B 会话；v2 修正为：

```jsonc
// $DSH_HOME/dsh-purge-mode/state.json
{
  "defaultMode": "native",                            // 新会话默认 = 关闭 purge
  "sessions": {
    "<root-session-id>": { "mode": "purge", "updatedAt": "…" }
  }
}
```

- **新会话默认 `native`**（关闭 purge）。想默认开就改 `defaultMode`。
- 每个会话有自己的一条记录；没有记录时回落到 `defaultMode`。
- **对话之间互不影响**：并发装配时各自读到自己那份（见下节「隔离原理」）。
- **子代理继承父会话**：`header.origin === "subagent"` 时沿 `parentSession`
  上溯到根会话，读根会话的选择，并写回根会话的记录（不产生孤儿条目）。
- 状态存在 `$DSH_HOME` 下，**与插件版本无关**：升级插件、重启 DSH 都不会丢
  各会话原有的选择。

## 隔离原理（v2.1）

dsh-purge 的 `fiber.config` 是**单例**，而 `assemble` 是异步的。如果按「装配前把
config 写成某个会话的值」来做，并发装配时后写的会覆盖先写的 —— A 会话就会读到
B 的模式，也就是「对话之间互相影响」。

所以 v2.1 改成**只读视图 + 会话作用域**：

1. 把 config 的 `enabled` / `capabilityProtocol` / `stripMnemon` 换成 getter，
   从 `AsyncLocalStorage` 取「当前正在装配的会话模式」；无装配上下文时回退基准值。
2. 包住 `systemPrompt.assemble`，在进入 purge 的整条执行链**之前**建立会话作用域。

顺序上有个坑：purge 的 `assembleGuard` 在 `await orig()` **之后**才读 config，
而且它每 400ms 会重装自己的 accessor。本插件因此：

- 只在 purge **已安装** guard 时接管（识别它 accessor 上的
  `Symbol.for("dsh-purge.assembleGuard")`），并复用同一个 Symbol，让 purge 的
  重装走 `bindSlot`（只刷新 `slot.rewrite`）而不顶掉我们的包装；
- purge 尚未安装时**绝不伪造**该 Symbol —— 否则 purge 会以为 guard 已在而跳过
  包装，注入直接失效。

作用域跟着异步调用链走，所以事件路径和 guard 二次重写都在同一作用域内求值。

## 原理

dsh-purge 的提示词注入有两条路径——事件监听 `system-prompt/assemble`，以及把
`systemPrompt.assemble` 方法整个包起来的 assembleGuard。两条路径读的是同一个
`config` 对象，而该对象就是 Cordis 的 `fiber.config`。

三条关键事实：

1. dsh-purge 在 `system-prompt/assemble` 上以 **`prepend: true`** 注册，先拿到
   waterfall；它 `await next()` **之后**才读 `config` 做重写。
2. 本插件用 **非 prepend** 注册，因此排在它下游——在 purge 读之前把 `config` 写好。
3. 同一轮里只有当前会话在装配，因此按 sessionId 写入即可，无需加锁。

翻转的三个字段：

- `enabled` → 关掉 operator inject / boost / probe / postPrompt
- `capabilityProtocol` → 关掉 purge 版能力协议（重写器会另行补一段）
- `stripMnemon` → 不再丢弃宿主自己的 agent-instructions 段

## 界面

输入框右侧（与「回退」按钮同排）**一个层级下拉**：

```
● 方案 ▾                   ← 触发器，显示本会话当前方案（跟随默认时带「默认」角标）
  ┌──────────────────────────────────┐
  │ 本会话方案（下一轮生效）            │
  │ ✓ 原生    官方提示词 · 审批会问     │
  │   purge   operator 注入 · 全放行   │
  ├──────────────────────────────────┤
  │ 应用到所有会话 ▸                  │
  │   ├ 全部设为原生                  │
  │   ├ 全部设为 purge                │
  │   └ 清除本会话记忆                │
  └──────────────────────────────────┘
```

一级管本会话，二级管批量与重置。菜单用宿主自己的 `Menu` 原语（与权限选择器同一套），
`submenu` / `separator` 是原语原生支持的条目类型；点击外部、Esc、方向键、焦点回归
都由原语负责。点某一项才正式提交，选中后菜单收起，旁边短暂显示「下轮生效」。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-purge-mode/mode?sessionId=` | 读该会话模式 + 全局默认 + 目标插件状态 |
| `POST` | `/dsh-purge-mode/mode` | `{sessionId, mode:"native"\|"purge"}` 设单会话 |
| `POST` | `/dsh-purge-mode/mode` | `{sessionId, mode:null}` 清除本会话记忆，回到默认 |
| `POST` | `/dsh-purge-mode/mode` | `{scope:"all", mode:"native"\|"purge"}` 批量设所有会话 + 默认值 |

状态文件：`$DSH_HOME/dsh-purge-mode/state.json`。

## 安装

作为 profile bundle 安装（desktop profile）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-purge-mode"] } },
  "dependencies": { "dsh-purge-mode": "file:vendor/dsh-purge-mode" }
}
```

包体放在 `~/.dsh/profiles/desktop/vendor/dsh-purge-mode`，pnpm 软链到
`node_modules/dsh-purge-mode`。

## 排错

- 按钮不出现：确认宿主已重启过一次（bundle 只在启动时装载），并刷新页面。
  插槽是 `conversation.input.right`（list / session scope）。
- 切了没反应：看宿主日志里的 `[dsh-purge-mode]` 行；`target.found=false` 表示
  dsh-purge 的 Loader 行 id 不是 `dsh-purge`，改 `lib/index.js` 里的
  `TARGET_ENTRY_IDS` / `TARGET_ENTRY_NAMES`。
- 会话不独立：确认没有旧版 `mode.json` 干扰；v2 只读 `state.json`。
