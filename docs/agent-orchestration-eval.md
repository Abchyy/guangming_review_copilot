# 多 Agent 编排开发评估协议

本文件定义未来「多 Agent 编排（Orchestrator + Specialist）」在**开发阶段**的评估协议、公开/合成样例的数据角色、可人工复核指标，以及开发通过门槛。

它不是产品运行时规格，不是 `@grc/contracts` 里 MA-0 specialist TypeScript 接口的替代，也不是 official holdout 协议。

配套资产：

- 样例与门槛：`packages/benchmark/src/agent-orchestration-eval/dataset.json`
- 离线 schema / 评分器：`packages/benchmark` 的 `agent-orchestration-eval` 导出

## 1. 目的与非目的

### 目的

为尚未接入产品运行时的多 Agent 编排，提供一份可版本化的开发评估合同，覆盖：

- 任务派发：哪些 span 应调用哪类 specialist，哪些不应调用；
- 并行预算：每篇最大 specialist 数与峰值并发；
- 超时与失败降级：超时 / provider 失败时不得把结果写入 Finding；
- 结果可追溯：每次真实调用都有 task id，成功结果有 locator 与 excerpt；
- 重复任务抑制：同一篇文章、同一 specialist、同一 span 不得再包一层模型调用；
- 额外模型调用成本上限：每篇额外调用次数与 token 不得超过预算。

让后续自动化测试可以对照 recorded traces 离线计分。

### 非目的

- 不替代 `docs/benchmark-holdout.md` 中的 official freeze / blind inference / hidden gold。
- 不读取、不复制、不近似外部 holdout 的隐藏 gold。
- 不创建、不运行 official System Freeze / Run Freeze。
- 不把 specialist 接入 `createReview` 主链路，也不要求本仓库已有编排实现。
- 不在本协议下联网，不调用外部模型。评分只读本地 dataset 与调用方提供的 traces。
- 本仓库中的分数不得写成 official locked 泛化证据。

## 2. 与 official holdout 的区分

| 项目 | 本协议（开发评估） | Official holdout |
| --- | --- | --- |
| 数据角色 | `agent_orchestration_dev` | `locked`（仓库外 custodian） |
| 样例来源 | 公开知识、合成稿、人工编写 | 外部 hidden gold |
| 存放位置 | 开发仓库 `packages/benchmark/src/agent-orchestration-eval/` | `HOLDOUT_CUSTODIAN_HOME`，不在本 repo |
| 是否可进 Agent 上下文 | 可以（开发诊断） | 不可以 |
| 是否需要 freeze | 否 | 是，两阶段官方冻结 |
| 是否联网 / 调模型 | 否 | 正式 inference 按 holdout 协议 |
| 分数含义 | 开发诊断 / 回归夹具 | 仅当 holdout 仍为 `available` 且协议闭合 |
| 污染后的处理 | 可迭代替换开发样例 | 记为 `consumed`，不得再当 fresh locked |

`data/benchmark/dataset.json` 的 `dev` / `regression` 审校样例、以及任何 `lock-*` 条目，都**不是**本协议的 gold。本协议样例 ID 以 `ao-dev-` 为前缀，文章 ID 以 `ao-dev-art-` 为前缀。

未来若要对多 Agent 编排做正式泛化评测，必须另建仓库外 hidden holdout，并走 `docs/benchmark-holdout.md`。不得把本开发集分数改名为 locked 分数。

## 3. 评估对象与解耦边界

评估对象是「对一篇合成稿的候选 span，编排器是否派发 specialist、并行与成本是否越界、失败如何降级、结果能否追溯、重复任务是否被抑制」这一行为，而不是某一版 TypeScript 函数名。

为保持与未定实现解耦：

- gold 与 traces 都是 JSON 合同，字段用稳定字符串枚举，不用产品包的 class / interface。
- specialist 与规划中的运行时一致，只有 `fact_check` 与 `news_edit`。本包不 import `@grc/contracts`，也不把编排接入产品主链路。
- `entity` / `policy` / `numeric` / `citation` 只作为 `trigger_kind`（审校维度），不能再作为 Specialist。
- 证据定位符使用 `locator` 字符串。开发夹具使用 `fixture://...`。评分器只检查 locator / excerpt / task id 是否可追溯，不发起 HTTP。
- traces 由未来实现或人工记录后**注入评分器**。本包不 import、不调用 `packages/review-core`、`packages/providers` 或任何编排 runtime。
- 不得为了迁就本协议去改 `apps/**`、产品 pipeline 或把 `specialists_enabled` 打开。

## 4. 样例合同

每个 case 至少包含：

| 字段 | 含义 |
| --- | --- |
| `case_id` | 稳定 ID |
| `article_id` | 用于并行预算与成本聚合 |
| `specialist` | 仅 `fact_check` 或 `news_edit` |
| `trigger_kind` | 派发触发 / 审校维度。`entity` / `policy` / `numeric` / `citation` 只出现在这里 |
| `candidate_span` | 候选片段 |
| `should_dispatch` | 应否派发该 specialist |
| `dispatch_priority` | 同一篇文章内的派发优先级，数字越小越优先。预算不足时应放弃低优先级任务 |
| `expected_status` | `not_invoked` / `succeeded` / `failed` / `timed_out` |
| `expected_failure` | 开发夹具中的失败模式；有该字段时不得进入 Finding |
| `duplicate_of` | 若非空，本条是对 canonical case 的重复任务，应被抑制 |
| `expected_enters_findings` | 成功结果是否允许作为候选 Finding |
| `fixture_evidence` | 离线夹具证据，不代表一次真实模型调用 |

`should_dispatch = false` 的 case，期望状态必须是 `not_invoked`，且不得进入 Finding。

## 5. 派发规则（确定性路由，不是自由规划）

两个 Specialist：

| `specialist` | 通常应派发 | 通常不应派发 |
| --- | --- | --- |
| `fact_check` | 可核验事实：人物职务、机构名称、政策文件、数字冲突、引语出处 | 口头尊称、口号、约数、本报评论员观点、无证据的生造对象 |
| `news_edit` | 需要编辑判断的问题：新闻语体、导语/正文口径、引语改写 | 纯事实核验、`basic_text`、语句已经通顺的叙述 |

`fact_check` 内部的审校维度用 `trigger_kind` 表示，而不是再拆成四个 Specialist。`basic_text`（错别字、标点、的/地/得）必须交给确定性规则引擎，**不得**派发 `news_edit` 或 `fact_check`，也不得作为 specialist 的成功、失败或预算样例。

| `trigger_kind` | 含义 | 归属 |
| --- | --- | --- |
| `entity` | 人物职务、机构名称 | `fact_check` |
| `policy` | 具名法规、办法、预案、规划 | `fact_check` |
| `numeric` | 文内数字冲突、单位 / 比例 / 可计算关系 | `fact_check` |
| `citation` | 引号、具名发言人或出处核验 | `fact_check` |
| `wording` | 口语化等需要编辑判断的新闻语体 | `news_edit` |
| `consistency` | 导语与正文口径、叙述框架冲突 | `news_edit` |
| `basic_text` | 标点、的/地/得等基础文字 | **规则引擎**，不派发 Specialist |
| `none` | 无目标 span | 不派发 |

路由器必须支持：无目标 span、无合适证据或预算不足时不调用。禁止 Agent 间自由聊天、自行创建新 Agent，或以「多 Agent」名义把同一个 prompt 再调用一次。禁止把 `entity` / `policy` / `numeric` / `citation` 再注册成 Specialist。

## 6. 编排预算

默认开发预算（写入 dataset，随版本变更）：

- 每篇文章最多 2 个 specialist；
- 峰值并发最多 2 个调用；
- 每篇文章最多 2 次额外模型调用；
- 每篇文章最多 4000 额外 token；
- 单个 specialist 超时 2000ms。

超出预算时应放弃低优先级任务，而不是超预算换召回。超时或失败的调用仍计入额外模型成本，但不得把结果写入 Finding。

## 7. 指标（可人工复核）

六项指标均可在不运行模型的前提下，对照 traces 与 gold 人工勾选。评分器只是把同一规则写成确定性函数。

### 7.1 任务派发准确性 `dispatch_accuracy`

对每个 case：

- TP：应派发且实际派发
- TN：不应派发且未派发
- FP：不应派发却派发
- FN：应派发却未派发

\[
\text{dispatch\_accuracy} = \frac{TP + TN}{N}
\]

人工复核：打开 case 的 `should_dispatch` 与 trace 的 `dispatched`。因预算放弃的低优先级任务记为 FN，同时在并行预算与成本指标中可以仍为合规。这是有意拆分：预算遵守不等于派发召回。

### 7.2 并行预算遵守率 `parallel_budget_compliance_rate`

按 `article_id` 聚合。若该文实际派发的 specialist 数 ≤ `max_specialists_per_article`，且 traces 记录的 `observed_parallel` 峰值 ≤ `max_parallel_invocations`，则该文合规。

\[
\text{parallel\_budget\_compliance\_rate} = \frac{\text{合规文章数}}{\text{文章数}}
\]

人工复核：按文章清点并行 specialist 数，不要把串行超员伪装成「并发为 1 所以合规」——超员会在 specialist 计数上失败。

### 7.3 失败降级正确率 `failure_degradation_correctness`

降级机会包括：

- gold 标注了 `expected_failure` 的 case；
- trace 记录了 `failure`，或状态为 `failed` / `timed_out`；
- 已派发且 `elapsed_ms` 超过 `specialist_deadline_ms`。

正确降级：不得 `entered_findings`，不得把状态写成 `succeeded`。对超时 gold，状态必须是 `timed_out`；对 provider 失败 gold，状态必须是 `failed`。

\[
\text{failure\_degradation\_correctness} = \frac{\text{正确降级数}}{\text{降级机会数}}
\]

分母为 0 时记为 `1`。本开发集包含超时与 provider 失败两类样例，分母不应为 0。

### 7.4 结果可追溯率 `result_traceability_rate`

只统计已派发的 traces：

- 必须有非空 `task_id`，且 `specialist` 与 gold 一致；
- 状态为 `succeeded` 时，还须同时具备非空 `result_locator` 与非空 `result_excerpt`。

\[
\text{result\_traceability\_rate} = \frac{\text{可追溯派发}}{\text{已派发数}}
\]

分母为 0 时记为 `1`。开发夹具的 `fixture://` locator 视为可追溯，前提是 excerpt 非空。本协议**不联网**验证 locator 是否可访问。

### 7.5 重复任务抑制率 `duplicate_suppression_rate`

gold 中 `duplicate_of` 非空的 case 必须同时满足：

- 未独立派发；
- `suppressed_as_duplicate = true`；
- `extra_model_calls = 0`；
- 状态为 `not_invoked`。

\[
\text{duplicate\_suppression\_rate} = \frac{\text{正确抑制数}}{\text{重复任务数}}
\]

分母为 0 时记为 `1`。本开发集包含至少一条重复引语，分母不应为 0。

### 7.6 额外模型调用成本合规率 `extra_model_cost_compliance_rate`

按 `article_id` 聚合。若该文 `extra_model_calls` 之和 ≤ `max_extra_model_calls_per_article`，且 `extra_tokens` 之和 ≤ `max_extra_tokens_per_article`，则该文合规。

\[
\text{extra\_model\_cost\_compliance\_rate} = \frac{\text{合规文章数}}{\text{文章数}}
\]

人工复核：被抑制的重复任务不得再计一次额外调用。超时 / 失败的真实调用仍计成本。

## 8. 开发通过门槛

以下门槛用于未来开发迭代的**门禁定义**。本任务只定义门槛，**不声称任何产品实现已经通过**。

没有 traces 的评分结果必须是 `run_status: "not_run"`。此时 `all_gates_passed` 为 `null`，不得把「未跑」写成「通过」。

对评分器自身的单元夹具，必须标注 `result_class: "protocol_self_check"`，不能冒充 `dev_system_run`。

| 指标 | 门槛 | 性质 |
| --- | --- | --- |
| 任务派发准确性 | ≥ 0.85 | 开发软门禁 |
| 并行预算遵守率 | = 1.00 | 硬门禁 |
| 失败降级正确率 | = 1.00 | 硬门禁 |
| 结果可追溯率 | ≥ 0.90 | 开发软门禁 |
| 重复任务抑制率 | = 1.00 | 硬门禁 |
| 额外模型调用成本合规率 | = 1.00 | 硬门禁 |

附加 fail-closed 条件：

- traces 必须一一覆盖 dataset 中的全部 `case_id`，否则 `coverage_complete = false`，`all_gates_passed = false`；
- `official_holdout` 必须为 false；
- 不得输出 `may_claim_official_locked_generalization: true`。

## 9. 运行方式

本协议的可执行部分全部离线：

```bash
# 校验样例合同、覆盖面和评分器（不联网，不跑 official freeze）
npx vitest run tests/benchmark/agent-orchestration-eval.test.ts
```

后续若有编排实现，应把 recorded traces 写成与 `agentOrchestrationDevTraceSchema` 兼容的 JSON，再调用 `scoreAgentOrchestrationDevRun(dataset, traces, { result_class: "dev_system_run" })`。在实现落地前，仓库里不存在产品 run 的通过结果。`pipeline.specialists_enabled` 必须保持 `false`。

## 10. 禁止事项

- 把开发样例或本协议分数写入 official locked 报告。
- 为了抬高分数而把 holdout 稿件、真实未刊稿或真实个人信息加入本目录。
- 在本评估中发起真实网络请求或外部模型调用。
- 修改 `apps/**`、`packages/review-core/**` 或其它产品运行时包来迁就本协议。
- 读取 holdout gold、lifecycle 正文或 `HOLDOUT_CUSTODIAN_HOME`。
