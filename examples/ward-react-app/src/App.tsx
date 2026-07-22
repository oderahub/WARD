import { useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
} from "wagmi";
import type { Address, Hex } from "viem";

import { GuardedBumpPanel } from "./GuardedBumpPanel.js";
import { SOMNIA_CHAIN_ID, somniaTestnet } from "./wagmi.js";

const DEFAULT_AGENT_ADDRESS: Address =
  "0x809F01268B718Ea6d17438b94190749159Eee311";

/** Minimal ABI for the WardAgentBase POLICY_ID() view. The agent's bound
 *  policy is read straight off the agent, so this page can never drift from
 *  what the agent actually enforces, and a rebind shows up with no manual paste. */
const POLICY_ID_ABI = [
  {
    type: "function",
    name: "POLICY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const ZERO_POLICY_ID: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

type PolicyState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "bound"; policyId: Hex }
  | { kind: "unbound" }
  | { kind: "error"; message: string };

export default function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: SOMNIA_CHAIN_ID });

  const [agentAddress, setAgentAddress] = useState<string>(DEFAULT_AGENT_ADDRESS);
  const [policy, setPolicy] = useState<PolicyState>({ kind: "idle" });
  // Bumped on tab focus so flipping back from the dashboard after a rebind
  // re-reads the agent's POLICY_ID without a manual page refresh.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const onFocus = () => setReloadKey((k) => k + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const onWrongChain = isConnected && chainId !== SOMNIA_CHAIN_ID;
  const agentOk = isAddress(agentAddress);

  // Read the agent's bound policyId on-chain whenever the address changes, so
  // the preflight always checks the policy the agent actually enforces.
  useEffect(() => {
    if (!publicClient || !isAddress(agentAddress)) {
      setPolicy({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setPolicy({ kind: "reading" });
    publicClient
      .readContract({
        address: agentAddress as Address,
        abi: POLICY_ID_ABI,
        functionName: "POLICY_ID",
      })
      .then((id) => {
        if (cancelled) return;
        const hex = id as Hex;
        setPolicy(
          hex === ZERO_POLICY_ID
            ? { kind: "unbound" }
            : { kind: "bound", policyId: hex },
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPolicy({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, agentAddress, reloadKey]);

  return (
    <main className="page">
      <header>
        <h1>Ward React demo</h1>
        <p className="lede">
          This page gates a CounterAgent.bump write with the Ward preflight
          hook. The same policy runs on chain; bypassing this UI still reverts at
          the contract layer.
        </p>
      </header>

      <section className="card">
        <h2>Wallet</h2>
        {!isConnected && (
          <div className="row">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                onClick={() => connect({ connector })}
                disabled={connectStatus === "pending"}
              >
                Connect {connector.name}
              </button>
            ))}
          </div>
        )}
        {isConnected && (
          <div className="row">
            <code>{address}</code>
            <button type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
        {onWrongChain && (
          <div className="warn">
            Wrong network. The demo expects Somnia Testnet (chain {SOMNIA_CHAIN_ID}).
            <button
              type="button"
              onClick={() => switchChain({ chainId: somniaTestnet.id })}
            >
              Switch network
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Target</h2>
        <label>
          Agent address
          <input
            value={agentAddress}
            onChange={(e) => setAgentAddress(e.target.value)}
            spellCheck={false}
          />
        </label>
        {!agentOk && <div className="warn">Agent address must be a 20-byte hex.</div>}

        <p style={{ marginTop: "0.75rem" }}>
          <strong>Policy ID</strong> — read from the agent on-chain:
        </p>
        {policy.kind === "reading" && <p>reading POLICY_ID()…</p>}
        {policy.kind === "bound" && <code>{policy.policyId}</code>}
        {policy.kind === "unbound" && (
          <div className="warn">
            POLICY_ID is zero — this agent has no policy bound and currently
            accepts every call.
          </div>
        )}
        {policy.kind === "error" && (
          <div className="warn">
            Could not read POLICY_ID from this address. Is it a WardAgentBase
            agent on Somnia? ({policy.message})
          </div>
        )}
      </section>

      <section className="card">
        <h2>Guarded write</h2>
        {!isConnected && <p>Connect a wallet to preflight and send.</p>}
        {isConnected && !publicClient && <p>Waiting for Somnia RPC client.</p>}
        {isConnected && publicClient && agentOk && policy.kind === "bound" && (
          <GuardedBumpPanel
            agentAddress={agentAddress as Address}
            policyId={policy.policyId}
            publicClient={publicClient}
          />
        )}
        {isConnected && publicClient && agentOk && policy.kind === "unbound" && (
          <p>Agent has no policy bound, so there is nothing to preflight.</p>
        )}
      </section>
    </main>
  );
}
