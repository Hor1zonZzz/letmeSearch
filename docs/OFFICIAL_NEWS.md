# AI 账号快讯验证版

该项目采集受监控的 AI 组织与行业人物 X 账号推文，将原始内容写入业务数据库；
分类阶段再过滤回复、普通转发和日常宣传，并为重要事件生成中文 Markdown 快讯。

## 监控账号

- `@OpenAI`
- `@AnthropicAI`
- `@claudeai`（Claude，归属 Anthropic）
- `@GoogleDeepMind`
- `@Kimi_Moonshot`
- `@Zai_org`
- `@elonmusk`（Elon Musk）
- `@karpathy`（Andrej Karpathy）
- `@ilyasut`（Ilya Sutskever）
- `@sama`（Sam Altman）
- `@SpaceXAI`
- `@gdb`（Greg Brockman）
- `@thinkymachines`（Thinking Machines Lab）
- `@Ali_TongyiLab`（Alibaba Tongyi Lab）
- `@cursor_ai`（Cursor）
- `@nvidia`（NVIDIA）
- `@DarioAmodei`（Dario Amodei）
- `@trq212`（Thariq Shihipar）

账号清单位于 `src/news/config.ts`。

## 数据边界

- `data/flue.db`：Flue 自身的报告生成 Agent 会话和 Workflow Run；
  直接调用 DeepSeek 的分类请求不创建 Agent 会话。
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

## 数据采集

采集是独立的 TypeScript CLI，不依赖 Flue Workflow、Agent 或模型调用：

```bash
npm run news:ingest
```

它最多同时抓取 10 个账号，并设置 `includeReplies=true`，因此 Original、Quote、
Reply 和 Repost 都会入库。新账号首次只保存最新一页（最多 20 条）；后续从最新页开始，
使用 cursor 向历史翻页，直到达到该账号上次成功抓取的时间边界。
`posts.x_post_id` 唯一约束负责最终去重。

建议由系统 cron 按 UTC 调度：

```cron
CRON_TZ=UTC
0 0,4,8,12,15-23 * * * cd /path/to/project && npm run news:ingest
```

即 UTC 00:00、04:00、08:00、12:00 运行，并在 15:00–23:00 每小时运行。
命令以 JSON 输出本轮统计；任一账号失败时设置非零退出码，
但其他账号已成功写入的内容会保留。

## Topic 分类

独立的 Topic 分析命令不使用 Flue Agent session：

```bash
npm run news:triage
```

它首先检测疑似 X Article，并调用 TwitterAPI.io Article 接口保存完整双语分类证据；
随后按发布账号分批调用 DeepSeek V4 Pro，将所有 Original、Quote、Reply 和 Repost
分为 `important`、`observe` 或 `ignore`。分析结果使用预定义组织 ID，未知组织只作为
候选名称保存。

`important` 和 `observe` 都会生成中英双语 Topic 候选。系统把候选与最近 7 天的
活跃 Topic 交给结构化 LLM 请求，选择已有 Topic 或创建新 Topic。因此多个账号讨论
同一事件时只关联一个 Topic。此阶段只建立 Topic 数据模型，暂不为新 Topic 生成
Markdown；指标快照和热榜属于后续阶段。

## 分类与报告

现有端到端 Workflow 可继续手工运行：

```bash
npm run news:pull
```

默认每个账号读取最近 5 条推文，再执行分类和报告。也可以直接调用 Workflow：

```bash
npx flue run official-news-pull --target node \
  --input '{"maxPostsPerAccount":5}'
```

Workflow 的结果包含账号成功数、拉取数、新推文数、忽略数、事件数、报告版本数、文件导出数和局部错误。

## 首版处理规则

1. TwitterAPI.io 返回的 X ID 始终按字符串保存。
2. 采集 CLI 将原创、Quote、回复和普通转发全部入库；回复和普通转发在当前分类状态中直接标记为 `ignored`。
3. 原创和 Quote 按 X 账号分组，各账号通过一次直接 DeepSeek JSON 请求并发判断是否包含重要事件；分类不创建 Agent session。
4. 每个账号的分类结果独立校验。单个账号失败时，其帖子标记为 `failed` 并留待下次 Workflow 运行重试，不影响其他账号。
5. 代码根据组织、主体和动作生成事件指纹。
6. 同一事实的重复来源只补充来源 ID，不创建新报告版本。
7. 新事件生成 v1；新增事实生成后续完整版本。
8. 分类响应先经过 JSON 解析、Valibot Schema 和帖子 ID 完整性校验；LLM 不直接修改数据库。
9. 分类请求全部并发，事件合并、报告生成和 SQLite 写入仍按帖子发布时间顺序串行执行。

## 当前限制

- 这是一次性 REST 拉取，不是实时 WebSocket 监听。
- 每个账号只看最近若干条；两次运行间发布量超过该数量时可能漏取。
- 暂不采集互动快照，也不计算热度、趋势或圈层扩散。
- 首版一条推文只归入一个主要事件。
- 分类调用不进入 Flue Agent session，因此 `data/flue.db` 不包含其逐请求会话轨迹；
  分类错误会记录到业务数据库和 Workflow 输出。
