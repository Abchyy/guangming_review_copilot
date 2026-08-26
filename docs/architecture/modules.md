# 架构与模块所有权

Guangming Review Copilot 以 **npm workspaces 模块化单仓库** 交付，**单体部署**，不拆微服务。唯一应用是 `apps/web`（Next.js 16.3.1 App Router）。

公共导入只走包入口：

```ts
import type { Finding } from "@grc/contracts";
import { createReview } from "@grc/review-core";
```

## 模块所有权

| 模块 | 目录 | 所有权范围 | 公共 API | 禁止 |
| --- | --- | --- | --- | --- |
| contracts | `packages/contracts` | schema、错误类型、MA-0 specialist 契约 | `Finding`、`CreateReviewResponse`、`SpecialistTask` 等 | 依赖业务包 |
| review-core | `packages/review-core` | canonicalize、fusion、rank、pipeline | `createReview`、`fuseFindings`、`rankFindings` | Next/React/SQLite/benchmark |
| rules-engine | `packages/rules-engine` | 规则加载与命中 | `runRules`、`getRuleVersion` | HTTP、最终 Finding 决策 |
| retrieval | `packages/retrieval` | 语料检索 | `Retriever`、`retrieveCorpus`、`RetrievedEvidence` | 直接决定 Finding、GraphRAG、外部向量库 |
| web-evidence | `packages/web-evidence` | 轻量联网核验：Query Policy、SearchProvider、离线 fake 与默认关闭的 Tavily live adapter | `SearchProvider`、`FakeSearchProvider`、`TavilySearchProvider`、`createWebEvidenceCollector`、`createWebEvidenceCollectorFromEnv`、`planWebEvidenceQueries` | RAG、向量库、前端、holdout、把 fake 标成 live |
| providers | `packages/providers` | 模型 adapter、prompt、cache、fallback 模式 | `ReviewModel`、`FixtureReviewModel`、`getFallbackMode` | 业务规则、排序、DB 写入 |
| review-store | `packages/review-store` | Accept/Ignore/Verify 状态机 + SQLite | `ReviewStore`、`canTransition`、`openReviewDatabase` | Next、benchmark |
| web | `apps/web` | UI、Route Handler 组合 | `/api/reviews` | 质量算法、holdout |
| benchmark | `packages/benchmark` | 开发评估 | `evaluateReview`、`loadBenchmarkDataset`、web-evidence-eval、agent-orchestration-eval | 污染 prompt/rules/corpus |
| holdout-protocol | `packages/holdout-protocol` | official freeze / fail-closed | freeze/inference/evaluation | 被产品运行时导入 |
| test-kit | `packages/test-kit` | 离线测试辅助 | 仅测试 | 产品依赖 |

## 依赖规则

- `contracts` → 无业务依赖
- `rules-engine` / `retrieval` / `providers` / `review-store` / `web-evidence` → `contracts`
- `review-core` → `contracts` + rules + retrieval + providers（可选 `WebEvidenceCollector` 接口；不得依赖 `@grc/web-evidence` 或具体搜索供应商）
- `web` → contracts + review-core + providers + review-store + web-evidence（仅 Route Handler；未同时配置 `WEB_EVIDENCE_ENABLED=true` 与 `TAVILY_API_KEY` 时不查询）
- `benchmark` 可消费公开产品接口
- 产品运行时 **不得** 依赖 `benchmark` 或 `holdout-protocol`
- `test-kit` 只能是根目录 `devDependency`

## Pipeline 组合

`createReview`：canonicalize → `runRules` → `retrieveCorpus` → provider（失败且 copilot 且有规则命中则 `rules_only` fallback）→ locate span → fuse → rank → 可选 Web Evidence。`specialists_enabled` 恒为 `false`。未注入 `webEvidenceCollector` 时不查询、不改变 Finding、不写 `pipeline.web_evidence`。

## RAG 边界

检索只返回带 source_id、URL、excerpt、authority、freshness/version 的 evidence。UI 展示这些字段。不引入 GraphRAG、外部向量数据库或新 embedding 依赖。

本阶段的 **Web Evidence 不是 RAG**：不扩容知识库、不建索引、不做 embedding、不把网页结果写入 corpus。它只对高风险、时效性强且不确定的最小事实发出查询，返回可追溯网页证据，供模型和人工判断。

## Web Evidence 边界（本阶段）

- 只允许人物职务、机构名称、政策法规、日期、数字、归因进入查询。
- 每篇稿件最多 2 个查询，每个查询最多 3 条结果。
- 查询必须是最小事实，不得发送整篇稿件、个人信息、内部批注、holdout 或 API key。
- 域名白名单按事实类别配置在 `DEFAULT_DOMAIN_ALLOWLIST`，不得写死在业务分支里。
- 未检索到、超时或 provider 失败时，状态为 `unverified`，文案固定为「未能外部核验」；不得表示「没有问题」。
- 唯一搜索适配入口是 `SearchProvider`。离线实现是 `FakeSearchProvider`（`provider_kind: fake_offline`，`live_network: false`）。真实实现是 `TavilySearchProvider`（`provider_kind: live`），仅服务端在 `WEB_EVIDENCE_ENABLED=true` 且配置了 `TAVILY_API_KEY` 时启用；否则不注入 collector、不查询、不改变 Finding、不写 `pipeline.web_evidence`。
- 向 Tavily 只发送白名单中的明确域名，不发送通配符。成功联网但无可用结果时保留 `provider_kind: live` 与 `live_network: true`。
- 不得把 fake 结果标成 live，不得获取网页全文，不得记录原始搜索响应。失败、超时或未命中时文案固定为「未能外部核验」。
- `review-core` 仍然只看到 `WebEvidenceCollector` 契约，不依赖 Tavily。
