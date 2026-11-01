# atomcode-api

把 **AtomCode（AtomGit CodingPlan）** 暴露成本机 **OpenAI Chat Completions
兼容 API** 的独立网关。它不依赖 Magpie、LiteLLM 或 Atom2Api，登录、凭证刷新、
模型目录、套餐领取、请求签名和流式转发均由本项目完成。

> [!WARNING]
> 这是非官方兼容实现，不隶属于 AtomGit / AtomCode，也未获其认可。上游协议
> 可能随时变化；使用方式可能受到服务条款限制，并存在账号受限或封禁风险。
> 请只使用自己的账号并自行评估风险。

## 功能

- 浏览器 OAuth 登录 AtomGit，并自动刷新 token
- 登录后幂等检查、领取缺失或过期的 CodingPlan
- OpenAI Chat Completions 兼容端点
- 普通响应和 SSE 流式响应逐块透传
- 工具调用、视觉输入、reasoning 和自定义采样字段原样转发
- 动态读取当前账号可用的模型目录
- 独立本地 API Key，AtomCode token 不暴露给下游客户端
- 仅监听回环地址，强制校验 `Host` 和上游目标
- 无第三方运行时依赖

## 架构

```text
OpenAI-compatible client
        │
        │  Authorization: Bearer <local API key>
        ▼
http://127.0.0.1:8787/v1
        │
        │  AtomCode bearer + atomcode-signing-v1 headers
        ▼
https://llm-api.atomgit.com/v1
```

本地 API Key 和 AtomCode token 是两套独立凭证：

- 下游客户端只能看到本地 API Key。
- AtomCode access token、refresh token 只保存在本机，并只发送到官方端点。
- 服务不会把上游鉴权头、token 或凭证写入日志。

## 环境要求

- Node.js 20 或更高版本
- 一个可登录 AtomCode 的 AtomGit 账号
- macOS、Linux 或 Windows

## 安装

```bash
git clone https://github.com/LILEOO/atomcode-api.git
cd atomcode-api
npm install
npm link
```

执行 `npm link` 后可直接使用 `atomcode-api` 命令。若不希望安装全局命令，也可以
始终使用：

```bash
node bin/atomcode-api.mjs <command>
```

## 快速开始

1. 登录 AtomGit，保存 token 并领取套餐：

```bash
atomcode-api login
```

命令会打开系统浏览器。授权完成后回到终端，登录会自动完成：

```text
DONE: The plan is still active: CodingPlan Pro
Sign-in saved. Fetch the local API key with: atomcode-api key
```

如果浏览器没有自动打开：

```bash
atomcode-api login --no-open
```

复制输出的授权地址，在浏览器中完成登录。

2. 获取本地 API Key：

```bash
atomcode-api key
```

3. 启动服务：

```bash
atomcode-api serve
```

默认地址：

```text
Base URL: http://127.0.0.1:8787/v1
```

4. 在支持 OpenAI Chat Completions 的客户端中填写：

```text
API 类型: OpenAI Chat Completions
Base URL: http://127.0.0.1:8787/v1
API Key:  atomcode-api key 的输出
Model:    atomcode-api models 中显示的任意模型
```

客户端需要支持自定义 OpenAI Base URL。服务只实现 Chat Completions，没有实现
OpenAI Responses API 或 Anthropic Messages API。

## 模型

模型目录由当前账号和套餐决定，不要在客户端里硬编码模型列表。查看实时目录：

```bash
atomcode-api models
```

示例输出：

```text
Source: live
glm5.3-flash    context=512000   vision=true
qwen3.8-27b     context=262144   vision=true
deepseek-flash  context=1000000  vision=true
```

模型上下文、视觉能力和 reasoning 档位可能随上游变化，以 `/v1/models` 和
`atomcode-api models` 的实时结果为准。

## HTTP API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/healthz` | 无 | 服务和登录状态 |
| `GET` | `/v1/models` | 本地 Key | 当前账号的模型目录 |
| `POST` | `/v1/chat/completions` | 本地 Key | Chat Completions 代理 |

`/v1/*` 使用：

```http
Authorization: Bearer <local-api-key>
```

### 健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

```json
{
  "ok": true,
  "authenticated": true,
  "version": "0.1.0"
}
```

### 模型列表

```bash
KEY="$(atomcode-api key)"

curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $KEY"
```

除标准 OpenAI 字段外，每个模型还包含上下文长度、视觉能力和 reasoning 档位：

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3.8-27b",
      "object": "model",
      "created": 0,
      "owned_by": "atomcode",
      "context_window": 262144,
      "max_output_tokens": 32768,
      "supports_vision": true,
      "reasoning_effort_levels": ["low", "medium", "xhigh"]
    }
  ]
}
```

### 普通对话

```bash
KEY="$(atomcode-api key)"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-27b",
    "messages": [
      {"role": "user", "content": "用一句话介绍你自己"}
    ],
    "max_tokens": 512,
    "reasoning_effort": "low"
  }'
```

### 流式对话

```bash
KEY="$(atomcode-api key)"

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-27b",
    "messages": [
      {"role": "user", "content": "从 1 数到 5"}
    ],
    "stream": true,
    "max_tokens": 512,
    "reasoning_effort": "low"
  }'
```

上游的 SSE 数据块和 `[DONE]` 会直接返回，不经过缓冲或协议转换。

### 工具调用

```bash
KEY="$(atomcode-api key)"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-27b",
    "messages": [
      {"role": "user", "content": "Use get_weather for Shanghai."}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ],
    "tool_choice": "auto",
    "reasoning_effort": "low",
    "max_tokens": 512
  }'
```

返回的 `tool_calls`、`reasoning_content`、视觉消息和客户端自定义字段均来自上游，
网关不会改写请求体内容。

### 错误格式

本地鉴权、请求校验和服务错误使用 OpenAI 兼容结构：

```json
{
  "error": {
    "message": "Invalid local API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

常见状态码：

| HTTP | 含义 |
|---|---|
| `400` | JSON、`model` 或其他请求结构无效 |
| `401` | 本地 Key 错误，或 AtomCode 登录已失效 |
| `403` | `Host` 不是回环地址 |
| `404` | 路径不存在 |
| `405` | HTTP 方法不支持 |
| `413` | 请求体超过 32 MiB |
| `502` | 上游网络或服务错误 |

除本地鉴权、输入校验和网络错误外，上游返回的 HTTP 状态和错误体原则上直接
透传给客户端。

## CLI

```text
atomcode-api login [--no-open]
atomcode-api serve [--port 8787]
atomcode-api status [--json]
atomcode-api models [--json]
atomcode-api checkin [--json]
atomcode-api logout
atomcode-api key
```

| 命令 | 说明 |
|---|---|
| `login` | 浏览器 OAuth 登录并自动领取套餐 |
| `serve` | 启动本机 API |
| `status` | 查看账号、套餐、到期时间和额度窗口 |
| `models` | 查看当前账号的实时模型目录 |
| `checkin` | 套餐缺失或过期时执行幂等领取 |
| `logout` | 删除本地 AtomCode 凭证 |
| `key` | 输出本地 API Key |
| `--json` | 输出适合脚本处理的 JSON |

查看状态：

```bash
atomcode-api status
```

```text
Account: <account>
Plan: CodingPlan Pro
Until: 2026-11-26
Quota: 5h window: 31% (251 / 800 calls)
```

退出登录：

```bash
atomcode-api logout
```

`logout` 只删除 AtomCode 登录凭证，不删除本地 API Key 配置。重新使用前运行
`atomcode-api login`。

## 配置与凭证

默认目录：

```text
~/.atomcode-api/
├── config.json   # 本地 API Key 和端口
└── auth.json     # AtomCode access / refresh token
```

目录权限为 `0700`，文件权限为 `0600`。`auth.json` 包含可用于访问上游账号的
凭证，禁止提交、复制到聊天或附在 Issue 中。

环境变量：

| 变量 | 说明 |
|---|---|
| `ATOMCODE_API_HOME` | 替换整个配置目录 |
| `ATOMCODE_API_KEY` | 覆盖本地 API Key |
| `ATOMCODE_API_PORT` | 覆盖监听端口 |

示例：

```bash
ATOMCODE_API_PORT=9000 atomcode-api serve
```

## 安全边界

- 服务只绑定 `127.0.0.1`，不接受局域网或公网连接。
- 每个请求校验 `Host`，阻止非回环 Host 和常见 DNS rebinding 场景。
- `/v1/*` 必须提供本地 API Key。
- AtomCode token 与签名头只附加到 `https://llm-api.atomgit.com`。
- 上游跳转被拒绝；非官方目标在发送任何凭证前被拦截。
- OAuth 和 CodingPlan 元数据响应有大小上限。
- 请求体上限为 32 MiB。
- 服务不提供 CORS；浏览器网页不能直接跨域调用该 API。
- token 到期前自动刷新；上游返回 `401` 时最多刷新并重试一次。

更多说明见 [SECURITY.md](SECURITY.md)。

## 排障

### `No AtomCode account is signed in`

```bash
atomcode-api login
```

### `/v1/models` 返回 `401 invalid_api_key`

确认客户端使用的是 `atomcode-api key` 的完整输出，而不是 AtomCode token：

```bash
atomcode-api key
```

### AtomCode 登录失效

先重新登录：

```bash
atomcode-api login
```

如果错误仍然存在，使用同一个账号运行官方 AtomCode 客户端。若官方客户端也
被拒绝，更可能是账号或上游风控问题。

### 返回内容为空但 `finish_reason` 是 `length`

部分模型会先输出 `reasoning_content`。`max_tokens` 太小时，预算可能全部消耗在
推理阶段，最终 `content` 为空。提高 `max_tokens`（例如 `512` 或更高），或在
模型支持时使用较低的 `reasoning_effort`。

### 工具调用没有触发

- 确认模型出现在 `atomcode-api models` 中。
- 使用标准的 `tools` 和 `tool_choice` 字段。
- 提高 `max_tokens`，避免推理阶段提前用尽预算。
- 检查响应中的 `finish_reason` 是否为 `tool_calls`。

### 端口被占用

```bash
atomcode-api serve --port 9000
```

## 开发

```bash
npm install
npm test
npm run test:coverage:enforce
npm run pack:check
```

当前测试覆盖：

- 100+ 项单元和集成测试
- Atom2Api 独立签名向量
- OAuth、token 刷新和 CodingPlan 领取
- 模型目录缓存和失败降级
- 本地鉴权、Host 校验、请求体限制
- SSE、工具调用、reasoning 和客户端断开传播
- Node.js 20 兼容性

提交前至少运行：

```bash
npm test
npm run test:coverage:enforce
```

不要提交 `auth.json`、access token、refresh token、OAuth state、账号 ID、
邮箱或未脱敏日志。

## 来源与许可

协议层从
[`aqiu817/magpie-atomcode`](https://github.com/aqiu817/magpie-atomcode)
的固定提交复制并改造，详细署名见 [NOTICE.md](NOTICE.md)。

本项目使用 [MIT License](LICENSE)。

## 免责声明

AtomCode、AtomGit 及相关名称归其各自权利人所有。本项目不是官方产品，也未获
认可。上游协议、签名密钥、模型目录和配额规则可能随时变化；使用自动化网关
可能违反服务条款。使用者自行承担账号受限、额度损失和其他风险。
