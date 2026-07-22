import { Box, Text } from "ink";
import type { StoreEvent } from "@ward/sdk";

interface Props {
  events: StoreEvent[];
  filter: EventFilter;
  maxRows?: number;
}

export type EventFilter = "all" | "enqueued" | "dispatched" | "vetoed" | "expired";

function colorFor(t: StoreEvent["type"]): string | undefined {
  switch (t) {
    case "Enqueued": return "green";
    case "Dispatched": return "cyan";
    case "Vetoed": return "red";
    case "Expired": return "gray";
    case "PolicyPublished":
    case "PolicyUpdated": return "magenta";
    case "OwnershipTransferStarted":
    case "OwnershipTransferred":
    case "OwnershipTransferCancelled": return "yellow";
  }
}

function markerFor(t: StoreEvent["type"]): string {
  switch (t) {
    case "Enqueued": return "●";
    case "Dispatched": return "◆";
    case "Vetoed": return "×";
    case "Expired": return "□";
    case "PolicyPublished": return "+";
    case "PolicyUpdated": return "↻";
    case "OwnershipTransferStarted": return "→";
    case "OwnershipTransferred": return "✓";
    case "OwnershipTransferCancelled": return "−";
  }
}

function shortHex(h: string, n = 10): string {
  return h.length > n + 2 ? `${h.slice(0, n)}…` : h;
}

function describe(e: StoreEvent): string {
  switch (e.type) {
    case "Enqueued":
      return `pol ${shortHex(e.policyId)} asker ${shortHex(e.asker ?? "0x")} tier=${e.tier}`;
    case "Dispatched":
      return `pol ${shortHex(e.policyId)} by ${shortHex(e.dispatcher ?? "0x")}`;
    case "Vetoed":
      return `pol ${shortHex(e.policyId)} reason=${e.reason?.slice(0, 18) ?? "0x"}…`;
    case "Expired":
      return `pol ${shortHex(e.policyId)}`;
    case "PolicyPublished":
      return `owner ${shortHex(e.owner)} label ${shortHex(e.label ?? "0x")}`;
    case "PolicyUpdated":
      return `owner ${shortHex(e.owner)}`;
    case "OwnershipTransferStarted":
      return `pol ${shortHex(e.policyId)} pending ${shortHex(e.pendingOwner)}`;
    case "OwnershipTransferred":
      return `pol ${shortHex(e.policyId)} → ${shortHex(e.newOwner)}`;
    case "OwnershipTransferCancelled":
      return `pol ${shortHex(e.policyId)} cancelled ${shortHex(e.cancelledNominee)}`;
  }
}

function execIdOf(e: StoreEvent): string {
  if ("execId" in e && e.execId !== undefined) return `#${e.execId}`;
  if ("policyId" in e && e.policyId) return `pol ${shortHex(e.policyId, 8)}`;
  return "—";
}

function passesFilter(e: StoreEvent, f: EventFilter): boolean {
  if (f === "all") return true;
  if (f === "enqueued") return e.type === "Enqueued";
  if (f === "dispatched") return e.type === "Dispatched";
  if (f === "vetoed") return e.type === "Vetoed";
  if (f === "expired") return e.type === "Expired";
  return true;
}

/**
 * Live events pane — chronological tail (newest at bottom). Filter via
 * letter keys: [a]ll [e]nqueued [d]ispatched [v]etoed [x]pired (handled by App).
 */
export function LiveEventsPane({ events, filter, maxRows = 12 }: Props) {
  const filtered = events.filter((e) => passesFilter(e, filter));
  const last = filtered.slice(-maxRows);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold color="magenta">LIVE EVENTS</Text>
        <FilterTabs active={filter} />
      </Box>
      {last.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text dimColor>No matching events yet.</Text>
          <Text dimColor>Use [a/e/d/v/r] to switch filters.</Text>
        </Box>
      ) : (
        last.map((e, i) => (
          <Box key={i}>
            <Text color={colorFor(e.type)}>{markerFor(e.type)} </Text>
            <Text dimColor>{String(e.blockNumber).padStart(10, " ")} </Text>
            <Text color={colorFor(e.type)}>{e.type.padEnd(24, " ")}</Text>
            <Text> {execIdOf(e).padEnd(12, " ")}</Text>
            <Text dimColor>{describe(e)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function FilterTabs({ active }: { active: EventFilter }) {
  const tabs: Array<[EventFilter, string]> = [
    ["all", "a all"],
    ["enqueued", "e enq"],
    ["dispatched", "d disp"],
    ["vetoed", "v veto"],
    ["expired", "r exp"],
  ];
  return (
    <Text>
      {tabs.map(([key, label], i) => (
        <Text key={key} color={active === key ? "black" : "gray"} backgroundColor={active === key ? "magenta" : undefined}>
          {i > 0 ? " " : ""}{label}
        </Text>
      ))}
    </Text>
  );
}
