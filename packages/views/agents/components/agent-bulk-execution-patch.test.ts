// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildBulkExecutionPatch } from "./agent-bulk-execution-dialog";

/**
 * The bulk execution dialog's only non-UI logic: which fields end up in the
 * PATCH. Everything the user sees is a thin shell over this, so the two
 * regimes (runtime changed vs. untouched) are pinned here rather than through
 * three nested pickers.
 */
const none = {
  runtime: false,
  model: false,
  thinking: false,
  speed: false,
};

describe("buildBulkExecutionPatch", () => {
  it("returns an empty patch when nothing is enabled", () => {
    expect(
      buildBulkExecutionPatch({
        overrides: none,
        runtimeId: "",
        model: "",
        thinkingLevel: "",
        serviceTier: "",
      }),
    ).toEqual({});
  });

  it("sends only the opened field while the runtime is untouched", () => {
    expect(
      buildBulkExecutionPatch({
        overrides: { ...none, model: true },
        runtimeId: "",
        model: "claude-opus-5",
        thinkingLevel: "",
        serviceTier: "",
      }),
    ).toEqual({ model: "claude-opus-5" });
  });

  it("never sends runtime_id when the runtime checkbox is off", () => {
    // A runtime id present in the draft must not leak into the payload just
    // because a native field was enabled.
    const patch = buildBulkExecutionPatch({
      overrides: { ...none, model: true, thinking: true },
      runtimeId: "rt-should-not-travel",
      model: "m",
      thinkingLevel: "high",
      serviceTier: "",
    });
    expect(patch).toEqual({ model: "m", thinking_level: "high" });
    expect(patch.runtime_id).toBeUndefined();
  });

  it("writes all three native fields when the runtime changes", () => {
    const patch = buildBulkExecutionPatch({
      overrides: { ...none, runtime: true },
      runtimeId: "rt-new",
      model: "",
      thinkingLevel: "",
      serviceTier: "",
    });
    // Untouched natives are explicitly cleared in the SAME request, so the
    // agent never persists a token belonging to the previous runtime.
    expect(patch).toEqual({
      runtime_id: "rt-new",
      model: "",
      thinking_level: "",
      service_tier: "",
    });
  });

  it("keeps chosen values alongside the new runtime", () => {
    const patch = buildBulkExecutionPatch({
      overrides: { ...none, runtime: true, model: true, speed: true },
      runtimeId: "rt-new",
      model: "gpt-6-sol",
      thinkingLevel: "",
      serviceTier: "priority",
    });
    expect(patch).toEqual({
      runtime_id: "rt-new",
      model: "gpt-6-sol",
      // Thinking was not enabled → reset to the runtime default, not inherited.
      thinking_level: "",
      service_tier: "priority",
    });
  });

  it("ignores an enabled runtime with no runtime chosen yet", () => {
    // The dialog's Apply gate already blocks this; the builder stays
    // fail-safe so a race that clears the picker cannot emit `runtime_id: ""`.
    expect(
      buildBulkExecutionPatch({
        overrides: { ...none, runtime: true },
        runtimeId: "",
        model: "",
        thinkingLevel: "",
        serviceTier: "",
      }),
    ).toEqual({});
  });

  it("carries an explicit empty value as a real instruction", () => {
    // "" is meaningful for all three: runtime default (model / speed) and
    // "follow CLI config" (thinking). Enabling the field is the intent.
    expect(
      buildBulkExecutionPatch({
        overrides: { ...none, model: true, thinking: true, speed: true },
        runtimeId: "",
        model: "",
        thinkingLevel: "",
        serviceTier: "",
      }),
    ).toEqual({ model: "", thinking_level: "", service_tier: "" });
  });
});
