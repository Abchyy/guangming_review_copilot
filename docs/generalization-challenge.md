# Generalization Challenge v1

`data/benchmark/generalization-challenge-v1.json` 是面向媒体审校的高难度公开对抗开发集。它用于发现跨文章、跨数字、政策版本、日期星期、实体和引语归属等泛化缺口。

## 数据角色

- 角色：`adversarial_dev`
- 文章：12 篇重新合成的中文新闻稿
- Gold issues：36 条
- 负样本：2 篇无预埋错误文章，用于测误报
- 来源：9 篇依据政府、教育、人社、网信、航天、统计等权威公开事实重新编写；3 篇为内部一致性合成稿
- 禁止声明：official locked score、fresh hidden generalization

文章不是网页原文摘录。公开来源只提供事实锚点，稿件表达和错误组合均为重新合成。

## 难点覆盖

- 相近政策日期与法律版本
- 渐进式政策被误写为一次性调整
- 日期与星期不一致
- 克/千克、万元/亿元等数量级错误
- 跨段加总、百分比和标题正文矛盾
- 机构名称漂移、引语归属变化
- 初步统计数与最终核实数混用
- 无错误但数字复杂的负样本

## 权威事实来源

- [教育部：中华人民共和国主席令（第二十二号）](https://www.moe.gov.cn/jyb_xwfb/s6052/moe_838/202404/t20240426_1127760.html)
- [人社部：《实施弹性退休制度暂行办法》发布](https://www.mohrss.gov.cn/wap/xw/rsxw/202501/t20250101_533705.html)
- [国家航天局：嫦娥六号任务圆满成功](https://www.cnsa.gov.cn/n6758823/n6758844/n10518102/n10518147/c10565180/content.html)
- [国家航天局：嫦娥六号采样数据](https://www.cnsa.gov.cn/n6758823/n6758844/n10518102/n10518157/c10570691/content.html)
- [国家统计局：第七次全国人口普查公报](https://www.stats.gov.cn/xxgk/sjfb/zxfb2020/202105/t20210511_1817197.html)
- [中央网信办：中华人民共和国个人信息保护法](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)
- [工信部：无障碍环境建设法正式施行](https://www.miit.gov.cn/jgsj/xgj/scgl/art/2023/art_3f68ef945d7d4f2f9a2b27b7689b6d4d.html)
- [中国政府网：未成年人网络保护条例](https://app.www.gov.cn/govdata/gov/202310/24/508651/article.html)
- [中国政府网：民营经济促进法政策解读](https://www.gov.cn/zhengce/202505/content_7023033.htm)
- [国家统计局：2024年GDP最终核实](https://www.stats.gov.cn/zs/tjwh/tjkw/tjqk/zgxxb/202512/P020251229312425103483.pdf)

## 离线验证

```bash
npm run test:challenge
```

该命令只验证 schema、角色声明、覆盖面、ID 唯一性、Gold quote 定位和证据 URL 归属，不调用模型或网页。

## 使用原则

1. 首次模型测试前固定代码 SHA、模型、prompt、deadline 和调用预算。
2. 先保存 prediction，再加载本数据的 gold 评分。
3. 首次结果可称为 one-time adversarial diagnostic；代码针对该集合调整后，后续结果只能称为 development regression。
4. 新的正式泛化结论仍需独立 custodian 创建未进入开发上下文的 hidden holdout。
