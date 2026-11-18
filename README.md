# dsh-agent-pack

一个 DSH **Agent 预设包**：把多个 agent 声明集中在一个 bundle 里，复用 DSH 内置的 Agent 预设选择器切换，不额外造下拉框。

## 怎么新增一个 agent

1. 打开 `cordis.patch.yml`，复制 `preset-agent-pack-template` 这整段 `insert` 条目。
2. 修改三个字段：
   - 外层 `id`：Loader 行 ID，必须唯一，例如 `preset-agent-writer`
   - `config.id`：预设稳定 ID，会写进会话记录，例如 `agent-writer`
   - `config.name`：选择器里显示的名字，例如 `写作 Agent`
   - `config.order`：排序，数字越小越靠前
3. `config.plugins` 就是这个 agent 的工具与提示词组合；按需增删。
4. 重新安装/加载 bundle 后，新预设自动出现在内置选择器中。

## 约定

- `config.id` 一旦被会话使用就不要改，否则旧会话恢复时会找不到定义。
- 预设是**按会话**生效：新会话或空白会话可选，已运行会话保持原有组合。
- 预设不是安全沙箱；`plugins` 里的代码以 Host 权限运行，只加入可信插件。

## 目录

- `cordis.patch.yml`：预设声明（当前含一个模板预设 `agent-pack-template`）
- `packages/dsh-purge-mode/`：原 `dsh-purge-mode` 插件源码，保留用于历史安装与回退
