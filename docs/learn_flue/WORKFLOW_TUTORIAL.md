# Flue Workflow 入门

本项目的示例位于 [`src/workflows/summarize.ts`](./src/workflows/summarize.ts)。它接收一段文本，调用 Agent 总结文本，并返回结构化结果。

## Agent 和 Workflow 的区别

- **Agent**：适合持续对话；同一个会话可以接受多条消息。
- **Workflow**：适合有明确开始和结束的任务；每次调用都会产生独立的 run 和结果。

“总结这一段文字”是一次性任务，因此很适合用 Workflow。

## 一个 Workflow 的五个部分

```ts
export default defineWorkflow({
  agent,                    // 1. 使用哪个 Agent
  input: inputSchema,       // 2. 输入格式
  output: outputSchema,     // 3. 输出格式
  async run({ harness, input }) { // 4. 执行逻辑
    const session = await harness.session();
    const { data } = await session.prompt('任务提示', {
      result: outputSchema,
    });
    return data;            // 5. 最终结果
  },
});
```

### 1. `agent`

示例复用了 `src/agents/hello-world.ts`。该 Agent 指定了模型 `deepseek/deepseek-v4-flash`。Workflow 自己不需要重复模型配置。

### 2. `input`

`input` 是 Valibot Schema。CLI 传入的 JSON 会先经过它验证：

```ts
const inputSchema = v.object({
  text: v.pipe(v.string(), v.minLength(1, 'text 不能为空')),
});
```

因此合法输入必须形如：

```json
{ "text": "需要总结的内容" }
```

### 3. `output`

示例要求最终结果包含一个摘要和一个要点数组：

```json
{
  "summary": "简短摘要",
  "keyPoints": ["要点一", "要点二"]
}
```

### 4. `run()`

`run()` 是 Workflow 的主体。`input` 已经过验证；`harness` 用于创建 Agent 会话、操作沙箱文件系统等。

### 5. 结构化模型结果

将 `outputSchema` 传给 `session.prompt(..., { result })`，可以让模型返回经过 Schema 校验的 `data`，而不是让应用手动解析自然语言。

## 运行示例

```bash
npm run workflow -- --input '{"text":"Flue 是一个 TypeScript Agent 框架。Agent 适合持续交互，Workflow 适合有明确输入和结果的一次性任务。"}'
```

你也可以直接使用 Flue CLI：

```bash
npx flue run summarize --target node --input '{"text":"在这里填写文本"}'
```

## 练习建议

1. 给输入增加 `language` 字段，让用户指定输出语言。
2. 给输出增加 `title` 字段。
3. 使用 `v.picklist(['short', 'detailed'])` 增加摘要风格。
4. 新建一个 `translate.ts` Workflow，实现结构化翻译任务。

本示例没有导出 `route`，所以不会公开 HTTP 调用入口；本地学习直接使用 `flue run` 即可。
