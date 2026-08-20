# Benchmark Holdout

本文件只说明数据角色和正式 blind evaluation 协议。它不是调 Prompt / rules / corpus 的手册。

## 数据角色

| 角色 | 当前位置 | 用途 | 可否作为 official locked 泛化证据 |
| --- | --- | --- | --- |
| `dev` | `data/benchmark/dataset.json`（6 篇） | 开发、诊断、调优 | 否 |
| `regression` | 同上（12 篇，原 locked） | 回归 / legacy contaminated | 否。已被 inference assets 污染并标记为 `consumed` |
| `locked` | 不在开发 repo | 未来正式 hidden holdout | 仅当 gold 在仓库外、holdout 仍为 `available`、且经过下方协议 |
| `protocol_fixture` | `data/benchmark/protocol-fixtures/` | 验证协议基础设施 | 否 |

旧 12 篇的生命周期记录在 `data/benchmark/holdout-registry.json`。它们的 gold 仍在开发数据集中，只是为了回归，不能再写成正式 locked 分数。

未来正式 hidden gold **不得**进入本开发仓库，也不得进入开发 Agent context。

## 何时可以创建 System Freeze 与 Run Freeze

正式路径的 workspace identity 在 runtime 建立时冻结一次：从已加载源码定位仓库根目录并做 realpath 规范化。之后 `process.chdir()` 不能改变 Git observation、freeze 资产哈希、in-repo 判定，以及 rules / corpus 等 inference 资产的加载根。`createInferenceFreeze`、`runOfficialBlindInference` 和正式 controlled evaluation 若发现当前 cwd 已偏离该 canonical workspace，会 fail-closed，而不会跟随新的 cwd。调用方也不能传入 `repoRoot` / `git` 把检查切到另一个 checkout，或替换 Git observation provider。

`createOfficialSystemFreeze({ artifactDir })` 会在任何 inference 之前持久化 **System Freeze**。它冻结被评估系统本身，且不依赖尚未存在的 `holdout_id` / `article_ids`：

- 上述 canonical workspace 的 Git commit（工作树必须干净）
- Prompt / schema、rules catalog、corpus、evaluator、检索与融合链路、provider adapter 的**内容哈希**
- provider / requested model / cache / retry 等关键调用配置
- **provider endpoint identity**（从运行时配置观察，调用方不能注入）
- **provider/account boundary identity**（credential 的稳定非秘密哈希；明文 secret 不得写入 artifact）
- `package-lock.json`

版本字符串只是标签。身份以内容哈希为准。工作树 dirty、资产漂移、官方 freeze 开启应用层 cache、provider/model 与官方基准不一致、或 endpoint/account 无法观察，都会 fail-closed。

fresh hidden holdout 由 custodian 在 `HOLDOUT_CUSTODIAN_HOME` 下创建之后，`createOfficialRunFreeze` 会在任何模型调用之前持久化 **Run Freeze**。它绑定：

- 不可变 System Freeze identity
- holdout / input-pack identity
- lifecycle identity（不含 status / result_id）
- custodian boundary（`HOLDOUT_CUSTODIAN_HOME` 的 realpath + 唯一 lifecycle 路径）
- 本次正式 runtime 观察到的 provider endpoint / account boundary（必须与 System Freeze 一致，不能改写系统身份）

消费 official freeze（blind inference 或后续正式阶段）时不能只相信 self-hash。必须再次证明：已持久化的 System Freeze 与 Run Freeze 都在、资产集合完整且未被替换、runtime / endpoint / account 仍符合官方合同、holdout / lifecycle / custodian 身份闭合，并且运行的是被冻结的 clean 系统状态。Git commit / dirty 判断只来自 canonical workspace 的内部 `git` 查询。

`purpose: "protocol_dry_run"` 允许 dirty 工作树，且不走两阶段官方冻结；其结果不能标记为 official locked。

## Blind inference 与 evaluation 如何分离

1. **System Freeze**：冻结被评估系统身份，并在 inference 之前独立持久化。
2. **Hidden Holdout**：custodian 创建 fresh hidden holdout；只把 input pack（无 gold）交给开发侧。
3. **Run Freeze**：绑定 System Freeze、holdout、lifecycle 与 custodian，并在任何模型调用之前持久化。
4. **Blind Inference**：`runBlindInference` 只读 freeze + input，写出 sealed prediction 与 provenance。该模块不得加载 gold / evaluator。
   对 repo 外的 input-only `locked` pack，`runOfficialBlindInference` 是正式可执行路径：消费前必须存在已验证的 System Freeze 与 Run Freeze，并用 Repair 3 的 runtime provenance gate fail-closed。
5. **Sealed Prediction**：已有 artifact 不得覆盖。正式 prediction 仅在实际 provider-response provenance 满足官方基准时才能落盘。
6. **Independent Evaluation**：`runControlledEvaluation` 读取 sealed prediction + hidden gold + 冻结 evaluator，写出 result manifest。正式路径必须从磁盘上的 sealed prediction 文件加载并重算 identity / 文件哈希，不能用调用方内存对象作为 fallback。
7. **Result Freeze**：manifest 记录 freeze / run freeze / prediction / input / gold / evaluator / 指标。
8. **Consumed**：评测后 holdout 变为 `consumed`，不得再当作新版本系统的独立 locked 泛化证据。

正式 official evaluation 的 gold 路径必须在开发 repo 之外。

## 为什么 hidden gold 不应进入开发 repo

一旦 gold 出现在开发仓库或开发 Agent 上下文中，Prompt、rules、corpus 或模型选择就可能被 holdout 泄漏污染。旧 12 篇 locked 已经发生过这类污染，因此被永久降级。

## 何时视为 consumed

- 完成一次受控 evaluation 后，对应 holdout 记为 `consumed`。正式 holdout 的 lifecycle 路径由环境变量 `HOLDOUT_CUSTODIAN_HOME` + `holdout_id` 唯一确定（`{HOLDOUT_CUSTODIAN_HOME}/holdouts/{holdout_id}/lifecycle.json`），与 artifact directory 无关。evaluation caller 不能另选文件重新 fresh。状态原子写入该唯一文件。该目录必须由 custodian 预置，且位于开发仓库外。
- `consumed`、`consuming` 或 `contamination` 不为空的 holdout，不能再声称 fresh locked 泛化。
- 正式 evaluation 必须从 sealed prediction **文件**加载并重算 identity / 文件哈希，不能用内存对象作为 official fallback。
- 正式 result 的 `holdout_lifecycle_sha256` 是稳定 holdout 身份（不含 status / result_id），可与最终 persisted consumed record 及 `result_id` 交叉复核。
- 本地 `npm run holdout:dry-run` 只证明协议可执行，其分数不是正式 locked score。
