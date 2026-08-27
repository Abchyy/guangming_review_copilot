import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CopilotApp } from "@/components/review/CopilotApp";
import { RuntimeSetup } from "@/components/review/RuntimeSetup";
import {
  missingRuntimeConfigStatus,
  type RuntimeConfigStatus,
} from "@/lib/runtime-config";

const ENABLED_STATUS: RuntimeConfigStatus = {
  deepseek: { configured: true, source: "session" },
  tavily: { configured: true, source: "session" },
  capabilities: { real_review: true, web_evidence: true },
};

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime setup UI", () => {
  test("renders DeepSeek and Tavily fields only, with disabled capabilities by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(missingRuntimeConfigStatus())),
    );
    render(<RuntimeSetup onContinue={() => undefined} />);
    expect(await screen.findByTestId("runtime-setup")).toBeTruthy();
    expect(screen.getByTestId("deepseek-key-input")).toBeTruthy();
    expect(screen.getByTestId("tavily-key-input")).toBeTruthy();
    expect(screen.queryByLabelText(/openai/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/openai/i);
    expect(screen.getByTestId("capability-real-review").textContent).toContain("未启用");
    expect(screen.getByTestId("capability-web-evidence").textContent).toContain("未启用");
  });

  test("saving keys posts them and does not echo them in the UI", async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return jsonResponse(ENABLED_STATUS);
        }
        return jsonResponse(missingRuntimeConfigStatus());
      }),
    );
    let continued: RuntimeConfigStatus | null = null;
    render(
      <RuntimeSetup
        onContinue={(status) => {
          continued = status;
        }}
      />,
    );
    await screen.findByTestId("runtime-setup");
    await user.type(screen.getByTestId("deepseek-key-input"), "sk-ui-secret-deepseek");
    await user.type(screen.getByTestId("tavily-key-input"), "tvly-ui-secret-tavily");
    await user.click(screen.getByTestId("runtime-save"));
    expect(posted).toEqual([
      {
        deepseekApiKey: "sk-ui-secret-deepseek",
        tavilyApiKey: "tvly-ui-secret-tavily",
      },
    ]);
    expect(continued).toEqual(ENABLED_STATUS);
    expect((screen.getByTestId("deepseek-key-input") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("tavily-key-input") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("sk-ui-secret-deepseek");
    expect(document.body.textContent).not.toContain("tvly-ui-secret-tavily");
  });

  test("skip continues without posting typed keys", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").not.toBe("POST");
      return jsonResponse(missingRuntimeConfigStatus());
    });
    vi.stubGlobal("fetch", fetchMock);
    const onContinue = vi.fn();
    render(<RuntimeSetup onContinue={onContinue} />);
    await screen.findByTestId("capability-real-review");
    await user.type(screen.getByTestId("deepseek-key-input"), "sk-should-not-post");
    await user.click(screen.getByTestId("runtime-skip"));
    expect(onContinue).toHaveBeenCalledWith(missingRuntimeConfigStatus());
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});

describe("startup configuration flow", () => {
  test("the app starts on the setup page and can enter the review desk", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(missingRuntimeConfigStatus())),
    );
    render(<CopilotApp />);
    expect(await screen.findByTestId("runtime-setup")).toBeTruthy();
    expect(screen.queryByTestId("article-input")).toBeNull();
    await user.click(screen.getByTestId("runtime-skip"));
    expect(screen.getByTestId("article-input")).toBeTruthy();
    expect(screen.getByTestId("runtime-capability-summary").textContent).toContain(
      "真实审校未启用",
    );
    expect(screen.getByTestId("runtime-capability-summary").textContent).toContain(
      "网页核验未启用",
    );
    await user.click(screen.getByTestId("open-runtime-setup"));
    expect(screen.getByTestId("runtime-setup")).toBeTruthy();
  });

  test("saving keys enables capabilities on the review desk without showing secrets", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return jsonResponse(ENABLED_STATUS);
        }
        return jsonResponse(missingRuntimeConfigStatus());
      }),
    );
    render(<CopilotApp />);
    await screen.findByTestId("runtime-setup");
    await user.type(screen.getByTestId("deepseek-key-input"), "sk-ui-secret-deepseek");
    await user.click(screen.getByTestId("runtime-save"));
    expect(await screen.findByTestId("article-input")).toBeTruthy();
    expect(screen.getByTestId("runtime-capability-summary").textContent).toContain(
      "真实审校已启用",
    );
    expect(screen.getByTestId("runtime-capability-summary").textContent).toContain(
      "网页核验已启用",
    );
    expect(document.body.textContent).not.toContain("sk-ui-secret-deepseek");
  });
});
