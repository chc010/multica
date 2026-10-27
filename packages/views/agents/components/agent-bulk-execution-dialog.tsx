"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
import type {
  AgentRuntime,
  MemberWithUser,
  RuntimeModel,
} from "@multica/core/types";
import { runtimeModelsOptions } from "@multica/core/runtimes";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { findModelCapabilityEntry } from "./inspector/model-capability";
import { ModelPicker } from "./inspector/model-picker";
import { RuntimePicker } from "./inspector/runtime-picker";
import { ServiceTierPicker } from "./inspector/service-tier-setting-field";
import { ThinkingPicker } from "./inspector/thinking-picker";

/**
 * Execution-config patch applied to every selected agent by the bulk dialog.
 *
 * Field presence mirrors the inspector's runtime change: switching the runtime
 * is the one operation that must rewrite model / thinking / speed, because
 * those tokens are runtime-native and a foreign value would be rejected or
 * silently dropped by the new CLI. Choosing "keep existing" on any of the
 * three therefore only makes sense while the runtime itself is untouched.
 */
export type BulkExecutionPatch = {
  runtime_id?: string;
  model?: string;
  thinking_level?: string;
  service_tier?: string;
};

type OverrideKey = "runtime" | "model" | "thinking" | "speed";

/**
 * Builds the PATCH body for the bulk execution write.
 *
 * Two regimes, and the difference matters:
 *
 * - **Runtime changes.** Model / thinking / speed are runtime-native tokens, so
 *   they are ALL rewritten in the same request: to the chosen value, or to `""`
 *   (runtime default) when left untouched. Sending the new runtime alone would
 *   leave a foreign model behind, and a follow-up write would open a window
 *   where the agent persists a combination the caller never intended.
 * - **Runtime untouched.** Only the fields the caller explicitly enabled
 *   travel. Everything else keeps each agent's own value — that is what makes
 *   "align just the model across these agents" possible without collateral
 *   damage to their thinking / speed / runtime settings.
 *
 * Exported as a pure function so the payload shape is unit-testable without
 * driving three nested pickers through the DOM.
 */
export function buildBulkExecutionPatch(input: {
  overrides: Record<OverrideKey, boolean>;
  runtimeId: string;
  model: string;
  thinkingLevel: string;
  serviceTier: string;
}): BulkExecutionPatch {
  const { overrides } = input;
  const patch: BulkExecutionPatch = {};

  if (overrides.runtime && input.runtimeId !== "") {
    patch.runtime_id = input.runtimeId;
    patch.model = overrides.model ? input.model : "";
    patch.thinking_level = overrides.thinking ? input.thinkingLevel : "";
    patch.service_tier = overrides.speed ? input.serviceTier : "";
    return patch;
  }

  if (overrides.model) patch.model = input.model;
  if (overrides.thinking) patch.thinking_level = input.thinkingLevel;
  if (overrides.speed) patch.service_tier = input.serviceTier;
  return patch;
}

/**
 * Bulk "set execution config" dialog for the agents list.
 *
 * The dialog is draft-first: nothing is written until Confirm, and each field
 * is opt-in through its own checkbox so an untouched field keeps whatever the
 * agent already had. Runtime is the anchor — the model catalog and the
 * per-model thinking / speed catalogs are all runtime-native, so those three
 * pickers stay disabled until a runtime is chosen.
 */
export function AgentBulkExecutionDialog({
  open,
  onOpenChange,
  agentCount,
  skippedCount,
  sharedRuntimeId,
  runtimes,
  members,
  currentUserId,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agents the patch will be written to (owned or admin-managed). */
  agentCount: number;
  /** Selected agents skipped because the caller cannot manage them. */
  skippedCount: number;
  /**
   * The runtime every manageable selected agent is already on, or `""` when
   * they disagree. Lets the model / thinking / speed pickers work without
   * forcing the caller to also overwrite the runtime — the common case of
   * "same engine, just align the model" needs no runtime write at all.
   */
  sharedRuntimeId: string;
  runtimes: AgentRuntime[];
  members: MemberWithUser[];
  currentUserId: string | null;
  busy: boolean;
  onConfirm: (patch: BulkExecutionPatch) => Promise<void> | void;
}) {
  const { t } = useT("agents");

  const [overrides, setOverrides] = useState<Record<OverrideKey, boolean>>({
    runtime: false,
    model: false,
    thinking: false,
    speed: false,
  });
  const [runtimeId, setRuntimeId] = useState("");
  const [model, setModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [serviceTier, setServiceTier] = useState("");

  const runtimePicked = overrides.runtime && runtimeId !== "";
  // Catalog source: the runtime being written, or — when only native fields
  // are touched — the one the selection already shares.
  const catalogRuntimeId = runtimePicked ? runtimeId : sharedRuntimeId;
  const runtime = useMemo(
    () => runtimes.find((candidate) => candidate.id === catalogRuntimeId) ?? null,
    [runtimes, catalogRuntimeId],
  );
  const provider = runtime?.provider ?? "";
  const runtimeOnline = runtime?.status === "online";
  const hasCatalogSource = catalogRuntimeId !== "";

  // One catalog query backs all three runtime-native pickers, hitting the same
  // 60s cache the inspector uses — no extra round trip per field.
  const modelsQuery = useQuery(
    runtimeModelsOptions(runtimeOnline ? catalogRuntimeId : null),
  );
  const catalog = useMemo<RuntimeModel[]>(
    () => modelsQuery.data?.models ?? [],
    [modelsQuery.data],
  );
  const capability = useMemo(
    () => findModelCapabilityEntry(catalog, model, provider),
    [catalog, model, provider],
  );
  // Empty model means "follow the runtime's own default". For codex and omp
  // that default is resolved on the daemon host and can be any installed
  // model, so previewing a catalog entry's effort levels would offer levels
  // the real model may not support. Fail closed, exactly like the inspector.
  const thinkingLevels = useMemo(() => {
    if (!model && (provider === "codex" || provider === "omp")) return [];
    const entry = capability ?? catalog.find((m) => m.default) ?? catalog[0];
    return entry?.thinking?.supported_levels ?? [];
  }, [capability, catalog, model, provider]);

  const tiers = capability?.service_tiers ?? [];
  const supportsExplicitStandard = useMemo(
    () => catalog.some((m) => m.supports_explicit_standard_service_tier === true),
    [catalog],
  );

  const reset = () => {
    setOverrides({ runtime: false, model: false, thinking: false, speed: false });
    setRuntimeId("");
    setModel("");
    setThinkingLevel("");
    setServiceTier("");
  };

  const setOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const toggle = (key: OverrideKey) => {
    setOverrides((previous) => {
      const next = { ...previous, [key]: !previous[key] };
      // Runtime drives the three native pickers; clearing it must take their
      // overrides with it or the dialog would submit orphan tokens that the
      // server validates against a runtime the caller never chose.
      if (key === "runtime" && !next.runtime) {
        next.model = false;
        next.thinking = false;
        next.speed = false;
        setModel("");
        setThinkingLevel("");
        setServiceTier("");
      }
      return next;
    });
  };

  // Enabling a field is itself the intent to write it: an empty value is a
  // real instruction ("runtime default" for model / speed, "follow CLI
  // config" for thinking), not "nothing to do". So presence of the checkbox
  // — not the value — decides whether the form is dirty.
  const dirty =
    runtimePicked || overrides.model || overrides.thinking || overrides.speed;

  const buildPatch = (): BulkExecutionPatch =>
    buildBulkExecutionPatch({
      overrides,
      runtimeId,
      model,
      thinkingLevel,
      serviceTier,
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="sm:max-w-lg"
        aria-describedby="bulk-execution-summary"
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => $.row_actions.bulk_config_dialog_title)}
          </DialogTitle>
          <DialogDescription id="bulk-execution-summary">
            <span aria-live="polite">
              {t(($) => $.row_actions.bulk_config_applies_to, {
                count: agentCount,
              })}
              {skippedCount > 0
                ? ` ${t(($) => $.row_actions.bulk_config_skipped, {
                    count: skippedCount,
                  })}`
                : ""}
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Overwrite notice: the whole point of a bulk write is that it wins
            over each agent's own configuration, so say it before the form. */}
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-caption leading-5 text-muted-foreground">
          <TriangleAlert
            className="mt-0.5 size-3.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>{t(($) => $.row_actions.bulk_config_overwrite_warning)}</span>
        </div>

        <div className="divide-y divide-surface-border">
          <BulkField
            label={t(($) => $.inspector.prop_runtime)}
            checked={overrides.runtime}
            disabled={busy}
            onToggle={() => toggle("runtime")}
          >
            <RuntimePicker
              variant="field"
              showLabel={false}
              value={runtimeId}
              runtimes={runtimes}
              members={members}
              currentUserId={currentUserId}
              canEdit={!busy}
              onChange={(id) => setRuntimeId(id)}
            />
          </BulkField>

          <BulkField
            label={t(($) => $.inspector.prop_model)}
            checked={overrides.model}
            disabled={busy || !hasCatalogSource}
            disabledHint={t(($) => $.row_actions.bulk_config_need_runtime)}
            onToggle={() => toggle("model")}
          >
            <ModelPicker
              variant="field"
              showLabel={false}
              runtimeId={hasCatalogSource ? catalogRuntimeId : null}
              runtimeOnline={runtimeOnline}
              value={model}
              canEdit={!busy && hasCatalogSource}
              onChange={(next) => setModel(next)}
            />
          </BulkField>

          <BulkField
            label={t(($) => $.inspector.prop_thinking)}
            checked={overrides.thinking}
            disabled={busy || !hasCatalogSource || thinkingLevels.length === 0}
            disabledHint={t(($) => $.row_actions.bulk_config_need_runtime)}
            onToggle={() => toggle("thinking")}
          >
            <ThinkingPicker
              variant="field"
              showLabel={false}
              value={thinkingLevel}
              levels={thinkingLevels}
              canEdit={!busy && hasCatalogSource && thinkingLevels.length > 0}
              onChange={(next) => setThinkingLevel(next)}
            />
          </BulkField>

          <BulkField
            label={t(($) => $.inspector.prop_speed)}
            checked={overrides.speed}
            disabled={
              busy ||
              !hasCatalogSource ||
              (tiers.length === 0 && !supportsExplicitStandard)
            }
            disabledHint={t(($) => $.row_actions.bulk_config_need_runtime)}
            onToggle={() => toggle("speed")}
          >
            <ServiceTierPicker
              value={serviceTier}
              tiers={tiers}
              supportsExplicitStandard={supportsExplicitStandard}
              canEdit={
                !busy &&
                hasCatalogSource &&
                (tiers.length > 0 || supportsExplicitStandard)
              }
              onChange={(next) => setServiceTier(next)}
            />
          </BulkField>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            {t(($) => $.row_actions.archive_dialog_cancel)}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !dirty || (overrides.runtime && runtimeId === "")}
            onClick={async () => {
              const patch = buildPatch();
              setOpen(false);
              await onConfirm(patch);
            }}
          >
            {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
            {t(($) => $.row_actions.bulk_config_confirm)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One opt-in row of the bulk form. The checkbox is the only thing that decides
 * whether the field travels in the PATCH — an untouched picker never writes.
 */
function BulkField({
  label,
  checked,
  disabled,
  disabledHint,
  onToggle,
  children,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  disabledHint?: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <label className="flex min-w-0 items-center gap-2">
        {/* The wrapping <label> owns the accessible name; adding aria-label
            here would concatenate and yield "Model Model". */}
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
        />
        <span className="min-w-0 truncate text-body font-medium">{label}</span>
      </label>
      <div className="min-w-0 sm:w-[56%] sm:shrink-0">
        <div
          className={
            checked && !disabled ? "" : "pointer-events-none opacity-50"
          }
        >
          {children}
        </div>
        {disabled && disabledHint ? (
          <p className="mt-1 text-micro text-muted-foreground">{disabledHint}</p>
        ) : null}
      </div>
    </div>
  );
}
