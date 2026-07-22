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

- `data/flue.db`：Flue 的 Topic 分类、Topic 合并 Agent 会话和 Workflow Run；
- `data/news.db`：账号、推文、Topic、指标快照和热榜状态。

业务 SQLite 是新闻 Topic 和指标的事实源。

## 配置

在项目根目录 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=...
TWITTERAPI_IO_KEY=...
NEWS_DATABASE_PATH=./data/news.db
```

不要把真实密钥写入 `.env.example` 或提交到 Git。测试可将 `NEWS_DATABASE_PATH`
指向临时 SQLite 副本，避免修改生产 `data/news.db`。

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

当前提供影响力榜和爆发榜：

```bash
curl http://localhost:3107/news/hot-topics       # 绝对影响力榜
curl http://localhost:3107/news/breakout-topics  # 粉丝归一化爆发榜
curl http://localhost:3107/news/leaderboards     # 同时返回两个榜
```

影响力榜返回 Topic 的有效浏览量、增长速度和热度；爆发榜返回有效触达率、触达率增长速度
和爆发热度。两者均包含中英文标题和当前排名。

采集按 UTC `0 0,4,8,12,15-23 * * *` 运行，即 00:00、04:00、08:00、12:00，
并在 15:00–23:00 每小时运行。每次采集完成后，Server 会通过 Flue `invoke()`
提交一次独立的 `news-triage` Workflow Run；分类完成后该 Workflow 会立即提交
`news-topic-resolve` Run。系统不再单独定时运行 Resolver；技术失败会在下一轮抓取后
自动重试，也可以手工运行 `npm run news:resolve`。Croner 使用 `protect: true` 防止
同一 Cron 回调重叠，业务数据库作业锁防止分类和 Resolver 实例重叠。

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
Quote、Reply 和 Repost 分为 `important` 或 `ignore`。Agent 使用 DeepSeek
V4 Pro，分析结果只能引用预定义组织 ID，未知组织只作为候选名称保存。

`important` 会生成中英双语 Topic 候选并进入独立 Resolution 队列；
`news:triage` 不同步合并 Topic，但会在分类完成后立即激活 Topic Resolver。分类和
Resolution 都只处理当前时间向前 72 小时内的 Post；Article 补全和分类积压按发布时间
从新到旧处理，避免历史积压阻塞最新新闻。

## Topic Resolver

Topic 合并由独立 Flue Workflow 执行：

```bash
npm run news:resolve
```

Resolver 按账号建立批次：同一账号本轮最多 20 条 `important` Post 进入同一个
`topic-resolver` Agent session，账号批次之间严格串行。Agent 先在批次内部按真实事件、
持续故事、技术洞察或专家论点分组，再通过四个精简工具完成 Resolution：

- `search_topics(posts)`：搜索至少包含一条最近 72 小时来源 Post 的现有 Topic；
- `add_posts(posts, topic, update?)`：把一组 Post 原子加入搜索返回的 Topic，可选更新双语内容；
- `create_topic(posts, topic)`：搜索无同事件结果时，从整组 Post 创建一个双语 Topic；
- `finish_topic_plan()`：仅在批次中每条 Post 都恰好分配一次后完成。

Agent 只看到 `p1`、`p2` 和 `t1` 等 session 短引用；数据库 UUID、search ID、revision、
搜索策略和分页参数均由 TypeScript 管理。每次 `add_posts` 或 `create_topic` 都是独立的
短事务并立即生效，因此后续组发生技术故障时，已成功组不会回滚；剩余 Post 保持失败
重试状态。业务决策只有 attach 或 create，没有 defer、ignore 或现有 Topic 之间的 merge。
工具失败不能作为创建依据，系统会按退避时间自动重试未完成 Post。

一条 Post 由 `topic_posts.post_id` 主键保证最多属于一个 Topic；一个 Topic 可以原子接收
一条或多条 Post。每次成功写入及搜索轨迹继续记录到 `topic_resolution_events`。

系统以 Topic 为热度和排名单位。多个账号讨论同一事件时只关联一个 Topic。

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

- Topic 有效浏览量 = 最高单帖浏览量 + 其他 Post 浏览量总和 × 30%；
- 有效浏览量达到 100 万后进入影响力榜；
- 影响力热度 = 对数浏览量百分位 × 50% + 对数增长速度百分位 × 50%；
- 单帖触达率 = 浏览量 ÷ 账号粉丝数；Topic 有效触达率同样采用最高值全额、其余值 30% 的折扣汇总；
- 爆发热度 = 对数有效触达率百分位 × 50% + 对数触达率增长速度百分位 × 50%；
- 粉丝数从抓取响应中的 Tweet author 数据首次写入后固定，避免分母变化制造虚假增速；
- 连续两次 `heat < 0.35` 时从影响力榜下榜；
- 连续两次增长率低于 5%，或 Topic 下所有 Post 都超过 72 小时，停止刷新；
- 单条指标请求失败不会写入零值，也不会推进低增长计数。

人类可读的交互式图解见 [`TOPIC_HEAT_EXPLAINER.html`](./TOPIC_HEAT_EXPLAINER.html)，
可以修改示例数据并实时查看热度计算；工程设计说明见
[`TOPIC_HEAT_DESIGN.md`](./TOPIC_HEAT_DESIGN.md)。

## 重复 Topic 人工复核

可运行只读 dry-run 生成疑似重复 Topic 对：

```bash
npm run --silent news:topics:dry-run > data/topic-dedup-review.json
```

命令按 72 小时时间窗、事件类型、组织重叠、双语主题相似度和强引用生成建议，不写数据库、
不自动合并。输出应由人工核验后再执行未来的显式 merge 操作。

## 当前限制

- 这是一次性 REST 拉取，不是实时 WebSocket 监听。
- 新账号首次只保留最新 20 条；后续采集通过 cursor 翻页到上次成功边界。
- 已采集互动快照并计算 Topic 热度，但暂不分析传播路径或圈层扩散。
- 一条推文只归入一个 Topic。
- `news:triage` 分类与 `news-topic-resolve` Topic 合并分别进入独立 Flue Agent session；
  两条流程的错误都会记录到业务数据库和运行输出。
