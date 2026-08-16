import { describe, expect, test } from "vitest";

import { canonicalize } from "@/lib/server/normalization";

describe("canonicalization", () => {
  test("converts CRLF and CR to LF only", () => {
    expect(canonicalize("甲\r\n乙\r丙")).toBe("甲\n乙\n丙");
  });

  test("does not trim or alter CJK punctuation", () => {
    const raw = "  他说：“好的。”  ";
    expect(canonicalize(raw)).toBe(raw);
  });
});
