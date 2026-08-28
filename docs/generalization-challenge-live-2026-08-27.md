# 公开对抗集全功能诊断（2026-08-27）

## 定位

- 数据集：`generalization-challenge-v1.0.0`，12 篇公开事实改写/全合成文章，36 条 gold，含 2 篇 clean control。
- 性质：`public_adversarial_diagnostic`，仅作开发诊断；不是 fresh locked holdout，也不能作为正式泛化成绩。
- 路径：DeepSeek 主审校 + Tavily + fact_check/news_edit specialists，产品 55 秒总 deadline，关闭应用缓存。
- 调用策略：未增加单次 attempt 或总调用上限，使用产品默认主审校重试和 specialist 编排。
- 浏览器：未运行。
- 基线代码：`master@9087124`；live harness 当时为未提交改动。
- 原始 artifact：`.data/generalization-challenge-v1-last-run.json`（gitignore），SHA-256 `55d1abe2864795a928626a0fa400a61f33675346d1b9f9b29b88350b44492a71`。

## 结果

| 项目 | 结果 |
| --- | ---: |
| 产品响应成功 | 5 / 12 |
| 执行失败 | 7 / 12 |
| rules_only | 1 / 12 |
| 严格 TP / FP / FN | 4 / 5 / 32 |
| 严格 recall | 11.1% |
| critical/high recall | 11.5% |
| 严格 precision | 44.4% |
| evidence coverage | 0% |
| clean-control FP | 0（但 1 / 2 clean control 执行失败） |
| 返回路径平均耗时 | 44.84 秒/篇 |
| 整批墙钟 | 589.22 秒 |

严格命中集中在 datetime（3 / 7）和 organization（1 / 2）；number（0 / 15）、policy（0 / 6）、external_fact（0 / 2）、person、citation、consistency、basic_text 均为 0。

## 调用与降级

- 主审校有完整 provenance 的仅 7 篇，共观测 11 attempts；另外 5 篇在 deadline 中断，attempt/usage 未被观测，不能据此断言真实总调用数。
- 已观测主审校 usage：input 14,236、output 30,867、cached input 12,928 tokens；已确定主审校成本 USD 0.020750476。
- 11 个已观测主审校 attempts 中，7 个 output tokens 为 3071/3072，说明 3072 产品上限仍频繁打满并导致截断/空响应。
- Tavily 实际启动 6 次查询：3 次 retrieved，3 次 unverified。
- Specialists 实际 invoked 3 次：0 succeeded、2 failed、1 timed_out；记录到 2 个 attempts，未给结果带来可用增量。
- 本次报告没有完整汇总 specialist 成本；加上 5 篇主审校 usage 未观测，因此总成本只能标为不确定，不能只用 USD 0.020750476 代表全程成本。

7 篇失败中，5 篇为 `Review deadline exceeded`，2 篇为 `Provider response was empty`。当文章没有可用规则命中时，当前 pipeline 无法组成 rules_only 响应，API 会返回 provider error；这暴露的是全功能产品路径的可靠性问题。

## 评分校准

严格 evaluator 同时要求 Finding type 与 source span 契合。人工复核 5 个“FP”后发现：

- 4 个实际对应 gold 内容，但模型统一输出为 `external_fact`，而 gold 标为 `number` 或 `policy`，且部分 quoted span 边界更长；
- 另 1 个是正文中的“最长可提前 5 年”，属于真实错误，但 v1 gold 只标了标题中的同类错误，存在漏标。

因此 11.1% 是严格合同分数，不等同于纯语义识别率。按本次人工最小校准，至少 8 / 36 gold 被语义识别（约 22.2%），另有 1 个有效的漏标发现；该数字是诊断性复核，不能替代重新标注后的自动评分。

## 结论

这次结果不支持“全功能模式已经具备稳定泛化能力”。主要瓶颈依次是：

1. 55 秒内主模型经常打满 3072 tokens，导致 7 / 12 无产品响应；
2. Tavily 与 specialists 位于主审校之后，主模型耗尽 deadline 时无法发挥作用；
3. specialists 本轮 0 成功；
4. evaluator 类型约束和 challenge v1 漏标会低估内容识别，但即使人工校准后召回仍低。

## 建议的下一步

1. P0：保证无规则命中的文章在 deadline/空响应时也返回明确的降级结果，避免 API 失败。
2. P0：解决首次 JSON 输出频繁打满 3072 tokens；先用离线/单篇开发样本验证输出结构和长度，不立即重跑 12 篇。
3. P1：重新安排 deadline，让 Tavily/specialists 获得可执行预算，并完善 specialist 成本与 usage 汇总。
4. P1：修正 challenge v1 的漏标，给 evaluator 增加“严格合同分数”和“语义/span 容错分数”双轨报告。
5. 完成上述修复后再生成 `generalization-challenge-v1.1`，只跑一次对比诊断。
