import { useState, type FormEvent } from "react";
import { BottomSheet } from "./bottom-sheet";
import { DRow, PrimaryButton, SecondaryButton } from "./ui";
import {
  editableAmount,
  validateProtectionDraft,
  type ProtectionDraft,
} from "@/lib/protection-draft";
import type { VaultState } from "@/lib/vault-store";

function initialDraft(state: VaultState): ProtectionDraft {
  return {
    firstSignerDaily: editableAmount(state.policy.firstSignerDaily),
    instantDaily: editableAmount(state.policy.instantDaily),
    basePerTxCap: editableAmount(state.policy.basePerTxCap),
    perTxCap: editableAmount(state.policy.perTxCap),
    delaySeconds: state.policy.delaySeconds.toString(),
    recipients: state.recipients.map((recipient) => recipient.address).join("\n"),
    firstSigner: "",
    secondSigner: "",
    frozen: state.frozen,
  };
}

function exactUsdc(value: bigint): string {
  const [whole, fraction = ""] = editableAmount(value).split(".");
  return `${whole}.${fraction.padEnd(2, "0")} USDC`;
}

/** Edits an unsigned draft only; the chain snapshot remains the displayed source of truth. */
export function ProtectionEditor({
  state,
  open,
  onOpenChange,
}: {
  state: VaultState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(state));
  const [review, setReview] = useState<ReturnType<typeof validateProtectionDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = (
    key: keyof Omit<ProtectionDraft, "frozen">,
    label: string,
    inputMode: "decimal" | "numeric" | "text" = "decimal",
  ) => (
    <label className="block space-y-1 text-sm" htmlFor={`protection-${key}`}>
      <span className="font-semibold">{label}</span>
      <input
        id={`protection-${key}`}
        value={draft[key]}
        inputMode={inputMode}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        className="w-full min-w-0 rounded-xl border border-input bg-card px-3 py-3"
      />
    </label>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      setReview(validateProtectionDraft(draft));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check your changes.");
    }
  };
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={review ? "Review protection changes" : "Edit protection"}
      description="Changes stay separate from your active settings until approved and confirmed onchain."
      footer={
        review ? (
          <SecondaryButton onClick={() => setReview(null)}>Back to editing</SecondaryButton>
        ) : (
          <PrimaryButton type="submit" form="protection-form">
            Review changes
          </PrimaryButton>
        )
      }
    >
      {review ? (
        <div className="space-y-4">
          <dl className="space-y-3 text-sm">
            <DRow k="First-signer daily limit" v={exactUsdc(review.firstSignerDaily)} />
            <DRow k="Instant daily limit" v={exactUsdc(review.instantDaily)} />
            <DRow k="First-signer maximum per transfer" v={exactUsdc(review.basePerTxCap)} />
            <DRow k="Second-signer maximum per transfer" v={exactUsdc(review.perTxCap)} />
            <DRow k="Waiting period" v={`${review.delaySeconds} seconds`} />
            <DRow k="Allowed recipients" v={review.recipients.join("\n")} />
            <DRow k="Replace first signer" v={review.firstSigner ?? "Keep current"} />
            <DRow k="Replace second signer" v={review.secondSigner ?? "Keep current"} />
            <DRow k="Account protection" v={review.frozen ? "Frozen" : "Unfrozen"} />
          </dl>
          <p className="rounded-xl bg-approval-soft p-3 text-sm text-approval-ink">
            Limit increases, recipient additions, signer replacements, unfreezing, and shorter
            waiting periods require the current onchain waiting period and both signers.
          </p>
          <p role="status" className="text-sm text-muted-foreground">
            Draft only — not applied. Applying protection changes requires the reviewed settings
            backend, which is not connected yet.
          </p>
        </div>
      ) : (
        <form id="protection-form" onSubmit={submit} className="space-y-5">
          <fieldset className="space-y-3">
            <legend className="mb-3 font-semibold">Spending limits</legend>
            {field("firstSignerDaily", "First-signer daily limit (USDC)")}
            {field("instantDaily", "Instant daily limit (USDC)")}
            {field("basePerTxCap", "First-signer maximum per transfer (USDC)")}
            {field("perTxCap", "Second-signer maximum per transfer (USDC)")}
            {field("delaySeconds", "Waiting period (seconds)", "numeric")}
          </fieldset>
          <label className="block space-y-1 text-sm" htmlFor="protection-recipients">
            <span className="font-semibold">Allowed recipients</span>
            <textarea
              id="protection-recipients"
              rows={3}
              value={draft.recipients}
              onChange={(event) => setDraft({ ...draft, recipients: event.target.value })}
              className="w-full rounded-xl border border-input bg-card px-3 py-3 font-mono text-xs"
            />
            <span className="block text-xs text-muted-foreground">
              One account address per line.
            </span>
          </label>
          <fieldset className="space-y-3">
            <legend className="mb-3 font-semibold">Approval devices</legend>
            <p className="text-xs text-muted-foreground">
              Leave blank to keep a signer. Replacements use the delayed signer-rotation path.
            </p>
            {field("firstSigner", "Replacement first signer address", "text")}
            {field("secondSigner", "Replacement second signer address", "text")}
          </fieldset>
          <label className="flex items-center gap-3 text-sm font-semibold">
            <input
              type="checkbox"
              checked={draft.frozen}
              onChange={(event) => setDraft({ ...draft, frozen: event.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
            Freeze account
          </label>
          <p className="text-xs text-muted-foreground">
            Freezing needs both signers. Unfreezing also requires the current waiting period.
          </p>
          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink">
              {error}
            </p>
          )}
        </form>
      )}
    </BottomSheet>
  );
}
