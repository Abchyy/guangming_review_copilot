# AI 审校助手 · 公开发布 Gate

- 工作名：AI 审校助手
- 基线：`7af7a05fb05dd26aa6347fc1d1c9094e45836077`
- 当前阶段：feature fixture 已完成；尚未集成、尚未部署；正式发布未验证
- 机器可读矩阵：`tests/public-release/gate-matrix.json`

本文是发布质量 Lane 的黑盒验证清单。它独立于产品实现，用于区分：

| 证据类别 | 含义 |
| --- | --- |
| `FIXTURE_VERIFIED` | 已由自动化 fixture 回放验证。只证明契约形状，不证明已部署。 |
| `STATIC_CHECK` | 只完成静态检查（扫描、文档对照）。没有打到真实系统。 |
| `NOT VERIFIED` | 尚未验证。 |
| `BLOCKED_EXTERNAL` | 必须等 AppID、域名、主体或微信审核后才能验证。 |

**禁止的结论：**

- 静态 fixture 通过 **不是** 真实微信链路通过。
- 开发版或体验版二维码不能证明“任何人扫码即可使用”。
- 尚未配置的 TTL、删除、日志策略 **不得** 写成已部署事实。
- 只有正式审核通过后的正式版小程序码，经未加入开发者或体验成员名单的微信账号完成闭环，才能声称公众可用。

当前不得进行真实微信提交、备案或正式发布。运营主体、AppID、正式域名、品牌授权均为 TBD。中性产品名使用“AI 审校助手”，不使用品牌名或 Logo。

本文不是法律意见。

---

## 如何复现

在仓库根目录、离线执行：

```bash
npx vitest run tests/public-release
node scripts/public-release/scan-sensitive.mjs
git diff --check
```

不要设置 `PUBLIC_API_BASE_URL`、`WECHAT_APPID` 或 `WECHAT_APPSECRET`。本 Lane 的测试遇到这些变量会直接失败，以免误打真实微信、真实模型或生产环境。

指向集成环境的黑盒回放属于 integration Lane，不在本工作树执行。

---

## 1. Fixture 开发 Gate

当前唯一可以给出自动化证据的 Gate。对象是 `tests/fixtures/public-api/**` 中按后端 `packages/contracts/src/public-api.ts` 录制的 API v0 交换，经 loopback HTTP 回放。这只证明 feature fixture 契约形状，不证明已集成或已部署。

| ID | 项目 | 判定标准 | 验证命令或步骤 | 期望证据 | 当前状态 | 阻塞条件 |
| --- | --- | --- | --- | --- | --- | --- |
| FIX-CATALOG | API v0 fixture catalog | catalog 列出全部必选场景且可解析 | `npx vitest run tests/public-release/api-v0-scenarios.test.ts` | 14 个必选场景加载 | FIXTURE_VERIFIED | 无 |
| FIX-SUCCESS | 成功 | POST 202 queued，GET succeeded，PATCH 决策成功，响应含 `request_id` | 同上 `-t success` | 200/202 录制回放 | FIXTURE_VERIFIED | 无 |
| FIX-DEGRADED | 降级 | `status=degraded`，固定 `degradation_notice`，不得显示“没有问题” | 同上 `-t degraded` | `degradation_notice` 原文匹配 | FIXTURE_VERIFIED | 无 |
| FIX-FAILED | 失败 | `status=failed` + `failure_code`，不得显示“没有问题” | 同上 `-t failed` | `failure_code=UPSTREAM_UNAVAILABLE` | FIXTURE_VERIFIED | 无 |
| FIX-UNAUTH | 未认证 | 缺 token 或非法 token → 401 `AUTH_REQUIRED` | 同上 `-t unauthenticated` | create/get/delete/invalid token 均为 401 | FIXTURE_VERIFIED | 无 |
| FIX-FORBIDDEN | 越权 / 所有权隔离 | B 不能 GET/PATCH/DELETE A 的 `review_id`；已认证非 owner → 404 `REVIEW_NOT_FOUND` | 同上 `-t forbidden` | B=404，A=200 | FIXTURE_VERIFIED | 无 |
| FIX-IDEMPOTENT-RETRY | 幂等重试 | 相同 Idempotency-Key 与请求体返回同一 `review_id`。配额/模型只扣一次是声明，不是已部署计量 | 同上 `-t idempotent-retry` | 两次 202 共用 `review_id` | FIXTURE_VERIFIED | 无 |
| FIX-IDEMPOTENT-CONFLICT | 幂等冲突 | 相同 key、不同 body → 409 `IDEMPOTENCY_CONFLICT` | 同上 `-t idempotent-conflict` | 409 `IDEMPOTENCY_CONFLICT` | FIXTURE_VERIFIED | 无 |
| FIX-INVALID | 非法输入 | 缺隐私版本、客户端传入 `user_id`、类型错误 → 400 `INVALID_REQUEST`；过期隐私版本 → 400 `PRIVACY_NOTICE_OUTDATED` | 同上 `-t invalid-request` | 400 信封 | FIXTURE_VERIFIED | 无 |
| FIX-TOO-LARGE | 超长输入 | 标题 > 200 或正文 > 10000 UTF-16 code unit → 413 `ARTICLE_TOO_LARGE` | 同上 `-t article-too-large` | 413 信封。Public API v0 上限 200/10000 | FIXTURE_VERIFIED | 无 |
| FIX-CONTENT-REJECTED | 内容拒绝 | 内容安全拒绝 → 422 `CONTENT_REJECTED` | 同上 `-t content-rejected` | 使用合成标记，不是真实违禁内容 | FIXTURE_VERIFIED | 无 |
| FIX-QUOTA | 日配额 | 超过 `daily_limit` → 429 `DAILY_QUOTA_EXCEEDED` | 同上 `-t daily-quota-exceeded` | 429 信封。不是实时配额库 | FIXTURE_VERIFIED | 无 |
| FIX-RATE-LIMIT | 限流 | 突发请求 → 429 `RATE_LIMITED` | 同上 `-t rate-limited` | 429 信封。不是实时限流器 | FIXTURE_VERIFIED | 无 |
| FIX-DELETE-CONTRACT | 删除语义（契约 fixture） | owner DELETE → 204；随后 GET → 404 `REVIEW_NOT_FOUND`；重复 DELETE → 204 | 同上 `-t delete` | 录制的 204/404/204 序列。**不证明**删除器已部署 | FIXTURE_VERIFIED | 无 |
| FIX-UNAVAILABLE | 服务不可用 | 503 `REVIEW_CAPACITY_EXHAUSTED` 与 `UPSTREAM_UNAVAILABLE` | 同上 `-t unavailable` | 两个 503 信封 | FIXTURE_VERIFIED | 无 |
| FIX-STATUS-ENUM | 状态枚举 | queued / running / succeeded / degraded / failed / cancelled / expired | `npx vitest run tests/public-release/contract-consistency.test.ts -t status` | `status-examples.json` 覆盖冻结枚举 | FIXTURE_VERIFIED | 无 |
| FIX-ERROR-CODES | 稳定错误码 | 每个冻结码对应固定 HTTP，且无堆栈/密钥泄漏 | 同上 `-t error` | `error-examples.json` 与 `api-v0.json` 一致 | FIXTURE_VERIFIED | 无 |
| FIX-TTL-DECLARED | TTL 声明 | fixture 用 `expires_at` 声明 24 小时留存 | 同上 `-t TTL` | 声明 24h。部署状态仍为 NOT VERIFIED | STATIC_CHECK | 无 |
| FIX-TTL-DEPLOYED | TTL 清理已部署 | 定时任务删除稿件、Finding、action、job 与摘录 cache，失败要告警 | 本工作树不可运行 | 清理日志、删行计数、失败告警 | NOT VERIFIED | TTL job 尚未集成或部署 |
| FIX-DELETE-DEPLOYED | 删除已部署 | 生产 DELETE 删除全文及相关行；审计只留事件元数据 | 本工作树不可运行 | 删除前后 DB、无正文审计行 | NOT VERIFIED | 删除路径尚未集成或部署 |
| FIX-LOG-POLICY-DEPLOYED | 生产日志策略已部署 | 运行时日志只有允许的 ID/状态/用量字段 | 本工作树不可运行；样本格式另扫 | 集成/生产日志导出 | NOT VERIFIED | 生产日志策略尚未集成或部署 |
| FIX-SECRET-SCAN | 仓库无真实密钥 | 扫描器未发现 PEM、云密钥或活体供应商密钥 | `node scripts/public-release/scan-sensitive.mjs` | `PUBLIC_RELEASE_SCAN: PASS` | STATIC_CHECK | 无 |
| FIX-LOG-SAMPLE | 日志样本脱敏 | `logs/safe-sample.jsonl` 无 bearer、OpenID、完整稿件 | `npx vitest run tests/public-release/security-scan.test.ts` | 样本扫描通过。只是格式 fixture | STATIC_CHECK | 无 |
| FIX-ERROR-LEAK | 错误输出不泄漏 | 错误信封无 stack、SQL、上游原文或供应商凭据 | 同上 | 错误载荷扫描通过 | FIXTURE_VERIFIED | 无 |
| FIX-NO-LIVE-WECHAT-CLAIM | 禁止把 fixture 写成微信通过 | fixture Lane 条目不得标为微信审核通过或公众码通过 | `npx vitest run tests/public-release/gate-matrix.test.ts` | 正式条目保持 NOT VERIFIED / BLOCKED_EXTERNAL | STATIC_CHECK | 无 |

降级必须显示的固定文案：

> 模型审校未完成，本轮仅完成规则检查，不能视为稿件没有问题。

---

## 2. 集成环境 Gate

Backend 与 Mini Program 的 feature fixture 已在各自 worktree 交付。本 Lane 不把那些 feature 工作树当成已集成或已部署。以下条目在 integration/staging 拿到命令证据前保持 NOT VERIFIED。

| ID | 项目 | 判定标准 | 验证命令或步骤 | 期望证据 | 当前状态 | 阻塞条件 |
| --- | --- | --- | --- | --- | --- | --- |
| INT-TYPECHECK | typecheck | 集成树上 `npm run typecheck` 通过 | `npm run typecheck` | `tsc --noEmit` exit 0 | NOT VERIFIED | 集成尚未吸收 backend/miniprogram |
| INT-LINT | lint | `npm run lint` 通过 | `npm run lint` | eslint exit 0 | NOT VERIFIED | 集成未开始 |
| INT-FULL-TEST | 完整离线测试 | `npm test` 通过，且包含本目录测试 | `npm test` (root offline vitest run) | Vitest exit 0 | NOT VERIFIED | 集成未开始 |
| INT-WEB-BUILD | Web production build | 现有 Web Demo 仍可构建 | `npm run build` | Next.js production build exit 0 | NOT VERIFIED | 本 Lane 未在 fixture 工作后重跑 |
| INT-MP-BUILD | 小程序构建 | `apps/miniprogram` 可构建 | Mini Program / Integration 所有的构建命令 | 集成后的构建日志。小程序客户端已在其 feature worktree，尚未并入本 Gate 运行 | NOT VERIFIED | 小程序客户端尚未集成到本工作树 |
| INT-API-WORKER-PG | API + Worker + PostgreSQL smoke | 类 staging 进程能创建、轮询到终态并删除 | 仅 loopback，禁止打微信生产 | request_id、job 行、delete 204 | NOT VERIFIED | Public API fixture slice 已在 backend worktree，尚未集成或部署 |
| INT-LIVE-BLACKBOX | 指向集成 API 的黑盒回放 | 同一套 fixture 打到集成 `PUBLIC_API_BASE_URL` | 由 Integration 持有该环境变量。本 Lane 拒绝该变量 | staging 黑盒 PASS，仍不是微信证明 | NOT VERIFIED | 无 staging Public API |
| INT-ROLLBACK | 发布/回滚演练 | staging 实际执行一次回滚 | Integration runbook | 带回滚时间戳的日志 | NOT VERIFIED | 无 staging 部署 |

---

## 3. 微信开发版 / 体验版 Gate

开发版、体验版只证明名单内账号能打开对应版本。关闭域名校验、fixture 登录或开发者工具预览，都不能代替正式发布。

| ID | 项目 | 判定标准 | 验证命令或步骤 | 期望证据 | 当前状态 | 阻塞条件 |
| --- | --- | --- | --- | --- | --- | --- |
| WX-DEV-QR | 开发版二维码 | 开发者名单内账号可打开开发版。不能证明公众可用 | 微信开发者工具上传 + 开发者扫码 | 开发版截图，必须标明 NOT public | BLOCKED_EXTERNAL | AppID TBD；未授权上传 |
| WX-TRIAL-QR | 体验版二维码 | 体验成员可打开体验版。不能证明公众可用 | 微信后台体验成员扫码 | 体验版截图，必须标明 NOT public | BLOCKED_EXTERNAL | AppID TBD；体验成员 TBD |
| WX-LOGIN | wx.login / code2Session | 真实 jscode2session 签发不透明会话；OpenID 不回客户端 | 使用真实 AppID 的 staging，仍非正式发布 | 服务端哈希主体日志；客户端载荷无 OpenID | BLOCKED_EXTERNAL | AppID/AppSecret TBD；本 Lane 禁止真实微信调用 |
| WX-DOMAIN | 服务器域名与业务域名 | 已备案 HTTPS API 域名在白名单中。关闭域名校验不是证据 | 微信后台 + TLS 探测 | 域名截图与 `curl --noproxy` TLS 200 | BLOCKED_EXTERNAL | HTTPS 业务域名 TBD |
| WX-DEV-NOT-PUBLIC | 开发版/体验版不得当作公开发布 | 发布说明必须写明：开发版或体验版二维码不能证明“任何人扫码即可使用” | `npx vitest run tests/public-release/gate-matrix.test.ts` | 本文含该声明 | STATIC_CHECK | 无 |

---

## 4. 正式审核和正式二维码 Gate

以下项目当前全部为 **NOT VERIFIED**。缺少真实主体材料时不得伪造。

| ID | 项目 | 判定标准 | 验证命令或步骤 | 期望证据 | 当前状态 | 阻塞条件 |
| --- | --- | --- | --- | --- | --- | --- |
| OFF-ENTITY | 运营主体 | 主体全称、类型、微信认证与提审小程序一致 | 微信后台 + 证照。禁止编造 | 认证主体截图。当前 TBD | NOT VERIFIED | 运营主体 TBD |
| OFF-ICP-FILING | 小程序备案 | 该主体下小程序备案完成 | 微信备案页 | 备案号。当前 TBD | NOT VERIFIED | 小程序备案 TBD |
| OFF-APPID | 正式 AppID | 正式发布使用生产 AppID，不是测试号，也不是 fixture token | 微信后台 AppID 对照生产配置 | 由运营方记录 AppID；AppSecret 不得入库 | NOT VERIFIED | 正式 AppID TBD |
| OFF-HTTPS-DOMAIN | HTTPS 业务域名 | 公众 API 在已备案 HTTPS 域名上，境内可访问 | 证书、ICP、微信域名列表 | 域名 + 证书到期日 + ICP 号 | NOT VERIFIED | HTTPS 业务域名 TBD |
| OFF-PRIVACY-GUIDE | 隐私保护指引 | 微信隐私指引与端内提示匹配真实数据流：仅 wx.login、24h 留存、不收手机号 | 微信隐私指引 UI + 文案审查 | 提交文本与截图 | NOT VERIFIED | 隐私保护指引 TBD |
| OFF-GENERATIVE-AI | 生成式 AI / 平台合规 | 生成式 AI 登记、算法备案、安全评估、新闻许可边界由运营主体确认。本仓库不是法律意见 | 运营方提供证件。禁止编造编号 | 登记号或书面“不适用”结论 | NOT VERIFIED | 生成式 AI 或相关平台合规要求 TBD |
| OFF-WECHAT-REVIEW | 微信审核 | 正式版本审核状态为审核通过 | 微信后台审核记录。本 Lane 不得提审 | 审核通过截图与时间 | NOT VERIFIED | 微信审核未提交且未授权 |
| OFF-STRANGER-QR | 正式版二维码陌生账号测试 | 未加入开发者或体验成员名单的微信账号，扫描正式版小程序码，在额度内完成一次审校闭环 | 正式发布后的人工测试。开发版/体验版码不足 | 该陌生账号在正式码上的录像或截图 | NOT VERIFIED | 正式发布尚未发生 |

G5 完成标准（尚未开始）：

> 一个未加入开发者或体验成员名单的正常微信账号，扫描正式发布的小程序码，可以在额度和平台风控范围内完成一次审校闭环。

---

## 发布清单

在声称“任何人扫码即可使用”之前，必须同时满足：

1. Fixture 开发 Gate 中标记为 `FIXTURE_VERIFIED` / `STATIC_CHECK` 的条目保持通过，且 TTL/删除/日志的 **部署** 条目不再是 NOT VERIFIED。
2. 集成环境 Gate 在真实 staging 上拿到命令证据，而不是只跑 fixture。
3. 微信开发版/体验版如已验证，证据必须明确标注 **不能** 代表公众可用。
4. 正式审核和正式二维码 Gate 的 OFF-* 条目全部有真实材料，状态不再是 NOT VERIFIED。
5. 开发版或体验版二维码不能证明“任何人扫码即可使用”。

当前发布结论： **BLOCKED**。feature fixture 已可重复回放，但尚未集成、尚未部署；外部准入参数全部 TBD；正式审核和陌生账号扫码均为 NOT VERIFIED。

回滚：本 Lane 不部署，因此没有可执行的生产回滚。集成 Lane 需要单独演练 `INT-ROLLBACK`。

---

## 契约对齐说明

发布 fixture 以 backend `packages/contracts/src/public-api.ts` 为唯一事实源。已对齐项不再作为 change request 开放：

- 隐私声明版本 `public-v1`
- 幂等冲突 `409 IDEMPOTENCY_CONFLICT`
- 已认证非 owner 访问审校资源 `404 REVIEW_NOT_FOUND`
- 删除后 GET `404`；owner 重复 DELETE `204`
- GET 信封为 `{ request_id, review }`；降级用 `degradation_notice`；失败用 `failure_code`
- 错误码与 HTTP 状态与 `PUBLIC_API_ERROR_HTTP_STATUS` 一致

会话 TTL 时长未在契约中冻结（仅有 `expires_at` 字段）。fixture 中的登录过期时间只是示例，不写成已部署策略。

---

## 项目状态（回派，不在本 Lane 修复）

区分四层，避免把 feature fixture 写成集成或发布证据：

| 层 | 状态 | Owner |
| --- | --- | --- |
| Feature fixture：Public API v0 | 已在 `feature/public-backend` 交付 fixture slice | Backend Writer |
| Feature fixture：小程序客户端 | 已在 `feature/miniprogram-client` 交付 | Mini Program Writer |
| 集成到本发布工作树 / `integration/public-v1` | 尚未集成 | Integration Writer |
| 部署、TTL/删除/日志生产策略、staging smoke | 尚未部署，NOT VERIFIED | Integration / Backend |
| 微信审核、正式码、陌生账号 | NOT VERIFIED / BLOCKED_EXTERNAL | 运营主体，本 Lane 不得提审 |

现有 Web Demo 的 `POST /api/reviews` 仍是同步路径；公众环境还需关闭 `/api/runtime-config` 用户 Key 入口。这些不改变“Public API 与小程序客户端已经存在于对应 feature worktree”这一事实。

---

## 安全扫描范围

`scripts/public-release/scan-sensitive.mjs` 做三类静态检查：

1. 仓库文本中的 PEM / 云密钥 / 供应商 key 形态；`tests/api` 里带 CANARY/fixture 字样的现有测试探针予以放行。
2. `tests/fixtures/public-api/logs` 不得出现 bearer token、OpenID 或完整稿件。
3. 场景与错误示例中的 error 信封不得出现 stack、SQL、AppSecret 或供应商 key。

通过结论只是 `STATIC_CHECK`。它不能证明生产 logger 已经按该策略部署。
