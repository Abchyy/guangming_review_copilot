# Guangming Review Copilot / 光明审校 Copilot

面向严肃媒体责任编辑的轻量化 AI 审校工具。产品方向见仓库根目录 `Guangming_Review_Copilot_Product_Freeze_v1.1.md`（已冻结，请勿修改）。

## 技术基线

- Next.js 16.3.1 + React 19.2.8 + TypeScript 5.9.3
- 单体 App Router + SQLite（better-sqlite3）
- 依赖版本由 `package.json` 精确固定，并由 `package-lock.json` 锁定

## 本地运行

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。页面预填 Demo 稿件，点击「开始审校」，然后 Accept / Ignore / Verify。

默认 `REVIEW_PROVIDER=fixture`。SQLite 默认写到 `.data/guangming-review.db`，该目录已 gitignore。

模型名称只通过服务端环境变量 `REVIEW_MODEL` 配置。

## 校验

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## 测试入口

三类执行入口彼此隔离。环境中即使已有 DeepSeek / OpenAI API Key，也不会让普通测试去调用外部模型。

```bash
# 平时本地测试：离线、零外部模型调用
npm test

# 主动跑 dev-live 诊断（显式 opt-in；结果不是正式 locked quality）
npm run test:dev-live

# 正式 locked 入口（显式 opt-in）。当前仓库没有 hidden gold，会 fail-closed
npm run test:locked

# 本地验证 holdout 协议基础设施（非正式分数）
npm run holdout:dry-run

# 检查仓库外 custodian 连接；只读取 lifecycle 安全元数据
cp config/holdout.env.example .env.holdout.local
# 编辑 .env.holdout.local 中的绝对路径后执行
npm run holdout:status
```

`npm run test:live-smoke` 同样是显式 opt-in 的诊断入口，不属于平时本地测试，也不冒充 locked 结果。

数据集角色、inference freeze、blind inference 与 hidden gold 评测分离，见 `docs/benchmark-holdout.md`。

`.env.holdout.local` 只保存在本机并由 Git 忽略。`holdout:status` 不读取 input 正文、gold、adjudication 或 evidence snapshots，也不会改变 lifecycle。状态为 `consumed` 的 holdout 只可作为历史审计或 regression 资产。

## 仓库结构

当前是 **npm workspaces 单体仓库**，唯一可部署应用是 `apps/web`（Next.js 16.3.1 App Router）。业务能力在 `packages/*`，通过公共入口导入，例如：

```ts
import type { Finding } from "@grc/contracts";
import { createReview } from "@grc/review-core";
```

禁止 `import ... from "@grc/*/src/..."`。

| 包 | 职责 | 禁止依赖 |
| --- | --- | --- |
| `@grc/contracts` | 请求/响应/Finding/Evidence/Specialist 契约 | 任何业务包 |
| `@grc/review-core` | 规范化、融合、排序、pipeline | Next、React、SQLite、benchmark |
| `@grc/rules-engine` | 规则目录与确定性规则 | Next、review-core、holdout |
| `@grc/retrieval` | Retriever / 语料检索 | Next、review-core、向量库 |
| `@grc/providers` | Fixture / DeepSeek / OpenAI adapter | 业务规则、DB 写入、holdout |
| `@grc/review-store` | 状态机 + SQLite adapter | Next、review-core、benchmark |
| `@grc/benchmark` | 开发集评估器 | 不得反向写入 prompt/rules/corpus |
| `@grc/holdout-protocol` | official freeze / fail-closed 协议 | 产品运行时不得依赖 |
| `@grc/test-kit` | 离线测试辅助 | 仅 devDependency |
| `@grc/web` | UI 与 Route Handler 组合 | benchmark / holdout / test-kit |

`data/` 与 `docs/` 留在仓库根目录。

## 单模块测试

```bash
npm run test:contracts
npm run test:core
npm run test:rules
npm run test:retrieval
npm run test:providers
npm run test:store
npm run test:web
npm run test:benchmark
npm run test:protocol
```

根目录 `npm test` 仍覆盖全部离线测试。普通测试必须离线，即使环境里有 API Key。

## 如何扩展

- **新增 rule**：在 `data/rules/catalog.json` 增加条目，于 `packages/rules-engine` 实现匹配逻辑，补 `npm run test:rules`。
- **新增 retriever**：实现 `Retriever`（`retrieve(query: RetrievalQuery): RetrievedEvidence[]`），在 pipeline 中显式注入；不要在 retrieval 包里直接产出最终 Finding。
- **新增 provider**：实现 `ReviewModel`，只负责模型 I/O 与 provenance，不写规则/排序/数据库。
- **新增 specialist（默认不启用）**：只实现 `Specialist` / `SpecialistTask` / `SpecialistResult` 契约。`pipeline.specialists_enabled` 必须保持 `false`，产品运行时不得调用 specialist。

## 哪些改动会使 benchmark freeze 失效

System Freeze 绑定 `packages/**` 与 `data/rules`、`data/corpus`、`package-lock.json` 的内容哈希。移动这些路径、修改 prompt/rules/corpus/fusion/evaluator、或改 provider 绑定，都会让**旧 System Freeze artifact 失效**。旧 freeze **不会**自动兼容新目录，也不得篡改旧 artifact。请用新结构重新 freeze。
