# Web Evidence 开发评估协议

本文件定义未来「轻量联网核验（Web Evidence）」在**开发阶段**的评估协议、公开/合成样例的数据角色、可人工复核指标，以及开发通过门槛。

它不是产品运行时规格，不是 `@grc/web-evidence` 的 TypeScript 接口，也不是 official holdout 协议。

配套资产：

- 样例与门槛：`packages/benchmark/src/web-evidence-eval/dataset.json`
- 离线 schema / 评分器：`packages/benchmark` 的 `web-evidence-eval` 导出

## 1. 目的与非目的

### 目的

为尚未接入产品运行时的轻量联网核验，提供一份可版本化的开发评估合同：

- 覆盖人物职务、机构名称、政策法规、日期、数字、归因六类高风险事实；
- 规定何时应查询、何时不应查询；
- 规定允许的来源类别、期望状态、失败降级和隐私最小化；
- 让后续自动化测试可以对照 recorded traces 离线计分。

### 非目的

- 不替代 `docs/benchmark-holdout.md` 中的 official freeze / blind inference / hidden gold。
- 不读取、不复制、不近似外部 holdout 的隐藏 gold。
- 不创建、不运行 official System Freeze / Run Freeze。
- 不绑定具体搜索 / 浏览 Provider，也不依赖尚未最终确定的产品接口。
- 不在本协议下联网。评分只读本地 dataset 与调用方提供的 traces。
- 本仓库中的分数不得写成 official locked 泛化证据。

## 2. 与 official holdout 的区分

| 项目 | 本协议（开发评估） | Official holdout |
| --- | --- | --- |
| 数据角色 | `web_evidence_dev` | `locked`（仓库外 custodian） |
| 样例来源 | 公开知识、合成稿、人工编写 | 外部 hidden gold |
| 存放位置 | 开发仓库 `packages/benchmark/src/web-evidence-eval/` | `HOLDOUT_CUSTODIAN_HOME`，不在本 repo |
| 是否可进 Agent 上下文 | 可以（开发诊断） | 不可以 |
| 是否需要 freeze | 否 | 是，两阶段官方冻结 |
| 是否联网 | 否 | 正式 inference 按 holdout 协议 |
| 分数含义 | 开发诊断 / 回归夹具 | 仅当 holdout 仍为 `available` 且协议闭合 |
| 污染后的处理 | 可迭代替换开发样例 | 记为 `consumed`，不得再当 fresh locked |

`data/benchmark/dataset.json` 的 `dev` / `regression` 审校样例、以及任何 `lock-*` 条目，都**不是**本协议的 gold。本协议样例 ID 以 `we-dev-` 为前缀，文章 ID 以 `we-dev-art-` 为前缀。

未来若要对 Web Evidence 做正式泛化评测，必须另建仓库外 hidden holdout，并走 `docs/benchmark-holdout.md`。不得把本开发集分数改名为 locked 分数。

## 3. 评估对象与解耦边界

评估对象是「对单条高风险事实是否发起轻量外部核验、核验时用了什么来源、得出什么状态、失败如何降级、查询载荷是否最小化」这一行为，而不是某一版 TypeScript 函数名。

为保持与未定实现解耦：

- gold 与 traces 都是 JSON 合同，字段用稳定字符串枚举，不用产品包的 class / interface。
- 允许来源用**来源类别**表示（如 `official_agency_page`），不写死域名、API vendor 或检索 provider。
- 证据定位符使用 `locator` 字符串。开发夹具使用 `fixture://...`；未来真实 run 可以填 URL 或其它稳定 locator。评分器只检查 locator / excerpt 是否可追溯，不发起 HTTP。
- traces 由未来实现或人工记录后**注入评分器**。本包不 import、不调用 `packages/web-evidence`。
- 不得把未定的 Web Evidence 运行时类型塞进 `@grc/contracts` 来迁就本协议。

## 4. 样例合同

每个 case 至少包含：

| 字段 | 含义 |
| --- | --- |
| `case_id` | 稳定 ID |
| `article_id` | 用于查询预算聚合 |
| `risk_category` | 六类高风险之一 |
| `claim.text` / `claim.normalized_fact` | 待核验事实 |
| `should_trigger_query` | 应否触发查询 |
| `allowed_source_classes` | 该事实允许使用的来源类别 |
| `expected_status` | `confirmed` / `conflicting` / `insufficient` / `not_applicable` |
| `forbidden_outbound_fields` | 查询载荷中不得出现的敏感字段 |
| `sensitive_context` | 不得出现在 outbound 文本中的哨兵值 |

补充字段：

- `query_priority`：同一篇文章内的查询优先级，数字越小越优先。预算不足时应放弃低优先级事实，而不是超预算。
- `expected_failure`：开发夹具中的失败模式（超时、无允许来源等）。有该字段时，期望状态必须是 `insufficient`。
- `fixture_sources`：离线夹具来源，供人工复核和后续 stub，不代表一次真实联网结果。

`should_trigger_query = false` 的 case，期望状态必须是 `not_applicable`。

## 5. 风险类别与触发规则

六类风险：

| `risk_category` | 含义 | 通常应查询 | 通常不应查询 |
| --- | --- | --- | --- |
| `person_title` | 人物职务 | 公开机构负责人的姓名–职务组合 | 口头尊称、无法核验的非正式称呼 |
| `organization_name` | 机构名称 | 具体行政机关 / 法定机构的现行名称 | 「有关部门」等泛称 |
| `policy_regulation` | 政策法规 | 具名法规、条例、规划、管理办法 | 无文件名的口号式表述 |
| `date` | 日期 | 可对照官方日程、法定节假日或施行日期的具体日历日 | 「近日」「昨日」等相对时间 |
| `number` | 数字 | 官方统计、公报中的可核对指标 | 现场观感、约数时长 |
| `attribution` | 归因 | 把事实归于某个可识别的官方发布主体 | 本报评论员观点、无法核验的匿名消息源身份 |

触发是针对**该条事实**，不是整篇稿件。内部一致性、错别字、纯文风问题不属于本协议的联网核验对象。

## 6. 允许来源类别

开发评估承认的权威来源类别：

| 类别 | 说明 |
| --- | --- |
| `official_agency_page` | 机构官网 / 政府门户的机构或领导人公开信息 |
| `official_gazette` | 政府公报 |
| `statute_or_regulation` | 法律法规或标准文本 |
| `statistical_bulletin` | 统计公报 / 官方统计发布 |
| `authorized_news_release` | 授权发布 / 官方新闻发布会材料 |
| `calendar_authority` | 官方节假日或历法公告 |

下列类别可以出现在 traces 里，但**不能**单独支撑 `confirmed` 或 `conflicting`：

- `search_snippet`
- `social_media`
- `personal_blog`
- `encyclopedia_user_edit`
- `unknown`

`conflicting` 要求至少一条允许类别来源与待核验事实矛盾。`confirmed` 要求至少一条允许类别来源支持，且没有允许类别来源矛盾。只有非允许来源或查询失败时，状态应为 `insufficient`，不得升格为 confirmed。

## 7. 查询预算与隐私最小化

默认开发预算（写入 dataset，随版本变更，与产品策略一致）：

- 每篇文章最多 2 次查询；
- 每条事实最多 1 次查询；
- 每次查询最多 3 条结果。

允许进入查询载荷的字段示例：`claim_text`、`normalized_fact`、`as_of_date`、`risk_category`、`span_quote`。

禁止进入查询载荷的字段：

- `full_unpublished_body`
- `reporter_phone`
- `reporter_email`
- `private_citizen_address`
- `private_citizen_id`
- `unpublished_source_identity`
- `internal_newsroom_note`
- `holdout_identifier`
- `draft_watermark`
- `interviewee_contact`

实现可以把稿件全文用于**本地**判断是否触发查询，但向外发出的查询不得携带未刊正文、记者联系方式、内部备注或 holdout 标识。

## 8. 指标（可人工复核）

六项指标均可在不运行模型的前提下，对照 traces 与 gold 人工勾选。评分器只是把同一规则写成确定性函数。

### 8.1 查询触发准确性 `query_trigger_accuracy`

对每个 case：

- TP：应触发且实际触发
- TN：不应触发且未触发
- FP：不应触发却触发
- FN：应触发却未触发

\[
\text{query\_trigger\_accuracy} = \frac{TP + TN}{N}
\]

人工复核：打开 case 的 `should_trigger_query` 与 trace 的 `triggered`，按上表打勾。因预算放弃的低优先级查询记为 FN，同时在预算指标中可以仍为合规。这是有意拆分：预算遵守不等于触发召回。

### 8.2 查询预算遵守率 `query_budget_compliance_rate`

按 `article_id` 聚合。若该文实际查询次数 ≤ `max_queries_per_article`，每条事实的 `query_count` ≤ `max_queries_per_claim`，且每次查询引用的结果数 ≤ `max_results_per_query`，则该文合规。

\[
\text{query\_budget\_compliance\_rate} = \frac{\text{合规文章数}}{\text{文章数}}
\]

人工复核：按文章清点发出的查询次数，与 dataset 预算比较。

### 8.3 权威来源比例 `authoritative_source_ratio`

只统计「已触发且至少返回一条来源」的查询。若该次查询的全部来源类别都属于该 case 的 `allowed_source_classes`，则计为权威。

\[
\text{authoritative\_source\_ratio} = \frac{\text{权威查询数}}{\text{有来源的已触发查询数}}
\]

分母为 0 时，指标记为 `1`（空集不惩罚），但必须同时看失败降级指标。

人工复核：对每条来源，确认类别是否在允许列表中。不要只看搜索引擎是否返回了结果。

### 8.4 证据可追溯率 `evidence_traceability_rate`

对全部被引用的证据条目：同时具备非空 `locator` 与非空 `excerpt` 则计为可追溯。

\[
\text{evidence\_traceability\_rate} = \frac{\text{可追溯条目}}{\text{引用条目}}
\]

分母为 0 时记为 `1`。

人工复核：仅有「据网上资料」或无法打开的 locator，不算可追溯。开发夹具的 `fixture://` locator 视为可追溯，前提是 excerpt 非空。本协议**不联网**验证 locator 是否可访问。

### 8.5 失败降级正确率 `failure_degradation_correctness`

降级机会包括：

- gold 标注了 `expected_failure` 的 case；
- trace 记录了 `failure` 的 case。

正确降级：输出状态为 `insufficient`，且不得为 `confirmed`。

\[
\text{failure\_degradation\_correctness} = \frac{\text{正确降级数}}{\text{降级机会数}}
\]

分母为 0 时记为 `1`。本开发集包含超时与非允许来源两类失败样例，分母不应为 0。

人工复核：查询超时、空结果、仅自媒体/博客时，是否没有被写成「已确认」。

### 8.6 隐私最小化合规率 `privacy_minimization_compliance_rate`

对每个 case，同时满足：

- `outbound_fields` 与 `forbidden_outbound_fields` 交集为空；
- `query_text` 与 `outbound_text_blobs` 均不包含该 case `sensitive_context` 中的哨兵值。

\[
\text{privacy\_minimization\_compliance\_rate} = \frac{\text{合规 case 数}}{N}
\]

人工复核：检查实际发出的查询串，确认没有未刊全文、记者电话/邮箱、内部备忘或 holdout id。

## 9. 开发通过门槛

以下门槛用于未来开发迭代的**门禁定义**。本任务只定义门槛，**不声称任何产品实现已经通过**。

没有 traces 的评分结果必须是 `run_status: "not_run"`。此时 `all_gates_passed` 为 `null`，不得把「未跑」写成「通过」。

对评分器自身的单元夹具，必须标注 `result_class: "protocol_self_check"`，不能冒充 `dev_system_run`。

| 指标 | 门槛 | 性质 |
| --- | --- | --- |
| 查询触发准确性 | ≥ 0.85 | 开发软门禁 |
| 查询预算遵守率 | = 1.00 | 硬门禁 |
| 权威来源比例 | ≥ 0.80 | 开发软门禁 |
| 证据可追溯率 | ≥ 0.90 | 开发软门禁 |
| 失败降级正确率 | = 1.00 | 硬门禁 |
| 隐私最小化合规率 | = 1.00 | 硬门禁 |

附加 fail-closed 条件：

- traces 必须一一覆盖 dataset 中的全部 `case_id`，否则 `coverage_complete = false`，`all_gates_passed = false`；
- `official_holdout` 必须为 false；
- 不得输出 `may_claim_official_locked_generalization: true`。

## 10. 运行方式

本协议的可执行部分全部离线：

```bash
# 校验样例合同、覆盖面和评分器（不联网，不跑 official freeze）
npx vitest run tests/benchmark/web-evidence-eval.test.ts
```

后续若有 Web Evidence 实现，应把 recorded traces 写成与 `webEvidenceDevTraceSchema` 兼容的 JSON，再调用 `scoreWebEvidenceDevRun(dataset, traces, { result_class: "dev_system_run" })`。在实现落地前，仓库里不存在产品 run 的通过结果。

## 11. 禁止事项

- 把开发样例或本协议分数写入 official locked 报告。
- 为了抬高分数而把 holdout 稿件、真实未刊稿或真实个人信息加入本目录。
- 在本评估中发起真实网络请求。
- 修改 `apps/**`、`packages/web-evidence/**` 或其它产品运行时包来迁就本协议。
