import { Box, Text } from "ink";
import type { QueueRecordHeader } from "@ward/sdk";

interface Props {
  pending: QueueRecordHeader[];
  now: bigint;
}

interface Buckets {
  overdue: number;
  underHour: number;
  underDay: number;
  underWeek: number;
  total: number;
}

function bucketize(rows: QueueRecordHeader[], now: bigint): Buckets {
  let overdue = 0, underHour = 0, underDay = 0, underWeek = 0;
  for (const r of rows) {
    if (now > r.deadline) {
      overdue++;
    } else {
      const remaining = r.deadline - now;
      if (remaining < 3600n) underHour++;
      else if (remaining < 86400n) underDay++;
      else underWeek++;
    }
  }
  return { overdue, underHour, underDay, underWeek, total: rows.length };
}

function bar(count: number, total: number): string {
  const width = 24;
  const filled = total > 0 ? Math.round((count / total) * width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * Aging summary pane — one-line count of pending intents bucketed by
 * time-to-deadline. Operator at-a-glance health signal.
 */
export function AgingPane({ pending, now }: Props) {
  const b = bucketize(pending, now);
  const total = Math.max(1, b.total);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">AGING PENDING</Text>
        <Text dimColor>total {b.total}</Text>
      </Box>
      <Bucket label="overdue" count={b.overdue} total={total} color={b.overdue > 0 ? "yellow" : "green"} />
      <Bucket label="<1h" count={b.underHour} total={total} color="cyan" />
      <Bucket label="<1d" count={b.underDay} total={total} color="blue" />
      <Bucket label="<7d" count={b.underWeek} total={total} color="gray" />
    </Box>
  );
}

function Bucket({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  return (
    <Text>
      {label.padEnd(8, " ")} <Text color={color}>{bar(count, total)}</Text> <Text bold>{String(count).padStart(3, " ")}</Text>
    </Text>
  );
}
