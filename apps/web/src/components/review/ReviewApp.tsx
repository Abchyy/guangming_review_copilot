"use client";

import { useState } from "react";

import demoArticle from "../../../../../data/fixtures/demo-article.json";
import type { CreateReviewResponse } from "@grc/contracts";
import { createReviewResponseSchema } from "@grc/contracts";
import { DesktopReviewLayout } from "@/components/review/DesktopReviewLayout";

export function ReviewApp() {
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
        <div>
          <p className="eyebrow">Guangming Review Copilot</p>
          <h1>光明审校 Copilot</h1>
          <p className="lede">粘贴标题与正文，开始一次桌面审校工作流。</p>
        </div>
      </header>
      <form
        className="input-form"
        onSubmit={(event) => {
          event.preventDefault();
          void startReview();
        }}
      >
        <label className="field">
          <span>标题</span>
          <input
            data-testid="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>正文</span>
          <textarea
            data-testid="body-input"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            rows={18}
          />
        </label>
        {error ? (
          <p className="form-error" data-testid="review-error">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="start-review"
          className="primary-button"
          disabled={loading}
        >
          {loading ? "审校中…" : "开始审校"}
        </button>
      </form>
    </div>
  );
}
