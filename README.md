# Guangming Review Copilot / 光明审校 Copilot

面向严肃媒体责任编辑的轻量化 AI 审校工具。产品方向见仓库根目录 `Guangming_Review_Copilot_Product_Freeze_v1.0.md`（已冻结，请勿修改）。

当前阶段：Milestone 1 Vertical Slice。只证明：

粘贴稿件 → backend 产出 Finding[]（可靠 source span）→ 原文 highlight ↔ 右侧 Finding 双向定位。

## 技术基线

- Next.js 16.3.1 + React 19.2.8 + TypeScript 5.9.3
- 单体 App Router
- 依赖版本由 `package.json` 精确固定，并由 `package-lock.json` 锁定

## 本地运行

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。页面预填 Demo 稿件，点击「开始审校」。

默认 `REVIEW_PROVIDER=fixture`，无需 OpenAI 密钥即可走通 Vertical Slice，结果完全确定。

如需 live provider：

```bash
REVIEW_PROVIDER=openai
OPENAI_API_KEY=...
REVIEW_MODEL=gpt-5.6-terra
```

模型名称只通过服务端环境变量 `REVIEW_MODEL` 配置，不要在代码中散落硬编码。

## Offset contract

- JavaScript / TypeScript UTF-16 code units
- `start_offset` inclusive, `end_offset` exclusive
- LLM 只返回 `exact_quote` 等定位线索
- backend locator 是唯一 source-span authority
- 每个 Finding 满足 `quoted_text === canonicalText.slice(start_offset, end_offset)`

## 校验

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
