"use client";

import { useEffect, useState } from "react";

import { Masthead } from "@/components/review/Masthead";
import {
  isRuntimeConfigStatus,
  missingRuntimeConfigStatus,
  type RuntimeConfigStatus,
  type RuntimeKeySource,
} from "@/lib/runtime-config";

type RuntimeSetupProps = {
  onContinue: (status: RuntimeConfigStatus) => void;
};

function sourceLabel(source: RuntimeKeySource): string {
  if (source === "session") {
    return "会话内存";
  }
  if (source === "environment") {
    return "开发环境";
  }
  return "未配置";
}

function capabilityText(enabled: boolean, on: string, off: string): string {
  return enabled ? on : off;
}

export function RuntimeSetup({ onContinue }: RuntimeSetupProps) {
  const [status, setStatus] = useState<RuntimeConfigStatus | null>(null);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/runtime-config");
        const json: unknown = await response.json();
        if (cancelled) {
          return;
        }
        if (!response.ok || !isRuntimeConfigStatus(json)) {
          setStatus(missingRuntimeConfigStatus());
          setError("无法读取运行配置，可重新填写后继续。");
          return;
        }
        setStatus(json);
      } catch {
        if (!cancelled) {
          setStatus(missingRuntimeConfigStatus());
          setError("无法读取运行配置，可重新填写后继续。");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveAndContinue() {
    setSaving(true);
    setError(null);
    try {
      const payload: { deepseekApiKey?: string; tavilyApiKey?: string } = {};
      const deepseek = deepseekApiKey.trim();
      const tavily = tavilyApiKey.trim();
      if (deepseek) {
        payload.deepseekApiKey = deepseek;
      }
      if (tavily) {
        payload.tavilyApiKey = tavily;
      }
      const response = await fetch("/api/runtime-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json: unknown = await response.json();
      if (!response.ok || !isRuntimeConfigStatus(json)) {
        const message =
          typeof json === "object" &&
          json !== null &&
          "error" in json &&
          typeof json.error === "string"
            ? json.error
            : "保存运行配置失败";
        throw new Error(message);
      }
      setDeepseekApiKey("");
      setTavilyApiKey("");
      setStatus(json);
      onContinue(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存运行配置失败");
    } finally {
      setSaving(false);
    }
  }

  function skipToReview() {
    setDeepseekApiKey("");
    setTavilyApiKey("");
    onContinue(status ?? missingRuntimeConfigStatus());
  }

  const current = status ?? missingRuntimeConfigStatus();

  return (
    <div className="input-shell" data-testid="runtime-setup">
      <header className="review-header">
        <Masthead />
      </header>
      <main className="input-main">
        <form
          className="input-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAndContinue();
          }}
        >
          <div className="input-intro">
            <h1>启动配置</h1>
            <p>
              仅支持 DeepSeek 审校与 Tavily 网页核验。密钥只保存在本机服务端会话内存中，不写磁盘、不进入日志、也不返回页面；关闭进程后失效。
            </p>
          </div>
          <ul className="runtime-capabilities" data-testid="runtime-capabilities">
            <li
              className={current.capabilities.real_review ? "is-on" : "is-off"}
              data-testid="capability-real-review"
            >
              真实审校
              {capabilityText(current.capabilities.real_review, "已启用", "未启用")}
              <span>{sourceLabel(current.deepseek.source)}</span>
            </li>
            <li
              className={current.capabilities.web_evidence ? "is-on" : "is-off"}
              data-testid="capability-web-evidence"
            >
              网页核验
              {capabilityText(current.capabilities.web_evidence, "已启用", "未启用")}
              <span>{sourceLabel(current.tavily.source)}</span>
            </li>
          </ul>
          <label className="field field-secret">
            <span className="field-label">
              DeepSeek API Key
              <em>{current.deepseek.configured ? "已配置，留空则保持" : "选填"}</em>
            </span>
            <input
              data-testid="deepseek-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={deepseekApiKey}
              onChange={(event) => setDeepseekApiKey(event.target.value)}
              disabled={loading || saving}
              placeholder={current.deepseek.configured ? "已配置" : "填写后默认开启真实审校"}
            />
          </label>
          <label className="field field-secret">
            <span className="field-label">
              Tavily API Key
              <em>{current.tavily.configured ? "已配置，留空则保持" : "选填"}</em>
            </span>
            <input
              data-testid="tavily-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tavilyApiKey}
              onChange={(event) => setTavilyApiKey(event.target.value)}
              disabled={loading || saving}
              placeholder={current.tavily.configured ? "已配置" : "填写后默认开启网页核验"}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert" data-testid="runtime-setup-error">
              {error}
            </p>
          ) : null}
          <p className="form-hint">
            未填写 DeepSeek Key 时使用离线审校；未填写 Tavily Key 时仅关闭网页核验。本地开发仍可使用
            .env.local。
          </p>
          <div className="form-footer">
            <button
              type="button"
              className="ghost-button"
              data-testid="runtime-skip"
              disabled={saving}
              onClick={skipToReview}
            >
              暂不配置，进入审校台
            </button>
            <button
              type="submit"
              className="primary-button"
              data-testid="runtime-save"
              disabled={loading || saving}
            >
              {saving ? "保存中…" : "保存并进入审校"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
