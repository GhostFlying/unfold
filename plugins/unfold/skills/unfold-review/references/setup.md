# 接入与恢复

准备脚本需要 Node.js 24+、可运行的 Unfold CLI，以及对所有者 API 的现有认证。它与 Web 共用同一服务、数据库和权限检查。脚本按参数数组调用 CLI，不通过 shell 执行命令字符串。

Unfold 源码和安装说明见 [GhostFlying/unfold](https://github.com/GhostFlying/unfold)。在当前机器安装并构建 CLI 后，可将 `UNFOLD_CLI` 设置为 checkout 中 `bin/unfold.mjs` 的绝对路径，或将 `unfold` 放到 PATH。服务配置、登录凭据和已部署的入口继续保存在原位置。脚本也支持 `--cli /absolute/path/to/bin/unfold.mjs`。

首次在调用 Agent 的机器上保存服务接入：

```sh
node /ABSOLUTE/SKILL/DIRECTORY/scripts/prepare.mts configure \
  --cli /absolute/path/to/unfold/bin/unfold.mjs \
  --server OWNER_API_URL --token-file /private/path/to/owner-key

node /ABSOLUTE/SKILL/DIRECTORY/scripts/prepare.mts check

node /ABSOLUTE/SKILL/DIRECTORY/scripts/prepare.mts MR_URL \
  --head FULL_SUBMITTED_COMMIT
```

`configure` 先通过原有认证读取所有者 API，成功后才保存到 `~/.config/unfold/client.json`（文件权限 0600）。支持 `XDG_CONFIG_HOME`。文件只存 API 地址、CLI 绝对路径和 token 文件的绝对路径，token 内容继续留在原受保护文件中。插件和独立 skill 读取同一份绑定；代码仓库切换与插件升级不影响它。每台调用机器需要接入一次；网络访问仍需该机器能到达管理入口。

优先级为显式 `--server` / `--token-file` / `--cli`、环境变量 `UNFOLD_SERVER` / `UNFOLD_TOKEN_FILE` / `UNFOLD_CLI`、已保存绑定、已有 Unfold home 配置。`--client-config /absolute/private/client.json` 或 `UNFOLD_CLIENT_CONFIG` 可以指定另一份私有文件，例如忽略的 `.local/client.json`。缺少接入时返回 `client_not_configured`，不会猜测当前机器就是部署主机。

`check` 返回认证状态和接入引用，不输出 token 内容。直接使用原生 Unfold CLI 查询或审批时，继续传入这些 `--server` / `--token-file` 参数；该绑定由 skill 脚本读取。CLI 的原有 `UNFOLD_HOME` 配置仍可使用。

所有者可以通过 Tailscale 连接管理入口。转发地址必须来自独立配置的公司只读入口。脚本会在不附带所有者认证的情况下检查 viewer 健康和指定版本的公开讲解。

默认先刷新远端、核对 head，再复用同一不可变版本且包含改动导览的讲解。指定 backend/model/effort 时，复用结果也必须匹配。存在相同版本和所选参数的未完成分析时，继续观察已有运行；`--resume RUN` 可明确恢复一个运行。`--regenerate` 请求重新生成。生成完成后再次刷新远端；head 或 base 变化将返回冲突。返回的 `url` 固定到历史讲解；同一 MR 的默认页面可以继续展示后续版本。

退出码沿用 Unfold：0 为准备完成，1 为操作失败，2 为参数或分享配置错误，3 为等待精确执行审批，4 为版本/运行冲突，5 为结果未知，6 为认证缺失。stderr 输出结构化进度或错误；stdout 成功时只有一个 JSON 结果。失败时保留运行 ID；如果连接中断，应先用 `unfold --json runs REVIEW` / `run RUN` 核对已接受的运行，再用 `--resume` 继续。审批决定后也通过原运行继续，避免另起一次分析。

等待审批时，用 `unfold --json approval list` 找到 `runId` 相同的请求，向用户展示具体命令、目录、源码版本、目的、网络需求和副作用。获得该请求的明确授权后，用 `unfold --json approval approve APPROVAL_ID --confirm EXACT_DIGEST` 提交决定，再以 `--resume RUN` 继续；拒绝请求使用 `approval deny`。已有的这一次授权继续有效。不要自行批准项目执行来完成讲解准备。

配置缺失时只请求不可自行获取的信息；不要创建新服务、修改他人的配置、降低执行限制或输出密钥。GitHub PR 由部署主机的 `gh` 接入，可用 `unfold --json doctor` 核对账户与认证状态。认证缺失时在部署主机运行 `gh auth login --hostname github.com`；不要在调用机器复制 token。旧服务尚未提供该适配器或 PR 超过 300 个改动文件时，保留错误和已有代码交付，不把旧讲解当作成功。
