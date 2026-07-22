# AI 账号快讯验证版

该项目采集受监控的 AI 组织与行业人物 X 账号推文，将原始内容写入业务数据库；
分类阶段再过滤回复、普通转发和日常宣传，并为重要事件生成中文 Markdown 快讯。

## 监控账号

- `@OpenAI`
- `@AnthropicAI`
- `@claudeai`（Claude，归属 Anthropic）
- `@GoogleDeepMind`
- `@GoogleAIStudio`（Google AI Studio）
- `@googleaidevs`（Google AI Developers）
- `@OfficialLoganK`（Logan Kilpatrick）
- `@Google`
- `@googlegemma`（Google Gemma）
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
- `@Alibaba_Qwen`（Alibaba Qwen）
- `@MiniMax_AI`（MiniMax）
- `@badlogicgames`（Mario Zechner）
- `@ylecun`（Yann LeCun）
- `@cursor_ai`（Cursor）
- `@nvidia`（NVIDIA）
- `@DarioAmodei`（Dario Amodei）
- `@trq212`（Thariq Shihipar）

账号清单位于 `src/news/config.ts`。

## 数据边界

- `data/flue.db`：Flue 的 Topic 分类、Topic 合并、报告生成 Agent 会话和 Workflow Run；
  旧版 `news:pull` 中的直接分类请求仍不创建 Agent 会话。
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

Flue Node Server 内置 Croner 调度器。通过项目脚本启动 Server 时，会自动启用新闻任务：

```bash
npm run dev
# 或
npm run build && npm start
```

项目脚本默认监听 `http://localhost:3107`，可通过 `PORT` 环境变量覆盖。健康检查：

```bash
curl http://localhost:3107/health
```

当前热榜可以直接查询：

```bash
curl http://localhost:3107/news/hot-topics
```

响应包含生成时间，以及每个上榜 Topic 的中英文标题、有效浏览量、增长速度、热度、
状态和排名。

采集按 UTC `0 0,4,8,12,15-23 * * *` 运行，即 00:00、04:00、08:00、12:00，
并在 15:00–23:00 每小时运行。每次采集完成后，Server 会通过 Flue `invoke()`
提交一次独立的 `news-triage` Workflow Run。Croner 使用 `protect: true` 防止采集任务
自身重叠，业务数据库作业锁继续防止分类任务重叠。

直接运行 `npm run news:ingest` 或 `npm run news:triage` 时不会额外启动调度器。
命令以 JSON 输出本轮统计；任一账号失败时设置非零退出码，但其他账号已成功写入的
内容会保留。

## Topic 分类

Topic 分析由 Flue Workflow 编排：

```bash
npm run news:triage
```

Workflow 只在 TwitterAPI.io 的 Tweet 数据包含非空 `article` 字段时调用 X Article
接口并保存完整正文；普通外部链接的 `card` 不会触发 Article 请求。
随后为每个账号批次创建独立 Agent session，通过 Valibot 结构化结果将所有 Original、
Quote、Reply 和 Repost 分为 `important`、`observe` 或 `ignore`。Agent 使用 DeepSeek
V4 Pro，分析结果只能引用预定义组织 ID，未知组织只作为候选名称保存。

`important` 和 `observe` 都会生成中英双语 Topic 候选。系统只把最新来源 Post 发布于
最近 72 小时内的 Topic 交给同一个新闻 Topic Agent 的独立结构化 session，选择已有
Topic 或创建
新 Topic。因此多个账号讨论同一事件时只关联一个 Topic。Agent 不拥有数据库写入工具；
查询、校验、事务和重试均由 Workflow 的 TypeScript 代码控制。此阶段只建立 Topic
数据模型，暂不为新 Topic 生成 Markdown。

## 指标与热榜

指标任务是独立的确定性 TypeScript CLI，不调用 Agent 或 LLM：

```bash
npm run news:metrics
```

它通过 TwitterAPI.io `/twitter/tweets` 批量刷新 Topic 下 Post 的浏览、点赞、转发、
回复和引用指标，并保存不可变快照。Flue Server 按 UTC `45 0,4,8,12,16,20 * * *` 自动运行指标任务，即每 4 小时
执行一次，并延后到每小时第 45 分钟，尽量避开采集和分类。也可以手工运行：

```bash
npm run news:metrics
```

主要规则：

- `observe` Post 发布满 5 小时后，达到 25 万浏览或相比首次快照新增 10 万浏览，
  自动晋级为 `important`；
- Topic 有效浏览量 = 最高单帖浏览量 + 其他 Post 浏览量总和 × 30%；
- 有效浏览量达到 100 万后进入热榜；
- 热度 = 对数浏览量百分位 × 50% + 对数增长速度百分位 × 50%；
- 连续两次 `heat < 0.35` 时下榜；
- 连续两次增长率低于 5%，或 Topic 下所有 Post 都超过 72 小时，停止刷新；
- 单条指标请求失败不会写入零值，也不会推进低增长计数。

完整算法说明见 [`TOPIC_HEAT_DESIGN.md`](./TOPIC_HEAT_DESIGN.md)。

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

## 旧版 `news:pull` 处理规则

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
- 新账号首次只保留最新 20 条；后续采集通过 cursor 翻页到上次成功边界。
- 已采集互动快照并计算 Topic 热度，但暂不分析传播路径或圈层扩散。
- 首版一条推文只归入一个主要事件。
- `news:triage` 的分类和 Topic 合并会进入 Flue Agent session；旧版 `news:pull`
  的直接分类请求仍不记录逐请求会话。两条流程的错误都会记录到业务数据库和运行输出。
