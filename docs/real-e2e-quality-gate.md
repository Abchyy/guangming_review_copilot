# 真实 E2E Quality Gate（开发报告）

本报告记录公开 Demo 稿的真实 DeepSeek + Tavily + specialist 审校。不是 official holdout，不是 locked 分数，不改 Product Freeze、评估门槛或默认开关。

## 第二轮：55s 产品 deadline（`next start`）

同一 Demo，**只跑一次**，冷库（无 candidate cache）。产品路径 `PRODUCT_REVIEW_DEADLINE_MS=55_000`，不提高 `maxDuration=60`。

| 项 | 观察值 |
| --- | --- |
| HTTP | `POST /api/reviews` **200** |
| 墙钟 | **55.132s**（目标 ≤55s，超出 132ms 为 abort 收尾；**未再烧 API**） |
| `pipeline.elapsed_ms` | **55030** |
| `review_id` | `fe8413df-4fc7-456c-9370-6334492ced3e` |
| Findings | 7 条规则结果；`dropped_count=0` |
| Fallback | **`rules_only`**（`DeepSeek provider unavailable`） |
| 主审校 attempts | 1，`fatal_failure`，`received_provider_response=false` |
| Usage / 成本 | usage **incomplete / unobserved**；成本 **indeterminate**（中途 abort） |
| 应用缓存 | enabled，**miss** |
| Web Evidence | 2 条计划查询均 `unverified` / `timeout`（deadline 后未再打 Tavily） |
| Specialist | 派发 `fact_check` 1/2；`timed_out`，`trace_status=unobserved`，`elapsedMs=0`，`unobserved_usage_attempts=1` |

结论：总预算在 60s 内安全降级；剩余外部调用被取消；失败 specialist 明确标为 unobserved。未达到严格 ≤55.000s，按要求停止，不重复调用。

---

## 第一轮：无整体 deadline（对照）

- 基线 Git SHA：`f583e4e6ad123b80b77aafa46cdc3618cf7a6be8`
- 稿件：公开 Demo `data/fixtures/demo-article.json`（1 篇）
- 入口：本机 `next dev` → `POST /api/reviews`（浏览器点「开始审校」）
- 会话开关（不写入仓库默认）：`REVIEW_PROVIDER=deepseek`，`REVIEW_MODEL=deepseek-v4-flash`，`WEB_EVIDENCE_ENABLED=true`，`REVIEW_SPECIALISTS_ENABLED=1`
- 预算：Tavily ≤ 2 次查询；specialist ≤ 2 个

## 调用结果

| 项 | 观察值 |
| --- | --- |
| HTTP | `POST /api/reviews` **200**（Next 日志 2.3 min） |
| `review_id` | `2575a57e-9c59-47b1-b801-1cbd475b5f88` |
| Findings | 8 条，全部可定位；`dropped_count=0` |
| 主审校 provider | `deepseek` |
| 请求模型 | `deepseek-v4-flash` |
| **实际模型** | `deepseek-v4-flash`（`observed_response_model_status=observed`） |
| 主审校延迟 | `pipeline.provenance.latency_ms=114540`；总 `elapsed_ms=133710` |
| 主审校 attempts | 2：第 1 次 `retryable_failure`（响应非 JSON，output 8192 tokens）；第 2 次 `success` |
| Usage | input 3426 / output 15825 / cached 3328（均 `complete` / `reported`） |
| 成本 | **USD 0.010489**（`determined`，off-peak DeepSeek 计价；`2026-08-26T14:45:40Z`） |
| 应用缓存 | enabled，**miss** |
| Fallback | **未使用**（`used=false`, `mode=none`） |
| Web Evidence | 已启用；`query_count=2`；两次均为 live Tavily，`error_class=not_found`，文案「未能外部核验」 |
| Specialist | 已启用；派发 `fact_check` 1/2；`news_edit` 未派发（本轮无 consistency/citation finding）；`fact_check` **12.003s 失败**（`DeepSeek provider unavailable`，等于 12s 请求超时） |
| Specialist 成本 | **未观察到**（失败路径走 synthetic result，没有 usage） |

Tavily 查询（均 ≤ 8 字，不等于正文）：

1. `王强在总结时强调`（`person_title`）
2. `市教育委员会`（`organization_name`）

本地检索证据示例：政策 Finding 的 `https://www.moe.gov.cn/` 在 UI 中可点击，标注为 curated 官方来源，**不是** Tavily 已证实结论。网页证据面板两次均为「未能外部核验」，横幅写明「该状态不表示稿件没有问题」。

## 人工质量判断

Demo 稿预埋问题均被找出，且 span 与原文切片一致：

| 预埋问题 | 结果 |
| --- | --- |
| 「座谈谈会」 | 规则命中，Accept 后正文改为「座谈会」，version 1→2 |
| 上周四 vs 2026-08-12 星期三 | datetime Finding；无安全替换；Ignore 后标记消失 |
| 128 万 / 182 万 | 两条 number Finding，待人工核实 |
| 市教育委员会 vs 市教育局 | organization Finding，建议改为「市教育局」 |
| 纲要 2023 vs 2024 | policy Finding + curated `moe.gov.cn` |
| 王强 vs 王海涛 | person Finding，冲突建议，无自动替换 |
| 文末编辑批注 | 模型 `basic_text`；人工 Verify 后为待核实 |

判断：

- **可用**：规则 + 检索把高风险问题标出来了；Finding 可点回原文；无安全替换的项禁用 Accept。
- **未冒充已证实**：Tavily `not_found` 只显示「未能外部核验」；specialist 超时把相关项标成待核实，没有改成已证实。
- **质量缺口**：主模型第一次打满 8192 tokens 且非 JSON，导致总时长 133.7s（超过 Route `maxDuration=60`；`next dev` 仍返回 200，生产路径会有风险）。`fact_check` 在 12s 预算内失败，本轮没有专项核验增量。Tavily 对虚构人名/机构在白名单域名下未命中，符合预期，不能当成「外部已核验」。

## UI 验证

- **API**：上述 200 响应；随后 `PATCH` Accept / Ignore / Verify 均写入 SQLite（`review_actions` 3 行）。
- **桌面（1440×900）**：8 条 Finding 与正文高亮对应；点「疑似错别字」可定位；Accept / Ignore / Verify 均成功；政策「查看来源」指向 `https://www.moe.gov.cn/`。
- **移动端**：Chrome DevTools `emulate(..., mobile)` 会重建文档，审校页 React state 丢失，**未再次点击「开始审校」**（避免重复消耗 Tavily / specialist）。390×844 输入页可渲染。紧凑审校 sheet（展开/收起、从正文打开、筛选与操作）由现有 `tests/frontend/review-flow.test.tsx` compact 用例覆盖，本轮未在丢失 state 后重跑 live 审校页。

## 隐私与密钥

- 响应 JSON 中无 API key / `tvly-` / `sk-` 形态字符串。
- Tavily 请求体只有短 query，不是全文；`include_raw_content=false`。
- 原始响应保存在 gitignored `.data/e2e-quality-gate/`，不入库。

## 代码改动

- 产品路径整体 deadline 55s：超时 abort 主模型 / Tavily / specialist，返回 `rules_only` 与「未能外部核验」。不修改 official `DEEPSEEK_RETRY_POLICY`，不提高 `maxDuration`。
- specialist 成功 / 失败 / 超时都写入 `attempts`、observed model、usage；无法观察时 `trace_status=unobserved`。

未改 Product Freeze、评估门槛、official holdout、默认开关或技术栈。

## 本地 artifact

- `.data/e2e-quality-gate/review-response.json`（gitignore）
- `.data/e2e-quality-gate.db`
