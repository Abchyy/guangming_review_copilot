# Guangming Review Copilot 模块化重构与未来多 Agent 技术路线

> 文档状态：Proposed / Engineering Roadmap
> 版本：v1.0
> 日期：2026-08-23
> 基线仓库：`guangming_review_copilot`
> 基线提交：`c514f77de1ffd8a583ff73ae8af626624cc32cfe`
> 适用对象：后续执行项目重构、功能开发、质量优化和多 Agent 实验的 Coding Agent 与工程人员

## 0. 文档定位

本文档定义 Guangming Review Copilot 从当前 Next.js 单体代码布局，演进为可并行开发的模块化单仓库的技术方案，并把 RAG 强化和多 Agent 机制纳入未来路线。

本文档是工程规划，不替代以下事实基线：

- `Guangming_Review_Copilot_Product_Freeze_v1.1.md`：产品范围和 P0/P1/P2 事实基线；
- `AGENTS.md`：项目级工程规则；
- `docs/benchmark-holdout.md`：正式 blind holdout 协议。

若本文档与 Product Freeze 冲突，以 Product Freeze 为准。多 Agent 被列为未来技术能力，不表示当前 Demo 立即改变产品规格，也不授权 Coding Agent 自行扩大产品范围。

## 1. 当前基线

截至基线提交，项目已经具备：

- Next.js 16 App Router、React、TypeScript；
- 标题和正文输入；
- Rules + Retrieval + LLM 审校管线；
- Finding 定位、风险分级、证据、排序；
- Accept / Ignore / Verify；
- Accept 后正文修改和 span rebase；
- SQLite 持久化；
- Fixture、DeepSeek、OpenAI provider adapter；
- 开发 benchmark、评估器和正式 blind holdout 协议；
- 类型检查、ESLint、Vitest 和生产构建入口。

基线验证结果：

- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm test`：23 个测试文件、179 项测试通过；
- `npm run build`：通过。

已知不应在重构中被掩盖的问题：

1. 移动端 P0 尚未实现；
2. 日期规则可能把政策名称中的年份误判为稿件事件年份；
3. 同一 Finding 的 reason、evidence 与 suggestion 可能在融合后语义不一致；
4. API provider 失败只有错误处理，没有产品级 fallback；
5. UI 没有完整展示 retrieved source 的名称、URL、时间与可信级别；
6. 本机已有的 official locked 结果显示质量仍有明显改进空间，尤其是 Evidence Coverage。

重构不得把上述问题误写成“已解决”。行为保持与问题修复必须在提交和验收中明确区分。

## 2. 重构目标

### 2.1 核心目标

1. 将共享契约、审校核心、规则、检索、模型、存储、benchmark 和 Web 解耦；
2. 允许多个开发工作流在低冲突条件下并行推进；
3. 用稳定公共接口代替跨目录深层 import；
4. 保留当前单体部署方式，不引入微服务运维负担；
5. 保留并强化 benchmark、provenance 和 holdout 的可信边界；
6. 为 RAG 扩展和未来受控多 Agent 执行预留明确接口；
7. 在每个迁移阶段保持可运行、可测试、可回退。

### 2.2 非目标

本轮模块化重构不自动包含：

- 微服务拆分；
- 多仓库拆分；
- Kubernetes、服务网格或消息队列；
- GraphRAG、知识图谱或大型向量数据库集群；
- 自由自治、多轮互聊式 Agent 群；
- 用户账号、CMS、多人协作等 Product Freeze 的 P2 能力；
- 替换 Next.js、SQLite、Vitest 或 npm 技术栈；
- 以重构为名重写已经工作的全部逻辑。

## 3. 核心架构决策

### ADR-001：采用模块化单仓库

使用 npm workspaces 管理：

```text
guangming_review_copilot/
├── apps/
│   └── web/
├── packages/
│   ├── contracts/
│   ├── review-core/
│   ├── rules-engine/
│   ├── retrieval/
│   ├── providers/
│   ├── review-store/
│   ├── benchmark/
│   ├── holdout-protocol/
│   └── test-kit/
├── data/
│   ├── demo/
│   ├── rules/
│   ├── corpus/
│   └── benchmark/
├── docs/
├── package.json
└── package-lock.json
```

初期不引入 Turborepo、Nx 等额外构建系统。只有在原生 npm workspace 脚本和 CI 明显不足时，才单独提出引入构建编排工具的决策。

### ADR-002：保持单体部署

`apps/web` 仍是唯一可部署 Next.js 应用。`packages/*` 是进程内模块，不是网络服务。

这样可以获得模块边界和并行开发能力，同时保留：

- 单一部署产物；
- 简单环境变量管理；
- 低延迟进程内调用；
- 当前 SQLite 运行方式；
- 黑客松和 Demo 场景所需的低复杂度。

### ADR-003：公共契约先行

任何跨模块调用必须通过 `@grc/*` 包的公开入口。禁止从另一个包的 `src/internal` 或具体文件进行深层 import。

允许：

```ts
import type { Finding } from "@grc/contracts";
import { createReviewPipeline } from "@grc/review-core";
```

禁止：

```ts
import { mergePair } from "../../review-core/src/internal/fusion";
```

### ADR-004：Source-first TypeScript 包

第一阶段各 workspace 包直接维护 TypeScript 源码，通过 `exports` 暴露唯一公共入口。Next.js 负责转译 Web 依赖的 workspace 包，Vitest 直接运行 TypeScript 测试。

实施时必须先阅读仓库当前版本 `node_modules/next/dist/docs/` 中与 workspace、`transpilePackages`、App Router 和 server-only 模块相关的文档，不得依据旧版 Next.js 经验修改配置。

如后续出现独立 CLI、发布包或构建性能问题，再评估每包独立编译，不在第一阶段提前引入。

### ADR-005：编排器确定性优先

无论单模型还是未来多 Agent，最终控制权属于确定性 orchestrator：

- 决定调用哪些能力；
- 注入预算、超时和版本；
- 校验结构化输出；
- 合并重复 Finding；
- 处理冲突；
- 应用风险规则；
- 记录 provenance；
- 决定是否允许自动替换。

模型或 Agent 不得直接写数据库、修改文章或生成最终发布结论。

## 4. 模块职责与边界

### 4.1 `@grc/contracts`

职责：

- Article、Finding、Evidence、Suggestion、Decision 等领域类型；
- Zod schema；
- schema version；
- 稳定错误码；
- provider、pipeline、provenance 公共结构；
- RAG 和未来 Agent 的跨模块任务协议。

不得依赖其他业务包。只允许依赖纯 schema/类型所需的最小第三方库。

建议公开：

```ts
export type CanonicalArticle = { /* ... */ };
export type Finding = { /* ... */ };
export type EvidenceItem = { /* ... */ };
export type ReviewRequest = { /* ... */ };
export type ReviewResult = { /* ... */ };
export type ExecutionProvenance = { /* ... */ };
```

### 4.2 `@grc/review-core`

职责：

- 审校 pipeline 编排；
- candidate materialization；
- evidence fusion；
- duplicate suppression；
- severity override；
- ranking；
- span 定位和结果校验；
- pipeline policy；
- fallback 决策接口。

不得包含：

- Next.js Request/Response；
- React；
- SQLite 具体实现；
- provider SDK client；
- 直接文件系统读取数据集；
- official holdout 生命周期逻辑。

建议公共接口：

```ts
export interface ReviewPipelineDependencies {
  rules: RuleEngine;
  retriever: Retriever;
  model: ReviewModel;
  clock: Clock;
  idGenerator: IdGenerator;
}

export interface ReviewPipeline {
  review(input: ReviewRequest, options?: ReviewOptions): Promise<ReviewResult>;
}
```

### 4.3 `@grc/rules-engine`

职责：

- 错别字、标点、格式规则；
- 日期与星期校验；
- 数字和文内一致性规则；
- 固定政策表述和 curated entity 规则；
- rule catalog 加载、校验和版本；
- 规则级证据生成。

日期规则必须把“事件年份推断”建模为显式输入或不确定值，不能从文章中任意第一个 `XXXX年` 推断。

建议接口：

```ts
export interface RuleContext {
  referenceDate?: string;
  locale: "zh-CN";
}

export interface RuleEngine {
  run(article: CanonicalArticle, context: RuleContext): RuleHit[];
}
```

### 4.4 `@grc/retrieval`

职责：

- corpus schema 和版本；
- query planning；
- lexical / BM25 / embedding 检索；
- source authority、freshness 和 scope 评分；
- evidence excerpt 定位；
- 检索缓存；
- 来源冲突表示。

不得直接创建最终 Finding，也不得把“检索到了”解释成“事实已证实”。

建议接口：

```ts
export interface RetrievalQuery {
  text: string;
  category?: "person" | "organization" | "policy" | "citation" | "fact";
  asOf?: string;
  topK: number;
}

export interface Retriever {
  search(query: RetrievalQuery): Promise<RetrievedEvidence[]>;
}
```

### 4.5 `@grc/providers`

职责：

- `ReviewModel` adapter；
- Fixture、DeepSeek、OpenAI 实现；
- 请求超时、重试和 provider response 解析；
- provider 实际 model / endpoint / usage / latency provenance；
- provider 能力和错误分类；
- 未来 specialist Agent 的模型执行适配。

不得包含业务规则、风险排序或数据库写入。

### 4.6 `@grc/review-store`

职责：

- Review、Article version、Finding、Decision 持久化；
- Accept / Ignore / Verify 状态机；
- action idempotency；
- optimistic concurrency；
- span rebase；
- SQLite adapter。

建议把领域状态机与 SQLite adapter 分开：

```text
review-store/
├── domain/
├── ports/
└── adapters/sqlite/
```

### 4.7 `@grc/benchmark`

职责：

- dev/regression 数据协议；
- evaluator；
- metric aggregation；
- baseline/candidate 对比；
- 误差分析报告；
- 非官方开发 benchmark。

不得被产品运行时依赖。

### 4.8 `@grc/holdout-protocol`

职责：

- workspace identity；
- System Freeze；
- Run Freeze；
- blind inference；
- sealed prediction；
- independent evaluation；
- lifecycle consumption；
- official provider binding。

该包是安全边界。日常产品开发不得随意修改。任何修改都必须运行完整协议测试，并重新说明对既有 freeze 兼容性的影响。

### 4.9 `@grc/test-kit`

职责：

- FixtureReviewModel；
- ScriptedReviewModel；
- test article / finding builder；
- 临时 SQLite helper；
- offline network guard；
- provider request probe；
- contract compatibility fixtures。

生产包不得依赖 `test-kit`。

### 4.10 `apps/web`

职责：

- Next.js App Router；
- API composition root；
- Desktop UI；
- Mobile UI；
- request validation 和 HTTP error mapping；
- 用户可见 loading、empty、error、fallback 状态。

API route 只负责组装依赖和协议转换，不得承载质量算法。

## 5. 依赖规则

目标依赖图：

```text
contracts
├── rules-engine
├── retrieval
├── providers
└── review-store

rules-engine ─┐
retrieval ────┼──> review-core ───> apps/web
providers ────┘          │
review-store ────────────┘

review-core + providers ───> benchmark ───> holdout-protocol
test-kit ───> 各模块测试（仅 devDependency）
```

强制规则：

1. `contracts` 不依赖业务模块；
2. `review-core` 不依赖 Web、SQLite 或 benchmark；
3. `apps/web` 不直接 import 模块内部文件；
4. 产品运行时不依赖 benchmark 或 holdout；
5. benchmark 可以消费公开产品接口，但不能反向污染 rules、corpus、prompt；
6. hidden gold 不得进入开发仓库、开发依赖或 Coding Agent 上下文；
7. 数据文件必须由对应模块 loader 读取，其他模块不得直接拼路径读取。

## 6. 审校 Pipeline 目标模型

将当前集中式 `createReview` 拆成可组合、可观测的阶段：

```text
1. NormalizeArticle
2. BuildExecutionContext
3. RunDeterministicRules
4. GenerateModelCandidates
5. PlanTargetedRetrieval
6. RetrieveEvidence
7. MaterializeAndValidateEvidence
8. LocateSourceSpans
9. FuseAndDeduplicate
10. ApplySeverityPolicy
11. RankFindings
12. ValidateFinalContract
13. PersistReview
```

每个阶段应满足：

- 输入输出有类型；
- 可单元测试；
- 可记录耗时和版本；
- 不依赖隐式全局状态；
- 不读取未声明的环境变量；
- 失败策略明确；
- 可在 benchmark 中单独关闭或替换。

推荐基础协议：

```ts
export interface PipelineStage<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

export interface ExecutionContext {
  reviewId: string;
  articleHash: string;
  referenceDate?: string;
  deadlineMs: number;
  budget: ExecutionBudget;
  trace: TraceRecorder;
}
```

## 7. RAG 技术路线

### 7.1 定位

RAG 是近期优先能力，用于提升 Evidence Coverage 和高风险问题的可核实性。它不替代规则，也不把模型生成内容包装成外部事实。

### 7.2 文档模型

建议权威语料记录：

```ts
export interface CorpusDocument {
  sourceId: string;
  sourceType: "official_policy" | "official_profile" | "official_notice" | "reference";
  publisher: string;
  title: string;
  url: string;
  publishedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  retrievedAt: string;
  authorityLevel: "primary" | "secondary" | "unverified";
  contentHash: string;
  chunks: CorpusChunk[];
}
```

### 7.3 检索阶段

按以下顺序演进：

1. 结构化 exact match 和关键词检索；
2. 中文 BM25 / lexical ranking；
3. 在 benchmark 证明有增益后增加 embedding 检索；
4. hybrid fusion 和 reranking；
5. 有明确需求后再评估在线权威来源 connector。

第一阶段不引入 GraphRAG。

### 7.4 Evidence gate

Retrieved evidence 进入 Finding 前必须验证：

- source ID 存在于受控 corpus；
- URL 来自 corpus，不能信任模型返回的 URL；
- excerpt 可在源 chunk 中定位；
- source authority 满足问题类型要求；
- as-of 时间与人物职务、政策版本相容；
- 同一事实存在冲突来源时，不生成安全自动替换；
- provenance 记录 retriever、index、corpus 和 reranker 版本。

### 7.5 RAG 验收指标

至少跟踪：

- retrieval recall@k；
- evidence precision；
- authoritative evidence coverage；
- citation validation rate；
- stale evidence rate；
- source conflict rate；
- RAG 对 Critical/High Recall、Precision、延迟和成本的增量影响。

## 8. 未来多 Agent 路线

### 8.1 基本原则

多 Agent 是未来受控实验能力，不是第一阶段重构依赖。引入条件是单 pipeline、规则和 RAG 已经形成稳定基线，并且误差分析证明专项模型调用有独立价值。

禁止直接引入：

- Agent 间自由聊天；
- Agent 自行创建新 Agent；
- Agent 直接访问数据库或写文章；
- Agent 绕过统一 schema 输出自然语言结论；
- 无预算、无超时、无 provenance 的递归调用；
- 以“多 Agent”名义重新包装同一个 prompt 的重复调用。

### 8.2 目标形态

```text
                         ┌─> Entity Specialist ──────┐
Article -> Router/Plan ──┼─> Policy Specialist ──────┤
                         ├─> Numeric Specialist ─────┼─> Deterministic Verifier
                         └─> Citation Specialist ────┘          │
                                                               v
                                                    Fusion / Severity / Rank
```

Orchestrator 决定是否调用 specialist；specialist 之间不直接通信。

### 8.3 候选 Specialist

#### Entity Specialist

- 人物姓名、身份、职务；
- 机构全称、简称和隶属关系；
- 必须优先消费权威人物/机构 RAG 证据。

#### Policy Specialist

- 政策名称、年份、版本；
- 固定表述；
- 政策有效期和新旧口径；
- 无权威依据时只能要求人工核实。

#### Numeric Consistency Specialist

- 文内数字冲突；
- 单位、比例、数量级；
- 可计算关系；
- 简单算术必须交给确定性工具验证。

#### Citation Specialist

- 引语归属；
- 引文与出处；
- 关键表述转述风险；
- 证据不足时不得推断发言人。

### 8.4 Agent 契约

建议在 `contracts` 中预留：

```ts
export interface SpecialistTask {
  taskId: string;
  specialist: "entity" | "policy" | "numeric" | "citation";
  article: CanonicalArticle;
  candidateSpans: SourceSpan[];
  retrievedEvidence: RetrievedEvidence[];
  constraints: {
    maxCandidates: number;
    deadlineMs: number;
    allowExternalRetrieval: boolean;
  };
}

export interface SpecialistResult {
  taskId: string;
  candidates: ReviewCandidate[];
  provenance: AgentExecutionProvenance;
  warnings: string[];
}
```

Agent 输出仍须经过：

1. schema parse；
2. span locate；
3. evidence validation；
4. deterministic conflict handling；
5. severity policy；
6. final contract parse。

### 8.5 Agent 路由

初期使用确定性路由，不使用 LLM 自由规划：

- 出现人物/职务候选时调用 Entity；
- 出现正式文件、政策名称时调用 Policy；
- 同一指标多次出现或包含比例/单位时调用 Numeric；
- 出现引号、发言人或出处时调用 Citation；
- 无目标 span、无合适证据或预算不足时不调用。

路由器必须支持：

- 每篇最大 specialist 数；
- 全局并发上限；
- 单 specialist 超时；
- token/cost 预算；
- 熔断；
- 缓存；
- provider 降级策略；
- shadow mode。

### 8.6 冲突策略

当不同 specialist 或规则产生冲突时：

1. 可验证硬规则优先于模型判断；
2. 权威且时间匹配的 retrieved source 优先于非权威来源；
3. internal context 只能证明文内矛盾，不能证明外部事实；
4. 两个同等级来源冲突时，Finding 状态设为 Verify；
5. 替换文本冲突时禁止自动 Accept；
6. reason、suggestion 和 evidence 必须经过一致性校验；
7. 不用“多数 Agent 同意”替代真实证据。

### 8.7 多 Agent 分阶段启用

#### MA-0：接口预留

- 建立 task/result/provenance contract；
- 产品运行时不调用 specialist；
- 不改变现有结果。

#### MA-1：Shadow Mode

- 对 dev 数据并行运行 specialist；
- 结果不进入用户 Finding；
- 记录增量 TP、FP、证据和成本；
- 与单 pipeline 基线对比。

#### MA-2：Gated Specialist

- 仅对明确类型和高风险候选调用；
- 只有通过 evidence gate 的结果进入 Finding；
- 保留 feature flag 和单 pipeline 回退。

#### MA-3：受控生产启用

- 通过 fresh hidden holdout；
- provider、prompt、agent graph、router、budget 全部进入 freeze；
- UI 可说明 Finding 来源于哪个专项验证，但不暴露内部思维链；
- 继续由人类做最终决定。

### 8.8 多 Agent 准入 Gate

进入 MA-2 前必须满足：

- 当前 P0 已完成；
- 无阻塞性 span / fusion / date 逻辑缺陷；
- 单 pipeline benchmark 可重复；
- RAG evidence gate 已稳定；
- Shadow Mode 在 dev/regression 上有明确增益；
- Critical/High Recall 提升达到预先批准的阈值；
- Precision 不发生不可接受下降；
- 延迟、成本和 FP burden 在预算内；
- 有可关闭的 feature flag；
- official holdout 协议能够冻结 agent graph 和 router。

阈值必须在实验前确定，不能看完结果后再修改成功标准。

## 9. 并行开发模型

### 9.1 可并行工作流

完成 contracts 和 workspace 骨架后，可建立：

| 工作流 | 主要模块 | 可独立交付内容 |
| --- | --- | --- |
| Mobile UX | `apps/web` | responsive、Bottom Sheet、mobile review |
| Desktop Productization | `apps/web` | filters、隐藏标注、Evidence UI、状态呈现 |
| Quality Core | `review-core` | fusion、severity、ranking、一致性 gate |
| Rules | `rules-engine` | 日期、数字、政策、基础文字规则 |
| RAG | `retrieval` | corpus、query、ranking、evidence validation |
| Providers | `providers` | DeepSeek、重试、超时、fallback、provenance |
| Persistence | `review-store` | 状态机、rebase、并发、历史基础 |
| Benchmark | `benchmark` | evaluator、dev 报告、误差分析 |
| Protocol | `holdout-protocol` | freeze 和 official path 安全维护 |
| Multi Agent R&D | `contracts` + 实验包 | shadow specialist，不进入主链路 |

### 9.2 所有权原则

- 每个工作流只修改自己的模块；
- `contracts` 由集成负责人维护；
- 修改公共契约前必须先提交 contract proposal；
- Demo 数据、rules catalog、corpus 不能被多个工作流同时无协调修改；
- benchmark evaluator 与 inference assets 分属不同审查边界；
- holdout gold 永远不进入开发工作树。

### 9.3 合并顺序

推荐：

```text
contracts -> 模块实现 -> contract tests -> apps/web integration
          -> benchmark integration -> holdout compatibility validation
```

并行不代表无序合并。公共契约先落地，各模块基于同一契约开发，最后通过集成 Gate。

## 10. 分阶段迁移计划

### Phase 0：建立重构安全网

目标：确认重构前行为和已知缺陷。

任务：

- 固定基线提交和验证结果；
- 为关键 API 响应建立 contract fixtures；
- 为 Demo happy path 建立端到端回归；
- 为日期年份误判和融合语义冲突增加失败测试；
- 为移动端增加当前失败的布局验收测试；
- 记录现有 dev/official benchmark artifact identity；
- 明确哪些测试是 characterization，哪些代表正确业务行为。

Gate：测试、lint、typecheck、build 均可重复运行。

### Phase 1：Workspace 与 Contracts

目标：建立最小 monorepo 骨架，不改变业务行为。

任务：

- 配置 npm workspaces；
- 创建 `apps/web` 和 `packages/contracts`；
- 迁移公共 schema 和类型；
- 配置 TypeScript paths、Next workspace transpilation、Vitest alias；
- 增加禁止深层 import 的 lint 约束；
- 保持现有页面、API 和测试通过。

Gate：HTTP contract 与基线一致；无重复定义的 Finding schema。

### Phase 2：抽离基础模块

目标：抽离低耦合能力。

可并行迁移：

- `rules-engine`；
- `retrieval`；
- `providers`；
- `review-store`；
- `test-kit`。

Gate：每个包有公开入口、独立单测、无循环依赖。

### Phase 3：拆分 Review Core

目标：把集中式 review service 变成分阶段 pipeline。

任务：

- 建立依赖注入 composition；
- 将 rule、retrieval、model、fusion、severity、ranking 拆为 stage；
- 添加 stage timing 和 version provenance；
- 修复日期上下文和融合一致性问题；
- 对比重构前后的 fixtures 与 benchmark。

Gate：除明确修复项外，输出 contract 和排序行为保持可解释的一致性。

### Phase 4：迁移 Web 与完成 P0/P1

目标：让产品开发与质量开发真正解耦。

并行任务：

- Mobile Bottom Sheet；
- Desktop filters 和纯阅读模式；
- 完整 retrieved evidence UI；
- loading、error、empty、fallback 状态；
- API composition root；
- 可选的 review summary 和历史入口。

Gate：Product Freeze 的全部 P0 可演示。

### Phase 5：RAG 强化

目标：提高权威证据覆盖和高风险审校质量。

任务：

- 规范 corpus document schema；
- 建立 source authority/freshness；
- query planner；
- lexical/BM25；
- evidence gate；
- UI 来源呈现；
- RAG 离线评测。

Gate：预注册指标达到目标，且 Evidence Coverage、Precision、延迟没有不可接受退化。

### Phase 6：Benchmark 与协议模块化

目标：隔离开发评测和 official protocol。

任务：

- 抽离 evaluator；
- 抽离 holdout protocol；
- 重新冻结资产路径；
- 验证 workspace identity；
- 保持 dirty、cwd、provider/account、artifact tamper 的 fail-closed 测试。

Gate：所有协议测试通过；旧 artifact 的兼容性被明确说明，不能默认继续有效。

### Phase 7：多 Agent Shadow 实验

目标：验证专项 Agent 是否值得进入产品链路。

任务：

- 建立 agent contract；
- 实现确定性 router；
- 先实现 1 个最高价值 specialist；
- shadow execution；
- 增量指标和成本报告；
- 失败/超时不影响主流程；
- 决定继续、调整或删除实验。

Gate：没有预注册 benchmark 增益时，不进入 MA-2。

## 11. 当前文件迁移映射

建议映射：

| 当前路径 | 目标模块 |
| --- | --- |
| `src/lib/contracts/review.ts` | `packages/contracts` |
| `src/lib/server/review-service.ts` | `packages/review-core` |
| `src/lib/server/quality/rules.ts` | `packages/rules-engine` |
| `src/lib/server/quality/retrieval.ts` | `packages/retrieval` |
| `src/lib/server/quality/evidence.ts` | `review-core` / `retrieval`，按职责拆分 |
| `src/lib/server/quality/fusion.ts` | `packages/review-core` |
| `src/lib/server/quality/severity.ts` | `packages/review-core` |
| `src/lib/server/quality/ranking.ts` | `packages/review-core` |
| `src/lib/server/llm/*` | `packages/providers` |
| `src/lib/server/review-store.ts` | `packages/review-store` |
| `src/lib/server/span-rebase.ts` | `packages/review-store` 或独立 domain 子模块 |
| `src/lib/server/benchmark/evaluate.ts` | `packages/benchmark` |
| `src/lib/server/benchmark/holdout/*` | `packages/holdout-protocol` |
| `tests/helpers/*` | `packages/test-kit` |
| `src/components`、`src/app` | `apps/web` |

迁移时使用 `git mv` 或等价的可追踪移动，避免把纯移动与逻辑重写混在同一提交中。

## 12. 测试与验证策略

### 12.1 分层测试

1. Contract tests：schema、版本和兼容性；
2. Module unit tests：各包纯逻辑；
3. Adapter tests：SQLite、provider、corpus loader；
4. Pipeline integration tests：完整 review pipeline；
5. API tests：HTTP contract；
6. UI tests：Desktop 和 Mobile 工作流；
7. Dev benchmark：质量诊断；
8. Holdout protocol tests：安全边界；
9. Live smoke：显式 opt-in；
10. Official locked：外部 hidden gold、一次性消费。

### 12.2 建议脚本

```text
npm run typecheck
npm run lint
npm test
npm run test:contracts
npm run test:core
npm run test:rules
npm run test:retrieval
npm run test:providers
npm run test:store
npm run test:web
npm run test:benchmark
npm run test:protocol
npm run build
```

不要求第一天建立全部脚本，应随模块迁移逐步加入，并保持根目录 `npm test` 覆盖全部离线测试。

### 12.3 质量回归报告

每次影响 inference assets 的变更至少记录：

- Git commit；
- prompt/rule/corpus/schema/retriever/agent graph 版本；
- 数据 split；
- provider 和实际 model；
- cache 状态；
- Recall、Critical/High Recall、Precision、FP/article；
- Evidence Coverage、exact span、top-5 recall、NDCG；
- latency、tokens、cost；
- 逐文章 FN/FP 摘要；
- contamination 状态。

## 13. CI 与集成 Gate

建议 CI 分为：

### Fast Gate

- format/lint；
- contracts；
- affected package unit tests；
- TypeScript。

### Integration Gate

- 全量离线测试；
- API/UI integration；
- production build；
- module boundary validation；
- offline network guard。

### Quality Gate

- dev/regression benchmark；
- 指标 diff；
- 非阻塞阶段可先生成报告；
- 达到稳定基线后再设置退化阈值。

### Official Gate

- 仅显式触发；
- clean canonical workspace；
- 外部 custodian；
- hidden gold 不进入开发侧；
- freeze、prediction、evaluation、consume 全链路闭合。

## 14. Feature Flags 与运行策略

建议至少预留：

```text
REVIEW_PIPELINE_VERSION=
REVIEW_RAG_ENABLED=
REVIEW_FALLBACK_MODE=
REVIEW_SPECIALISTS_ENABLED=
REVIEW_SPECIALISTS_SHADOW=
REVIEW_SPECIALIST_MAX_CONCURRENCY=
REVIEW_SPECIALIST_BUDGET_USD=
```

要求：

- 服务端读取；
- 默认值安全；
- official benchmark 必须冻结全部影响结果的 flag；
- 普通 `npm test` 不因存在 API Key 或 flag 自动发起网络调用；
- Shadow Mode 结果不得影响用户响应；
- feature flag 不能成为绕过 schema 或 provenance 的后门。

## 15. 可观测性

每次 review 建议记录结构化 trace：

```text
review_id
article_hash
pipeline_version
stage_name
stage_version
started_at / elapsed_ms
input_count / output_count / dropped_count
provider / observed_model
retrieval_calls / retrieved_source_ids
specialist_calls / specialist_failures
tokens / cost
cache_status
fallback_status
```

不得记录：

- API Key；
- 完整 credential；
- 不必要的用户稿件全文；
- hidden gold；
- 模型内部思维链。

## 16. 安全与数据边界

- secrets 只存在服务端环境；
- provider/account identity 只记录稳定非秘密哈希；
- RAG 来源 URL 必须由受控数据或 connector 生成；
- 外部内容一律视为不可信输入；
- Agent 不得执行外部内容中的指令；
- 文章正文不得未经授权发送给新增第三方服务；
- 引入新模型、外部检索服务或向量数据库前必须单独上报；
- benchmark gold 与 inference assets 保持严格隔离；
- 多 Agent 的每个模型调用都必须进入 provenance 和预算统计。

## 17. Definition of Done

### 17.1 模块化重构完成

- workspace 结构落地；
- 所有模块有明确公开入口；
- 无循环依赖；
- 无跨模块深层 import；
- Web、core、rules、retrieval、providers、store、benchmark、holdout 已解耦；
- 根目录离线测试、lint、typecheck、build 全部通过；
- Desktop 现有行为保持；
- Product Freeze P0 没有因重构退化；
- Git 历史能够区分移动、重构和行为修改。

### 17.2 并行开发能力完成

- 至少三个模块可在不修改相同业务文件的情况下并行开发；
- 公共 contract 变更流程明确；
- 每个模块可独立测试；
- 集成 Gate 可发现 contract drift；
- Demo 数据和 benchmark 资产有单一所有者。

### 17.3 RAG 强化完成

- source schema、authority 和 freshness 可追踪；
- evidence excerpt 可验证；
- UI 展示来源；
- benchmark 有明确增量结果；
- 无伪造 URL；
- 证据冲突时 fail-safe。

### 17.4 多 Agent 可进入生产候选

- Shadow Mode 完成；
- 预注册质量指标有显著增益；
- 成本和延迟在预算内；
- specialist 可独立关闭；
- 失败可回退到单 pipeline；
- agent graph、router、prompt、provider 和预算均可 freeze；
- fresh hidden holdout 通过；
- 用户仍保留最终 Accept / Ignore / Verify 决策权。

## 18. Coding Agent 执行规则

未来 Coding Agent 基于本文档执行重构时必须：

1. 先阅读 `AGENTS.md`、Product Freeze、本文档和相关 Next.js 本地文档；
2. 检查当前工作树，保护用户已有修改；
3. 一次只执行一个 Phase 或一个明确模块；
4. 在修改前声明范围、公共契约变化和验收命令；
5. 不借机改变产品规格、技术栈或数据模型；
6. 不在同一提交中混合大规模移动与行为重写；
7. 每个阶段都实际运行约定测试；
8. 未运行的验证不得声称通过；
9. 发现安全、隐私、benchmark leakage 或核心架构冲突时停止并上报；
10. 未获得明确授权时，不启用生产多 Agent、不新增外部服务、不创建 fresh official holdout；
11. 完成后报告修改、验证、验收、风险和 Git 状态。

建议任务 Prompt 模板：

```text
请依据 TECHNICAL_REFACTOR_ROADMAP.md 执行 Phase X / 模块 Y。

范围：...
禁止修改：...
允许的公共契约变化：...
必须运行：...
验收条件：...
是否允许提交：...
```

## 19. 主要风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 大规模移动造成难审 diff | 先纯移动，再单独修改逻辑 |
| workspace 配置破坏 Next build | 先读当前版本本地文档，Phase 1 单独验收 |
| 公共契约频繁变化阻塞并行 | contracts owner + versioned schema + proposal |
| 模块拆分形成循环依赖 | 自动依赖边界检查，core 使用 ports |
| RAG 增加伪证据 | corpus-owned URL + excerpt validation + authority gate |
| 多 Agent 增加 FP | shadow mode + evidence gate + deterministic fusion |
| 多 Agent 延迟失控 | router、并发、deadline、budget、熔断 |
| Agent 结果互相矛盾 | 禁止自由互聊，统一冲突策略，安全替换 gate |
| benchmark 被开发污染 | dev/regression/locked 角色隔离，external custodian |
| 重构期间 P0 停滞 | Phase 1 后立即允许 Mobile 与 Quality 并行 |
| 为模块化引入过度工程 | 保持单体部署，不引入微服务和额外平台 |

## 20. 推荐决策顺序

1. 批准模块化单仓库方向；
2. 执行 Phase 0，补足重构安全网；
3. 执行 Phase 1，建立 workspace 和 contracts；
4. 并行执行 Phase 2 的基础模块迁移；
5. 完成 review-core pipeline；
6. 并行完成 Mobile P0、Desktop Productization 和质量修复；
7. 强化 RAG 和 Evidence Coverage；
8. 稳定单 pipeline benchmark；
9. 开启多 Agent Shadow Mode；
10. 仅在 benchmark 证明收益后申请进入受控生产链路。

最终原则：

> 模块化是为了让开发并行；RAG 是为了让结论可核实；多 Agent 只有在可测量地提高高风险审校质量时才值得进入产品主链路。所有智能能力最终都必须服从统一契约、确定性验证、可信证据和人工决策。

---

## 执行状态（2026-08-23）

本文档原始规划保留如上。本轮已在工作树落地的范围：

- Phase 0–4、Phase 6：npm workspaces、`apps/web`、`packages/{contracts,review-core,rules-engine,retrieval,providers,review-store,benchmark,holdout-protocol,test-kit}`
- MA-0：task/result/provenance 契约已按 specialist、candidate spans、retrieved evidence、constraints、warnings 预留
- 多 Agent 运行时：`createReview` 经可选 `SpecialistRuntime` 接入；默认关闭，仅 `REVIEW_SPECIALISTS_ENABLED=1` 时由 Route Handler 注入 DeepSeek-V4-flash `fact_check` / `news_edit`
- 行为修复：政策名年份不再误当事件年；fusion 仅合并 evidence 并整组保留 winner 语义；移动端正文标记会展开 bottom sheet；阅读模式；风险/类型筛选；带 authority 与可点击 URL 的 retrieved evidence UI；产品 provider 失败时 rules_only 降级（不用 fixture 冒充真实稿件结果），official locked 路径拒绝任何 fallback
- 测试辅助统一从 `@grc/test-kit` 公共入口导入，不再保留 `tests/helpers` 副本
- 旧 System Freeze artifact **不兼容** 新 `packages/**` 路径，需重新 freeze
