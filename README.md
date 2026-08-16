# Guangming Review Copilot / 光明审校 Copilot

面向严肃媒体责任编辑的轻量化 AI 审校工具。产品方向见仓库根目录 `Guangming_Review_Copilot_Product_Freeze_v1.0.md`（已冻结，请勿修改）。

当前阶段：Milestone 1 Vertical Slice。

## 技术基线

- Next.js 16 + React 19 + TypeScript
- 单体 App Router
- 依赖版本由 `package.json` 精确固定，并由 `package-lock.json` 锁定

## 本地运行

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

默认 `REVIEW_PROVIDER=fixture`，无需 OpenAI 密钥即可走通 Vertical Slice。

如需 live provider：

```bash
REVIEW_PROVIDER=openai
OPENAI_API_KEY=...
REVIEW_MODEL=gpt-5.6-terra
```

模型名称只通过服务端环境变量配置。

## 校验

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
