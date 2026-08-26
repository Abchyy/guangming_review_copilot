import type { FindingType, ModelSpecialistId } from "@grc/contracts";
import { MODEL_SPECIALIST_IDS } from "@grc/contracts";

import { SPECIALIST_TARGET_MODEL } from "./config";

export const SPECIALIST_ROLE_TITLES: Record<ModelSpecialistId, string> = {
  fact_check: "事实核验专家",
  news_edit: "新闻编辑专家",
};

export const FACT_CHECK_FINDING_TYPES: readonly FindingType[] = [
  "person",
  "organization",
  "datetime",
  "number",
  "policy",
  "external_fact",
  "citation",
];

/** Editorial judgment only. `basic_text` stays with the deterministic rules engine. */
export const NEWS_EDIT_FINDING_TYPES: readonly FindingType[] = [
  "consistency",
  "citation",
];

export const SPECIALIST_ROLE_FINDING_TYPES: Record<
  ModelSpecialistId,
  readonly FindingType[]
> = {
  fact_check: FACT_CHECK_FINDING_TYPES,
  news_edit: NEWS_EDIT_FINDING_TYPES,
};

/**
 * DeepSeek-V4-flash role prompts. Each specialist is a different review
 * perspective, not a vote. Callers must pass fragments only, never the full article.
 */
export const SPECIALIST_ROLE_PROMPTS: Record<ModelSpecialistId, string> = {
  fact_check: `你是「光明审校 Copilot」的事实核验专家，服务对象是党报、主流媒体的责任编辑。

目标模型：${SPECIALIST_TARGET_MODEL}。你只从给定片段、初步 findings 和必要证据判断事实风险，不阅读全文，不检索外部网页。

审校重点：人物姓名与职务、机构名称、日期时间、数字与单位、政策文件名称与口径、引语归属、外部事实风险。

要求：
- 只输出结构化候选，不得输出自然语言总评。
- 证据不足时不得写成已证实结论，必须标为待人工核实。
- 不得编造来源、URL、规则或检索结果。
- 你是多视角中的事实核验视角，不要用多数票代替证据。
- 规则引擎是确定性程序，不是你的同伴 Agent。`,
  news_edit: `你是「光明审校 Copilot」的新闻编辑专家，服务对象是党报、主流媒体的责任编辑。

目标模型：${SPECIALIST_TARGET_MODEL}。你只从给定片段、初步 findings 和必要证据做需要编辑判断的核验，不阅读全文，不检索外部网页。

审校重点：文内前后矛盾、引语转述与出处是否适合见报。错别字、标点、明显语病等 basic_text 问题由确定性规则引擎处理，不是你的任务。

要求：
- 只输出结构化候选，不得改写全文或做通用润色。
- 不得发明事实；发现事实冲突时标为待人工核实，交给事实核验视角与编辑判断，而不是投票。
- 不得编造来源、URL、规则或检索结果。
- 规则引擎是确定性程序，不是你的同伴 Agent。`,
};

export function isModelSpecialistId(id: string): id is ModelSpecialistId {
  return (MODEL_SPECIALIST_IDS as readonly string[]).includes(id);
}

export function findingTypesForSpecialist(id: ModelSpecialistId): readonly FindingType[] {
  return SPECIALIST_ROLE_FINDING_TYPES[id];
}
