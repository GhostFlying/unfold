# 提交后的 Agent 工作流

`unfold-review` 在代码修改已提交或更新到 MR 后，准备对应版本的交互式讲解、改动导览和只读链接。可作为独立 skill 安装，也可通过 Unfold Codex plugin 安装；两种方式使用相同的 skill 和脚本。

当前服务支持 Codebase MR。GitHub PR 提供者留在第二阶段，插件不会将未支持的请求报告为成功。插件本身托管在 GitHub 与提供者支持是两件事。

## 安装 Codex plugin

插件源码位于 [`plugins/unfold`](../plugins/unfold)，包含 Agent Plugins 1.0 根清单、Codex 兼容清单及一个 skill。仓库的 `.agents/plugins/marketplace.json` 提供 `unfold-tools` marketplace。

```sh
codex plugin marketplace add GhostFlying/unfold
codex plugin add unfold@unfold-tools
```

本地开发时也可以注册当前 checkout：

```sh
codex plugin marketplace add /absolute/path/to/unfold
codex plugin add unfold@unfold-tools
```

安装后在新的 Codex 会话中使用。插件的 skill 显示为 `unfold:unfold-review`；可以直接要求“提交 MR 后用 Unfold 准备只读讲解”。本地插件清单和 marketplace 的格式遵循 [OpenAI 的插件打包文档](https://developers.openai.com/plugins/build/plugins)。CLI 不会仅因当前目录存在 marketplace 文件就自动安装插件；上面的注册和安装步骤会明确完成配置。

## 安装独立 skill

让 Agent 使用 skill-installer 安装 `GhostFlying/unfold` 的 `plugins/unfold/skills/unfold-review` 路径，或将整个目录复制到所用 Agent 的 skills 目录。Codex 的示例：

```sh
mkdir -p ~/.agents/skills
cp -R /absolute/path/to/unfold/plugins/unfold/skills/unfold-review ~/.agents/skills/
```

安装后在新会话中使用 `$unfold-review`。skill 自带脚本、接入说明和 MIT 声明，复制该目录即可保留完整内容。

## 配置 CLI 访问

运行脚本的机器需要 Node.js 24+ 和已经构建的 Unfold CLI。可将 `unfold` 放到 PATH，或设置 `UNFOLD_CLI` 为 `bin/unfold.mjs` 的绝对路径。执行 `pnpm install --frozen-lockfile && pnpm build` 可以构建本仓库中的 CLI。

在调用 Agent 的机器上配置一次已有部署：

```sh
node /absolute/path/to/unfold-review/scripts/prepare.mts configure \
  --server OWNER_API_URL --token-file /private/path/to/owner-key \
  --cli /absolute/path/to/unfold/bin/unfold.mjs

node /absolute/path/to/unfold-review/scripts/prepare.mts check
```

`configure` 验证原有所有者认证后，才原子保存 `~/.config/unfold/client.json`（或 `$XDG_CONFIG_HOME/unfold/client.json`），权限为 0600。它保存服务地址、CLI 路径和 token 文件引用，token 内容留在原有受保护文件。插件和独立 skill 共用这个文件，切换代码仓库和升级插件后仍然有效。新机器首次接入需要已有管理地址和该机器上的凭据文件。

脚本优先使用显式参数，其次是 `UNFOLD_SERVER` / `UNFOLD_TOKEN_FILE` / `UNFOLD_CLI` 环境变量，再读取私有绑定，最后兼容原有 Unfold home。`--client-config` 或 `UNFOLD_CLIENT_CONFIG` 可指定另一份私有绑定，例如忽略的 `.local/client.json`。配置缺失会返回明确的接入错误。脚本将解析后的地址和 token 文件作为全局参数传给 CLI；直接调用原生 CLI 时，也要使用同一组参数或它自己的 `UNFOLD_HOME` 配置。

这些接入值属于用户环境，保存在原有配置或忽略的 `.local/` 下。公开 skill、插件清单和归档均不包含实际公司入口、Tailscale 地址、token、群标识或登录文件。

## 自动用于提交后的交接

skill 默认允许自动选择。希望项目每次提交后都准备讲解时，将下面的约定加入实际开发项目的 Agent 指令文件；如果该文件由其他系统生成，按该项目的生成流程维护：

> 完成代码修改并成功提交或更新 PR/MR 后，使用 Unfold 的 unfold-review skill，为本次实际提交的完整 head 准备交互式讲解和改动导览。复用已有的同版本讲解，交付固定到该版本的只读 URL。当前任务已授权向指定 review 群发送通知时，使用环境中的公司工具转发准备结果并记录发送回执；缺少目标或必要授权时再询问该缺失项。讲解准备失败时保留真实状态和可恢复运行 ID。

这段项目约定和 skill 的自动选择共同衔接提交流程。插件不安装 PR 事件监听器或生命周期 hook，也不修改其他项目的指令文件。

准备脚本可以直接用于任何 Agent 的 CLI 流程：

```sh
node /absolute/path/to/unfold-review/scripts/prepare.mts \
  'https://code.company.example/team/repo/merge_requests/42' \
  --head FULL_SUBMITTED_COMMIT
```

保存接入后，后续调用只需 MR URL 和提交。可选参数为 `--backend codex|traex`、`--model MODEL`、`--effort EFFORT`、`--regenerate` 和 `--resume RUN`。脚本先刷新远端并核对 head，复用同版本完整讲解或观察/启动分析，最后再次核对 head 与 base。生成失败、待审批、结果未知或远端变化时保留结构化错误，不返回旧讲解作为本次成功结果。等待使用现有 CLI 的 SSE，不靠 Agent 循环查询。

成功时 stdout 返回一个 JSON 对象，主要字段如下：

```json
{
  "ok": true,
  "data": {
    "status": "ready",
    "reviewId": "durable-review-id",
    "explanationId": "immutable-explanation-id",
    "versionId": "immutable-version-id",
    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "base": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "url": "https://review.company.example/r/durable-review-id/v/immutable-explanation-id",
    "reused": true,
    "message": "改动讲解已准备好：示例修改\nMR/PR：原平台链接\n对应提交：完整 head\n只读讲解：固定版本 URL"
  }
}
```

`url` 固定到本次讲解，`message` 可交给后续 review 群通知流程。脚本不带所有者凭据读取 viewer 健康和指定版本的公开讲解，确认实际入口是只读监听器。该检查证明执行脚本的机器能访问，群成员各自的网络连通性仍取决于公司网络。

stderr 输出运行 ID 和结构化错误。退出码 3 表示精确执行审批待处理；决定后以相同 URL/head 和 `--resume RUN` 继续。连接中断时先检查已有运行，避免重复分析。完整参数和恢复方式见 [skill 接入参考](../plugins/unfold/skills/unfold-review/references/setup.md)。

## 交给公司通知流程

Unfold 提供只读讲解和可转发说明。实际群聊工具、群标识、已有授权和发送回执由调用 Agent 在当前环境处理。插件不捆绑公司消息接口，不自动选择群，也不调用发送、发表评论或合入接口。该流程不要求讲解生成端拥有群消息权限。

## 导出包

在仓库根目录执行以下命令，可得到包含许可证的插件包和独立 skill 包。输出保存在忽略的 `.local/`，归档范围仅包含对应源码目录：

```sh
mkdir -p .local/packages
tar -czf .local/packages/unfold-plugin.tar.gz -C plugins unfold
tar -czf .local/packages/unfold-review-skill.tar.gz -C plugins/unfold/skills unfold-review
```

这是本地/仓库分发包。发布到公开插件目录或保存到账号使用相应平台的发布流程。
