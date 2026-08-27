"use client";

import { useState } from "react";

import { ReviewApp } from "@/components/review/ReviewApp";
import { RuntimeSetup } from "@/components/review/RuntimeSetup";
import type { RuntimeConfigStatus } from "@/lib/runtime-config";

export function CopilotApp() {
  const [phase, setPhase] = useState<"setup" | "review">("setup");
  const [status, setStatus] = useState<RuntimeConfigStatus | null>(null);

  if (phase === "setup") {
    return (
      <RuntimeSetup
        onContinue={(next) => {
          setStatus(next);
          setPhase("review");
        }}
      />
    );
  }

  return (
    <ReviewApp
      runtimeStatus={status}
      onConfigureRuntime={() => setPhase("setup")}
    />
  );
}
