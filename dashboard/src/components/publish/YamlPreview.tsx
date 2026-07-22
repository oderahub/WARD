import { Check as CheckIcon, X as XIcon } from "@phosphor-icons/react";
import type { CompileResult } from "../../hooks/usePolicyDraft";
import { Separator } from "../ui/separator";

interface Props {
  yamlText: string;
  result: CompileResult;
}

export function YamlPreview({ yamlText, result }: Props) {
  return (
    <div className="flex h-full flex-col">
      <Separator />
      <div className="flex items-baseline justify-between px-6 pt-4 pb-3 md:px-8">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          POLICY.md preview
        </h3>
        <StatusBadge result={result} />
      </div>

      <pre className="flex-1 overflow-auto whitespace-pre-wrap px-6 pb-6 font-mono text-[12px] leading-relaxed text-text md:px-8">
        {yamlText}
      </pre>
    </div>
  );
}

function StatusBadge({ result }: { result: CompileResult }) {
  if (result.ok) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-success">
        <CheckIcon size={11} weight="bold" /> compiles
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-danger">
      <XIcon size={11} weight="bold" /> {result.stage === "schema" ? "form errors" : "compile errors"}
    </span>
  );
}
