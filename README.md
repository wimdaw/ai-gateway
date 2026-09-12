# AI Gateway

AI 渠道 API 代理网关 — 统一 `/v1` 接口转发，支持多上游渠道、后台管理、用量统计、备份恢复。

基于 [Cloudflare Workers](https://workers.cloudflare.com/) + [Hono](https://hono.dev/) + [D1](https://developers.cloudflare.com/d1/) 构建。

## 功能特性

- **多渠道转发** — OpenAI 兼容 / Anthropic 兼容 / Azure TTS / Agnes 视频 / Antigravity 反代，统一 `/v1` 入口
- **免费模型默认启用** — OpenCode、Kilo 免费模型开箱即用，无需配置 API Key
- **后台管理** — 渠道管理、令牌管理、用量统计、模型排行
- **D1 存储** — 配置/会话/用量全部存储在 Cloudflare D1，KV 作可选回退
- **备份恢复** — R2 云端备份、Telegram 备份、导出/导入
- **故障转移** — 官方地址失败自动切换镜像地址，Key 健康检测自动降权
- **模型别名** — 对外隐藏 `:free/-free` 后缀，支持自定义显示名
- **令牌管理** — 批量添加、批量测试、到期时间控制
- **渠道 ID 可编辑** — 后台可直接修改渠道唯一标识

## 快速开始

### 前置条件

1. Cloudflare 账号（免费版即可）
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 已安装

```bash
npm install -g wrangler
```

### 创建 D1 数据库

```bash
wrangler d1 create ai-gateway-db
```

记下输出的 `database_id`，复制到 `wrangler.toml` 中替换。

### 配置 wrangler.toml

将 `wrangler.toml.example` 复制为 `wrangler.toml` 并填入你的 D1 ID：

```toml
name = "ai-gateway"
main = "src/index.ts"
compatibility_date = "2025-07-01"
compatibility_flags = ["nodejs_compat"]
keep_vars = true

[[d1_databases]]
binding = "DB"
database_name = "ai-gateway-db"
database_id = "你的 D1 数据库 ID"
```

如需 R2 备份功能，额外添加：

```toml
[[r2_buckets]]
bucket_name = "ai-gateway-backup"
binding = "ai_gateway_backup"
```

### 本地开发

```bash
npm install
npm run dev    # wrangler dev
```

### 部署

```bash
npm run build  # 编译
npx wrangler deploy  # 部署到 Cloudflare Workers
```

部署后访问 `https://你的域名` 即可看到首页。

## GitHub Actions 自动部署

本项目支持 GitHub Actions 自动部署。每次推送到 `main` 分支时自动构建并部署。

### 配置步骤

1. Fork 本仓库到你的 GitHub 账号

2. 在 GitHub 仓库 → Settings → Secrets and variables → Actions 中添加：
   - `CF_API_TOKEN` — Cloudflare API Token（需 Workers 部署权限）
   - `CF_ACCOUNT_ID` — Cloudflare Account ID

3. 在 `wrangler.toml` 中填入你的 D1 ID

4. 推送代码，Actions 自动部署

### 手动触发部署

在 GitHub 仓库 → Actions → Deploy to Cloudflare Workers → Run workflow

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | *(空)* | 管理员密码，留空则默认 `admin` |
| `OPENCODE_MIRRORS_URL` | *(空)* | OpenCode 镜像地址列表，逗号分隔 |
| `TELEGRAM_BOT_TOKEN` | *(空)* | Telegram Bot Token（用于备份通知） |
| `TELEGRAM_USER_ID` | *(空)* | Telegram 用户 ID |

## 默认渠道配置

部署后自动创建以下渠道（无需配置即可使用）：

| 渠道 | 类型 | 说明 |
|------|------|------|
| OpenCode | OpenAI 兼容 | 免费模型，无需 API Key，含 3 个镜像地址故障转移 |
| Kilo | OpenAI 兼容 | 免费模型 + 前沿模型，无需 API Key |
| Azure TTS | 语音合成 | 内置 Azure 语音，无需 API 地址 |

## Antigravity 免费额度反代（`antigravity` 渠道）

Google 已停用 Gemini CLI 的个人免费额度（`loadCodeAssist` 直接判定 free-tier 不合格，请求返回
`403 SUBSCRIPTION_REQUIRED`），官方指定迁移到 [Antigravity](https://antigravity.google)。本渠道复刻
CLIProxyAPI 的 Antigravity 反代：Antigravity OAuth → `cloudcode-pa` 的 `v1internal`，
请求/响应与 Gemini 协议互转，同样统一在 `/v1/chat/completions`。

### 配置步骤

1. 后台「添加渠道」→ 渠道类型选 **Antigravity 反代**。
   - **API 地址**：自动填 `https://daily-cloudcode-pa.googleapis.com`，无需修改。
   - **获取 refresh_token**：点 **「用 Google 账号授权」** → Google 登录并同意 → 浏览器会跳转到
     `localhost:51121` 并提示「无法访问」（正常现象，回调地址是本机）→ 复制地址栏里 `code=`
     后面那一段（或整段地址）粘回弹窗，网关自动换取 refresh_token 并填入 API Keys。
   - **获取模型列表**：点 **「获取模型列表」** 会用该凭据拉取 Antigravity 可用模型名，追加到模型列表。
   - **GCP 项目 ID**：无需填写，网关自动 `loadCodeAssist` / `onboardUser` 解析。
2. 保存后在渠道里对模型点插头图标测试连通性。

> 模型名以「获取模型列表」返回的为准（例如 `gemini-3.5-flash`、`claude-sonnet-4-6` 等）。
> 网关不做白名单，填什么就透传什么，名字不对上游会报错。

## OAuth 反代渠道（`claude` / `codex` / `kimi` / `grok`）

参照 CLIProxyAPI 的实现，内置四种 OAuth 反代渠道。渠道 `apiKeys` 里每行一个对应平台的
OAuth refresh_token，网关自动换取/缓存 access_token（KV 缓存、支持上游轮换续期），
请求协议自动互转，统一从 `/v1/chat/completions` 调用：

| 渠道类型 | OAuth 方式 | 上游 | 说明 |
|----------|-----------|------|------|
| `claude` | Claude Code 客户端 OAuth（PKCE，授权链接） | `api.anthropic.com/v1/messages` | Anthropic Messages 协议；原生 `/v1/messages` 请求直接透传 |
| `codex` | Codex CLI OAuth（PKCE，授权链接） | `chatgpt.com/backend-api/codex/responses` | OpenAI Responses 协议，自动带 `Chatgpt-Account-Id`；原生 `/v1/responses` 透传 |
| `kimi` | Kimi 设备码（RFC 8628） | `api.kimi.com/coding/v1/chat/completions` | OpenAI 兼容直通，模型名自动归一化（如 `kimi-k2.8` → `kimi-for-coding`） |
| `grok` | xAI Grok CLI 设备码（OIDC 发现） | `cli-chat-proxy.grok.com/v1/responses` | OpenAI Responses 协议，带 Grok CLI 身份头；原生 `/v1/responses` 透传 |

### 配置步骤

1. 后台「添加渠道」→ 渠道类型选对应反代 → 点 **「授权登录获取 refresh_token」**：
   - **Claude / ChatGPT**：浏览器打开官方授权页登录同意后跳转到 `localhost:54545` /
     `localhost:1455`（「无法访问」属正常），复制地址栏 `code=` 后面那段（或整段地址）粘回弹窗。
   - **Kimi / Grok**：弹出设备码验证页并显示验证码，确认授权后弹窗自动完成，refresh_token
     自动填入 API Keys。
2. 点 **「获取模型列表」** 自动拉取（Claude / Kimi 支持）；Codex / Grok 手动填写模型，
   例如 Codex 填 `gpt-5.5`、`gpt-5.6` 等，Grok 填 `grok-4.6`、`grok-4.5` 等。
3. 保存后可点模型插头图标测试连通性。

> 授权入口使用各平台 CLI 的公开 OAuth 客户端（与 CLIProxyAPI 一致）。Codex 对出口 IP 有
> 地区限制，需部署在 OpenAI 支持的地区（Cloudflare Workers 默认出口通常可用）。


## 架构

```
客户端 → /v1/chat/completions → AI Gateway (Cloudflare Workers)
                                    ↓
                              D1 (主存储) ←→ KV (回退)
                                    ↓
                          渠道路由 + Key 健康检测
                                    ↓
                         opencode / kilo / agnes / tts / antigravity
```

## 项目结构

```
src/
├── index.ts          # 路由入口
├── proxy.ts          # API 转发核心
├── auth.ts           # 管理员登录
├── admin.ts          # 后台 API
├── pages.ts          # 管理后台前端
├── pages.css.ts      # 后台样式
├── storage.ts        # D1/KV 存储适配
├── config.ts         # 默认配置
├── types.ts          # TypeScript 类型
├── backup.ts         # 备份/恢复模块
├── azure-tts.ts      # Azure TTS 适配
├── azure-voices.ts   # Azure 音色列表
├── gemini-translate.ts # OpenAI <-> Gemini 协议翻译（Antigravity 复用）
├── antigravity.ts    # Antigravity 反代（OAuth + 协议翻译 + 可用模型）
```

## License

MIT
