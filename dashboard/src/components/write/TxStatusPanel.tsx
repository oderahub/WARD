import { motion } from "framer-motion";
import { type Hex } from "viem";

import { Alert, ExplorerLink } from "../primitives";
import { Spinner } from "./Spinner";

export type TxState =
  | { kind: "idle" }
  | { kind: "awaiting-signature" }
  | { kind: "broadcasting"; hash: Hex }
  | { kind: "mining"; hash: Hex }
  | { kind: "mined"; hash: Hex; ok: boolean }
  | { kind: "error"; message: string; raw?: string };

interface Props {
  tx: TxState;
  miningVerb: string;
}

export function TxStatusPanel({ tx, miningVerb }: Props) {
  return (
    <>
      {tx.kind === "error" && (
        <Alert variant="danger" title={tx.message} className="mt-3">
          {tx.raw && (
            <details>
              <summary className="cursor-pointer text-text-muted hover:text-text">
                Show raw error
              </summary>
              <div className="mt-1 break-all font-mono text-[11px] text-text-muted">
                {tx.raw}
              </div>
            </details>
          )}
        </Alert>
      )}
      {tx.kind === "mining" && (
        <div className="mt-3 rounded-md border border-ward-border bg-surface p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Mining {miningVerb}…</span>
            <ExplorerLink txHash={tx.hash} />
          </div>
          <div className="mt-1 break-all font-mono text-text">{tx.hash}</div>
          <div className="mt-1 inline-flex items-center gap-1.5 text-text-muted">
            <Spinner />
            <span>Waiting for the event-store to pick up the confirmation…</span>
          </div>
        </div>
      )}
      {tx.kind === "mined" && (
        <div className="mt-3 rounded-md border border-ward-border bg-surface p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">
              Confirmed{" "}
              <motion.span
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 18 }}
                className={
                  tx.ok
                    ? "ml-1 inline-block rounded-full bg-success/20 px-2 py-0.5 text-success"
                    : "ml-1 inline-block rounded-full bg-danger/20 px-2 py-0.5 text-danger"
                }
              >
                {tx.ok ? "success" : "reverted"}
              </motion.span>
            </span>
            <ExplorerLink txHash={tx.hash} />
          </div>
          <div className="mt-1 break-all font-mono text-text">{tx.hash}</div>
          <div className="mt-1 text-text-muted">
            The Ward event-store will surface this in the queue shortly.
          </div>
        </div>
      )}
    </>
  );
}
