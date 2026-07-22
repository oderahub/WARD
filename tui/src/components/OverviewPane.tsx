import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { QueueRecordHeader, StoreEvent } from "@sentry-somnia/sdk";

interface Props {
  pending: QueueRecordHeader[];
  expirableCount: number;
  events: StoreEvent[];
  now: bigint;
  ready: boolean;
  progress: string;
  compact: boolean;
}

function bar(value: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function statusColor(expirableCount: number, ready: boolean): string {
  if (!ready) return "yellow";
  if (expirableCount > 0) return "red";
  return "green";
}

function recentQueueEvents(events: StoreEvent[]): number {
  return events.filter((e) => (
    e.type === "Enqueued" ||
    e.type === "Dispatched" ||
    e.type === "Vetoed" ||
    e.type === "Expired"
  )).length;
}

export function OverviewPane({ pending, expirableCount, events, now, ready, progress, compact }: Props) {
  const dispatchable = pending.filter((r) => now >= r.earliestCommitAt && now <= r.deadline).length;
  const soon = pending.filter((r) => r.deadline > now && r.deadline - now < 3600n).length;
  const queueEvents = recentQueueEvents(events);
  const total = Math.max(1, pending.length);
  const health = ready ? (expirableCount > 0 ? "ACTION" : "CLEAR") : "SYNC";
  const cardWidth = compact ? undefined : 22;

  return (
    <Box flexDirection={compact ? "column" : "row"} paddingX={1}>
      <MetricCard label="health" value={health} color={statusColor(expirableCount, ready)} width={cardWidth}>
        <Text dimColor>{ready ? "live queue tail" : progress}</Text>
      </MetricCard>
      <MetricCard label="pending" value={String(pending.length)} color="cyan" width={cardWidth}>
        <Text color="cyan">{bar(pending.length, total, 12)}</Text>
      </MetricCard>
      <MetricCard label="expirable" value={String(expirableCount)} color={expirableCount > 0 ? "yellow" : "green"} width={cardWidth}>
        <Text color={expirableCount > 0 ? "yellow" : "green"}>{bar(expirableCount, total, 12)}</Text>
      </MetricCard>
      <MetricCard label="dispatchable" value={String(dispatchable)} color={dispatchable > 0 ? "green" : "gray"} width={cardWidth}>
        <Text dimColor>soon {soon} · feed {queueEvents}</Text>
      </MetricCard>
    </Box>
  );
}

function MetricCard({ label, value, color, width, children }: {
  label: string;
  value: string;
  color: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width} flexGrow={width ? 0 : 1}>
      <Text dimColor>{label.toUpperCase()}</Text>
      <Text bold color={color}>{value}</Text>
      {children}
    </Box>
  );
}
