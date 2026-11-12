# 接入与恢复

准备脚本需要 Node.js 24+、可运行的 Unfold CLI，以及对所有者 API 的现有认证。它与 Web 共用同一服务、数据库和权限检查。脚本按参数数组调用 CLI，不通过 shell 执行命令字符串。

Unfold 源码和安装说明见 [GhostFlying/unfold](https://github.com/GhostFlying/unfold)。在当前机器安装并构建 CLI 后，可将 `UNFOLD_CLI` 设置为 checkout 中 `bin/unfold.mjs` 的绝对路径，或将 `unfold` 放到 PATH。服务配置、登录凭据和已部署的入口继续保存在原位置。脚本也支持 `--cli /absolute/path/to/bin/unfold.mjs`。

远端所有者 API 使用：

```sh
node /ABSOLUTE/SKILL/DIRECTORY/scripts/prepare.mts MR_URL \
  --head FULL_SUBMITTED_COMMIT \
  --cli /absolute/path/to/unfold/bin/unfold.mjs \
  --server OWNER_API_URL --token-file /private/path/to/owner-key
```

所有者可以通过 Tailscale 连接管理入口。转发地址必须来自独立配置的公司只读入口。脚本会在不附带所有者认证的情况下检查 viewer 健康和指定版本的公开讲解。

默认先刷新远端、核对 head，再复用同一不可变版本且包含改动导览的讲解。指定 backend/model/effort 时，复用结果也必须匹配。存在相同版本和所选参数的未完成分析时，继续观察已有运行；`--resume RUN` 可明确恢复一个运行。`--regenerate` 请求重新生成。生成完成后再次刷新远端；head 或 base 变化将返回冲突。返回的 `url` 固定到历史讲解；同一 MR 的默认页面可以继续展示后续版本。

退出码沿用 Unfold：0 为准备完成，1 为操作失败，2 为参数或分享配置错误，3 为等待精确执行审批，4 为版本/运行冲突，5 为结果未知，6 为认证缺失。stderr 输出结构化进度或错误；stdout 成功时只有一个 JSON 结果。失败时保留运行 ID；如果连接中断，应先用 `unfold --json runs REVIEW` / `run RUN` 核对已接受的运行，再用 `--resume` 继续。审批决定后也通过原运行继续，避免另起一次分析。

等待审批时，用 `unfold --json approval list` 找到 `runId` 相同的请求，向用户展示具体命令、目录、源码版本、目的、网络需求和副作用。获得该请求的明确授权后，用 `unfold --json approval approve APPROVAL_ID --confirm EXACT_DIGEST` 提交决定，再以 `--resume RUN` 继续；拒绝请求使用 `approval deny`。已有的这一次授权继续有效。不要自行批准项目执行来完成讲解准备。

配置缺失时只请求不可自行获取的信息；不要创建新服务、修改他人的配置、降低执行限制或输出密钥。GitHub PR 提供者未启用时，记录该限制并完成其余已授权交付。
