# atomcode-api

把 AtomCode（AtomGit CodingPlan）暴露成本机 OpenAI Chat Completions 兼容
API 的独立网关。它不依赖 Magpie，也不需要运行 Atom2Api。

> 非官方实现。上游协议可能随时变化，使用方式也可能受到服务条款限制并导致
> 账号受限。请只使用自己的账号并自行评估风险。

## 环境要求

- Node.js 20 或更高版本
- 一个可登录 AtomCode 的 AtomGit 账号

项目没有第三方运行时依赖。

## 快速开始

在本目录运行：

```bash
node bin/atomcode-api.mjs login
node bin/atomcode-api.mjs key
node bin/atomcode-api.mjs serve
```

登录命令会打开 AtomGit 授权页，换取并保存 token，然后幂等检查并领取
CodingPlan。服务默认监听：

```text
http://127.0.0.1:8787/v1
```

把本地 API Key 和上面的 Base URL 填入支持 OpenAI Chat Completions 的客户端。

```bash
export ATOMCODE_LOCAL_KEY="$(node bin/atomcode-api.mjs key)"

curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $ATOMCODE_LOCAL_KEY"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $ATOMCODE_LOCAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-27b",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

流式请求直接传 `"stream": true`。工具调用、视觉输入和
`reasoning_effort` 等字段会原样转发，流式响应逐块返回。

## 命令

```text
atomcode-api login
atomcode-api serve [--port 8787]
atomcode-api status [--json]
atomcode-api models [--json]
atomcode-api checkin [--json]
atomcode-api logout
atomcode-api key
```

`login` 默认调用系统浏览器；可用 `--no-open` 只打印授权地址。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 无需本地 Key，返回服务与登录状态 |
| GET | `/v1/models` | 当前账号的模型目录 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 代理，支持 SSE |

本地 API Key 使用 `Authorization: Bearer <key>`。错误采用 OpenAI 错误结构。
首版只支持 Chat Completions，不支持 Responses API 或 Anthropic Messages。

## 文件与配置

默认目录：

```text
~/.atomcode-api/config.json
~/.atomcode-api/auth.json
```

两个文件都会以 `0600` 权限写入。`auth.json` 包含 AtomCode 凭证，不应复制或提交。

可用环境变量：

| 变量 | 说明 |
|---|---|
| `ATOMCODE_API_HOME` | 替换配置目录，便于沙箱或测试 |
| `ATOMCODE_API_KEY` | 覆盖本地 API Key |
| `ATOMCODE_API_PORT` | 覆盖监听端口 |

服务只绑定 `127.0.0.1`，不提供 CORS、局域网或公网模式。

## 开发与验证

```bash
npm test
npm run test:coverage:enforce
npm run pack:check
```

签名算法使用 Atom2Api 的独立测试向量作为兼容基准。真实登录测试必须由账号
持有人手动完成，不要把 access token、refresh token 或 `auth.json` 发到日志、
Issue 或提交中。

## 来源

协议层从 `magpie-atomcode` 的固定提交复制并改造，详情见
[NOTICE.md](NOTICE.md)。安全边界见 [SECURITY.md](SECURITY.md)。
