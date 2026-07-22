import { Box, Text } from "ink";
import type { QueueRecordHeader } from "@ward/sdk";

interface Props {
  rows: Array<{ execId: bigint; record: QueueRecordHeader }>;
  selectedIndex: number;
  now: bigint;
  sweepRunning: boolean;
  maxRows?: number;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortHex(value: string, start = 8): string {
  return `${value.slice(0, start)}…${value.slice(-4)}`;
}

function tierName(tier: number): string {
  if (tier === 1) return "DELAY";
  if (tier === 2) return "VETO";
  return "IMM";
}

function weiLabel(value: bigint): string {
  if (value === 0n) return "0";
  if (value < 1_000_000_000_000_000n) return `${value}w`;
  return `${Number(value / 1_000_000_000_000_000n) / 1000} STT`;
}

function overdueLabel(deadline: bigint, now: bigint): string {
  const overdueSec = now > deadline ? now - deadline : 0n;
  if (overdueSec === 0n) return "—";
  const s = Number(overdueSec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/**
 * Expirable-Now pane: rows where state==Pending AND now > deadline.
 * Operator presses [x] on the focused row to fire expireIfStale, or [s] to sweep all.
 */
export function ExpirablePane({ rows, selectedIndex, now, sweepRunning, maxRows }: Props) {
  const visible = rows.slice(0, maxRows ?? 8);
  const hidden = Math.max(0, rows.length - visible.length);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={rows.length > 0 ? "yellow" : "green"} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={rows.length > 0 ? "yellow" : "green"}>
          EXPIRABLE NOW
        </Text>
        <Text dimColor>
          {rows.length} ready · {sweepRunning ? "[s] sweeping…" : "[x] focused · [s] sweep"}
        </Text>
      </Box>
      {rows.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="green">No stale queue records.</Text>
          <Text dimColor>Expire actions are idle; live feed continues below.</Text>
        </Box>
      ) : (
        <>
          <Text dimColor>
            {"  "}exec     tier   overdue     selector    value     target      asker
          </Text>
          {visible.map(({ execId, record: r }, i) => {
          const focused = i === selectedIndex;
          return (
            <Box key={String(execId)}>
              <Text color={focused ? "black" : undefined} backgroundColor={focused ? "yellow" : undefined}>
                {focused ? "▶ " : "  "}
                {String(execId).padEnd(8, " ")}
                {tierName(r.tier).padEnd(7, " ")}
                {overdueLabel(r.deadline, now).padEnd(12, " ")}
                {shortHex(r.selector, 6).padEnd(12, " ")}
                {weiLabel(r.value).padEnd(10, " ")}
                {shortAddr(r.target).padEnd(12, " ")}
                {shortAddr(r.asker)}
              </Text>
            </Box>
          );
          })}
          {hidden > 0 && <Text dimColor>  +{hidden} more rows not shown</Text>}
        </>
      )}
    </Box>
  );
}
