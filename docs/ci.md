# CI 质量门禁

`.github/workflows/quality-gates.yml` 在 pull request 以及推送到 `master` 时运行。任一步失败则整个工作流失败；GitHub Actions 日志按步骤名区分。

## 运行内容

使用 `package-lock.json` 锁定安装（`npm ci`），Node.js 20，并通过 `actions/setup-node` 缓存 npm 依赖。`next-env.d.ts` 被 gitignore，因此 typecheck 前先用仓库锁定的 Next.js 生成类型。随后按顺序执行与本地校验相同的命令：

```bash
npm ci
npm exec -- next typegen ./apps/web
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` 走仓库默认的离线 Vitest 配置：不包含 `tests/live/**`，也不包含需要单独配置的 holdout probe。

## 不运行的内容

工作流不执行、不注入、不读取下列入口或资产：

- `npm run test:dev-live`
- `npm run test:locked`
- `npm run test:live-smoke`
- `npm run holdout:status` / official locked 评测
- API Key、holdout 路径、数据库内容

本地按上面的命令顺序执行即可对齐 CI。
