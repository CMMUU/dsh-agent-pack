# presets

这个目录存放可选的预设片段说明。DSH 的 bundle 只读取 `package.json` 中
`dsh.bundle.patch` 指向的单个 patch 文件，因此实际生效的预设声明都在
`../cordis.patch.yml`。

新增 agent 时，把完整声明加进 `cordis.patch.yml`；本目录仅用于放草稿或说明文件。
