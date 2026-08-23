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
| providers | `packages/providers` | 模型 adapter、prompt、cache、fallback 模式 | `ReviewModel`、`FixtureReviewModel`、`getFallbackMode` | 业务规则、排序、DB 写入 |
| review-store | `packages/review-store` | Accept/Ignore/Verify 状态机 + SQLite | `ReviewStore`、`canTransition`、`openReviewDatabase` | Next、benchmark |
| web | `apps/web` | UI、Route Handler 组合 | `/api/reviews` | 质量算法、holdout |
| benchmark | `packages/benchmark` | 开发评估 | `evaluateReview`、`loadBenchmarkDataset` | 污染 prompt/rules/corpus |
| holdout-protocol | `packages/holdout-protocol` | official freeze / fail-closed | freeze/inference/evaluation | 被产品运行时导入 |
| test-kit | `packages/test-kit` | 离线测试辅助 | 仅测试 | 产品依赖 |

## 依赖规则

- `contracts` → 无业务依赖
- `rules-engine` / `retrieval` / `providers` / `review-store` → `contracts`
- `review-core` → `contracts` + rules + retrieval + providers
- `web` → contracts + review-core + providers + review-store
- `benchmark` 可消费公开产品接口
- 产品运行时 **不得** 依赖 `benchmark` 或 `holdout-protocol`
- `test-kit` 只能是根目录 `devDependency`

## Pipeline 组合

`createReview`：canonicalize → `runRules` → `retrieveCorpus` → provider（失败且 copilot 且有规则命中则 `rules_only` fallback）→ locate span → fuse → rank。`specialists_enabled` 恒为 `false`。

## RAG 边界

检索只返回带 source_id、URL、excerpt、authority、freshness/version 的 evidence。UI 展示这些字段。不引入 GraphRAG、外部向量数据库或新 embedding 依赖。
