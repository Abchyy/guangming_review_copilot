# 项目级 Agent 规则

本文件只规定本项目长期稳定的工程底线。
具体任务目标、权限、修改范围和验收标准，以当前任务 Prompt 为准。

## 1. 任务边界

- 只完成当前明确任务，不自行扩大 Scope。
- 不进行与当前任务无关的重构、清理或功能增加。
- Product Freeze 或当前任务未授权的产品方向变化，不得自行决定。

## 2. 重大变更

以下情况应停止并上报，而不是自行处理：

- 需要改变核心产品规格；
- 需要改变核心架构或数据模型；
- 需要替换技术栈；
- 需要引入重要的新依赖、外部服务或模型；
- 当前任务与 repo 的真实状态存在实质冲突；
- 发现安全、隐私、数据泄漏或 benchmark leakage 风险。

## 3. 工作树与 Git

- 尊重任务开始前已有的修改和未跟踪文件。
- 不覆盖、回滚、删除或清理不属于当前任务的已有工作。
- 不执行破坏性 Git 操作，除非当前任务明确授权。
- 是否 commit、何时 commit，以当前任务指令为准。

## 4. 修改原则

- 优先采用完成当前任务所需的最小修改。
- 不因个人偏好擅自重构已经工作的代码。
- 不为了“更先进”而引入当前任务不需要的复杂度。

## 5. 验证与事实

- 严格区分“计划”“已修改”“已运行”“已测试”“已通过”。
- 没有实际执行的测试不得声称通过。
- 结论以当前 repo、runtime、测试结果和真实 artifact 为准。
- 无法执行必要验证时，应明确说明原因。

## 6. 反馈

默认使用中文。

完成任务后简洁说明：

- 修改了什么；
- 做了哪些验证；
- 是否满足验收条件；
- 尚存的风险或阻塞；
- 当前 Git 状态。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
