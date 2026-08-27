# Contaminated regression report — 2026-08-27

本报告记录旧 12 篇 former-locked 数据在当前产品路径上的一次真实 DeepSeek 回归。该数据已经被 inference assets 污染，只能用于回归诊断；结果不是 official locked score，也不得声称 fresh locked generalization。

## 执行约束

- Git SHA：`087f4a2`
- Dataset：`m3.1.0`
- Split / claim：`regression` / `regression_contaminated`
- 文章：12 篇；gold issues：24 条
- 产品 deadline：55,000 ms
- 每篇最多 1 次 provider attempt；实际共 12 次
- Application cache：关闭且无命中
- Tavily / specialists：未启用
- 观察到的模型：`deepseek-v4-flash`

## 结果

| 指标 | 结果 |
| --- | ---: |
| TP / FP / FN | 24 / 0 / 0 |
| Overall recall | 1.000 |
| Critical/high recall | 1.000 |
| Precision | 1.000 |
| Evidence coverage | 1.000 |
| Exact span rate | 1.000 |
| Top-5 recall | 1.000 |
| NDCG@10 | 1.000 |
| 平均模型延迟 | 13,608 ms / 篇 |
| 总成本 | USD 0.012398696 |

Usage 完整：input 15,503 tokens、output 17,997 tokens、cached input 13,568 tokens，未观察 usage 的 attempt 为 0。

## 重要限制

- 2/12 篇发生 `rules_only` fallback，原因均为 `Provider response was empty`；其余 10 篇未 fallback。
- 即使两篇没有取得可用模型输出，整体仍为满分，说明旧数据与现有确定性规则高度重合。
- 因此，本结果能够说明“当前版本没有破坏旧回归样例”，不能证明 DeepSeek 增量质量，也不能证明对新稿件的泛化能力。
- 新的正式结论仍需由独立 custodian 提供全新、状态为 `available` 的 hidden holdout，并按 System Freeze → Run Freeze → blind inference → controlled evaluation 协议执行。

## Artifact

- 本地原始报告：`.data/m3-regression-benchmark-last-run.json`（Git ignored）
- SHA-256：`9c279d6b2a8207864f64f35e4953e868f320ff2564ef19e52e5814b29be28128`
- Gold locate failures：0

