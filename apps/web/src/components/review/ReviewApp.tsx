"use client";

import { useState } from "react";

import demoArticle from "../../../../../data/fixtures/demo-article.json";
import type { CreateReviewResponse } from "@grc/contracts";
import { createReviewResponseSchema } from "@grc/contracts";
import { DesktopReviewLayout } from "@/components/review/DesktopReviewLayout";
import { Masthead } from "@/components/review/Masthead";
import type { RuntimeConfigStatus } from "@/lib/runtime-config";

export function ReviewApp({
  runtimeStatus,
  onConfigureRuntime,
}: {
  runtimeStatus?: RuntimeConfigStatus | null;
  onConfigureRuntime?: () => void;
} = {}) {
  const [title, setTitle] = useState(demoArticle.title);
  const [body, setBody] = useState(demoArticle.body);
  const [review, setReview] = useState<CreateReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function startReview() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof json === "object" &&
          json !== null &&
          "error" in json &&
          typeof json.error === "string"
            ? json.error
            : "审校失败";
        throw new Error(message);
      }
      setReview(createReviewResponseSchema.parse(json));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "审校失败");
    } finally {
      setLoading(false);
    }
  }

  if (review) {
    return (
      <DesktopReviewLayout
        review={review}
        onReviewChange={setReview}
        onReset={() => setReview(null)}
      />
    );
  }

  return (
    <div className="input-shell" data-testid="article-input">
      <header className="review-header">
        <Masthead />
        {onConfigureRuntime ? (
          <div className="review-header-meta">
            {runtimeStatus ? (
              <p className="pipeline-meta" data-testid="runtime-capability-summary">
                真实审校{runtimeStatus.capabilities.real_review ? "已启用" : "未启用"}
                {" · "}
                网页核验{runtimeStatus.capabilities.web_evidence ? "已启用" : "未启用"}
              </p>
            ) : null}
            <button
              type="button"
              className="ghost-button"
              data-testid="open-runtime-setup"
              onClick={onConfigureRuntime}
            >
              运行配置
            </button>
          </div>
        ) : null}
      </header>
      <main className="input-main">
        <form
          className="input-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startReview();
          }}
        >
          <div className="input-intro">
            <h1>稿件审校台</h1>
            <p>
              粘贴标题与正文，系统将结合文字规范、文内一致性与权威语料给出审校意见。
              审校结论仅供编辑参考，最终由人工确认。
            </p>
          </div>
          <label className="field">
            <span className="field-label">
              标题<em>必填</em>
            </span>
            <input
              data-testid="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={loading}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">
              正文<em>必填</em>
              <span className="field-count" data-testid="body-count">
                {body.length} 字
              </span>
            </span>
            <textarea
              data-testid="body-input"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={loading}
              required
              rows={14}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert" data-testid="review-error">
              {error}
            </p>
          ) : null}
          <div className="form-footer">
            <p className="form-hint">
              {loading
                ? "正在比对文字规范与权威语料，通常需要数秒…"
                : "支持消息稿、通讯、评论等中文新闻体裁。"}
            </p>
            <button
              type="submit"
              data-testid="start-review"
              className="primary-button"
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="button-spinner" aria-hidden="true" />
                  审校中…
                </>
              ) : (
                "开始审校"
              )}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
