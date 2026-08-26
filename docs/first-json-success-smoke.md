# 受控 live smoke 方案（待批准）

本方案尚未执行。批准前不得调用 DeepSeek / Tavily。

## 问题

上一轮 Demo 主审校首次响应 `output_tokens=8192` 且 JSON 无法解析（截断），第二次才成功（7633 tokens），把 55s 产品 deadline 耗尽后降级为 `rules_only`。official `DEEPSEEK_RETRY_POLICY`（2 次 / 60s / 8192 tokens）未改。

## 已做的离线修改（产品路径）

- 产品主审校 `maxTokens=3072`（仅 `createReview({ deadlineMs })` 注入）。
- 仅在传入 `maxTokens` 时追加简短 JSON 闭合约束；official `review()` 仍为 8192、无该后缀。
- 55s deadline、Product Freeze、official retry 不变。

## 批准后怎么跑（只一次）

1. 新库：`REVIEW_DB_PATH=.data/first-json-success.db`（避免旧 cache）。
2. 与第二轮相同：`REVIEW_PROVIDER=deepseek`，`WEB_EVIDENCE_ENABLED=true`，`REVIEW_SPECIALISTS_ENABLED=1`，同一 `data/fixtures/demo-article.json`。
3. `next start -p 3001`，`POST /api/reviews` **一次**。
4. 成功标准：
   - 墙钟与 `elapsed_ms` ≤ 55s；
   - 首次 attempt 为 `success`，或首次失败后第二次在 deadline 内成功；
   - 首次 `output_tokens` 明显低于 8192，且 JSON 可解析；
   - 非 `rules_only`（除非模型仍然截断，则停止并报告，不重试）。
5. 记录 Git SHA、observed model、attempts、usage/cost、Tavily `query_count`、specialist `invoked`/`used`、fallback。

失败则停止，不再烧 API。
