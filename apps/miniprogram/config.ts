export type ClientMode = "fixture" | "wechat-api";

// 开发期默认仅运行本地 fixture。接入 staging 时必须显式修改模式并填写真实 HTTPS 域名。
export const CLIENT_MODE: ClientMode = "fixture";

// 不提交占位域名；真实域名应由集成工作流注入或在本地私有配置中提供。
export const API_BASE_URL = "";
