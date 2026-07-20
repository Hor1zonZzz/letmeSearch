# 官方 AI 账号快讯验证版

该流程一次性拉取五个官方 X 账号的最近推文，过滤回复、普通转发和日常宣传，并为重要事件生成中文 Markdown 快讯。

## 监控账号

- `@OpenAI`
- `@AnthropicAI`
- `@GoogleDeepMind`
- `@Kimi_Moonshot`
- `@Zai_org`

账号清单位于 `src/news/config.ts`。

## 数据边界

- `data/flue.db`：Flue 自身的 Agent 会话和 Workflow Run。
- `data/news.db`：账号、推文、事件和完整稿件版本。
- `data/reports/<event-id>.md`：每个事件当前最新稿的可再生导出文件。

业务 SQLite 是稿件的事实源。本地 Markdown 写入失败时，数据库版本仍会保留；后续运行会再次导出尚未同步的版本。

## 配置

在项目根目录 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=...
TWITTERAPI_IO_KEY=...
```

不要把真实密钥写入 `.env.example` 或提交到 Git。

## 运行

```bash
npm run news:pull
```

默认每个账号读取最近 5 条推文。也可以直接调用 Workflow：

```bash
npx flue run official-news-pull --target node \
  --input '{"maxPostsPerAccount":5}'
```

Workflow 的结果包含账号成功数、拉取数、新推文数、忽略数、事件数、报告版本数、文件导出数和局部错误。

## 首版处理规则

1. TwitterAPI.io 返回的 X ID 始终按字符串保存。
2. 回复和普通转发落库后直接标记为 `ignored`。
3. 原创和 Quote 由结构化分类 Agent 判断是否包含重要事件。
4. 代码根据组织、主体和动作生成事件指纹。
5. 同一事实的重复来源只补充来源 ID，不创建新报告版本。
6. 新事件生成 v1；新增事实生成后续完整版本。
7. LLM 只返回经过 Valibot 校验的分类和稿件字段，不直接修改数据库。

## 当前限制

- 这是一次性 REST 拉取，不是实时 WebSocket 监听。
- 每个账号只看最近若干条；两次运行间发布量超过该数量时可能漏取。
- 暂不采集互动快照，也不计算热度、趋势或圈层扩散。
- 首版一条推文只归入一个主要事件。
