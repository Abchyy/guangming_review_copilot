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
```

`npm run test:live-smoke` 同样是显式 opt-in 的诊断入口，不属于平时本地测试，也不冒充 locked 结果。

数据集角色、inference freeze、blind inference 与 hidden gold 评测分离，见 `docs/benchmark-holdout.md`。
