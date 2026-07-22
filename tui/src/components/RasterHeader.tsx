import { Box, Text } from "ink";

interface Props {
  columns: number;
  ready: boolean;
  progress: string;
  cursor: bigint;
  walletInfo: string;
  oracleInfo: string;
  queueInfo: string;
  rpcHost: string;
  pendingCount: number;
  expirableCount: number;
  eventCount: number;
  compact: boolean;
  errorMsg: string | null;
}

const LOGO_LINES = [
  "██████ █████ █   █ █████ ████  █   █",
  "█      █     ██  █   █   █   █  █ █ ",
  "████   ███   █ █ █   █   ████    █  ",
  "    █  █     █  ██   █   █  █    █  ",
  "█████  █████ █   █   █   █   █   █  ",
];

function statusColor(ready: boolean, expirableCount: number, errorMsg: string | null): string {
  if (errorMsg) return "red";
  if (!ready) return "yellow";
  if (expirableCount > 0) return "yellow";
  return "green";
}

function statusLabel(ready: boolean, expirableCount: number, errorMsg: string | null): string {
  if (errorMsg) return "FAULT";
  if (!ready) return "SYNCING";
  if (expirableCount > 0) return "ACTION";
  return "LIVE";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function meter(value: number, max: number, width: number): string {
  const filled = max > 0 ? clamp(Math.round((value / max) * width), 0, width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function rasterRows(width: number, height: number, props: Props): string[] {
  const seed =
    Number(props.cursor % 997n) +
    props.pendingCount * 17 +
    props.expirableCount * 43 +
    props.eventCount * 7;
  const palette = props.expirableCount > 0 ? ["░", "▒", "▓", "█"] : ["·", "░", "▒", "▓"];
  const hotColumns = clamp(props.expirableCount * 2, 0, width);
  const activityColumns = clamp(Math.ceil(props.eventCount / 3), 0, width);

  return Array.from({ length: height }, (_, y) => {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const pulse = (x * 13 + y * 17 + seed) % 31;
      const diagonal = (x + y * 4 + seed) % 19;
      const hot = props.expirableCount > 0 && x < hotColumns && (y + x) % 3 !== 0;
      const active = x >= width - activityColumns && pulse % 2 === 0;
      const index = hot ? 3 : active ? 2 : diagonal < 3 ? 2 : pulse < 8 ? 1 : 0;
      line += palette[index];
    }
    return line;
  });
}

export function RasterHeader(props: Props) {
  const color = statusColor(props.ready, props.expirableCount, props.errorMsg);
  const label = statusLabel(props.ready, props.expirableCount, props.errorMsg);
  const total = Math.max(1, props.pendingCount + props.expirableCount + Math.ceil(props.eventCount / 5));
  const scopeWidth = props.compact ? clamp(props.columns - 6, 28, 54) : 42;
  const scopeHeight = props.compact ? 3 : 5;
  const scan = rasterRows(scopeWidth, scopeHeight, props);

  return (
    <Box borderStyle="double" borderColor={color} paddingX={1} flexDirection={props.compact ? "column" : "row"}>
      <Box flexDirection="column" width={props.compact ? undefined : 42}>
        {props.compact ? (
          <Text bold color={color}>WARD / SOMNIA OPS</Text>
        ) : (
          LOGO_LINES.map((line) => (
            <Text key={line} color={color}>{line}</Text>
          ))
        )}
        <Text dimColor>agent policy command surface</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between">
          <Text bold color={color}>{label}</Text>
          <Text dimColor>
            block <Text color="white">{String(props.cursor)}</Text>
          </Text>
        </Box>

        <Box flexDirection={props.compact ? "column" : "row"}>
          <Box flexDirection="column">
            {scan.map((line, i) => (
              <Text key={`${i}-${line}`} color={color}>{line}</Text>
            ))}
          </Box>

          <Box flexDirection="column" marginLeft={props.compact ? 0 : 2} flexGrow={1}>
            <StatusLine
              label="pending"
              value={props.pendingCount}
              color="cyan"
              fill={meter(props.pendingCount, total, 14)}
            />
            <StatusLine
              label="expired"
              value={props.expirableCount}
              color={props.expirableCount > 0 ? "yellow" : "green"}
              fill={meter(props.expirableCount, total, 14)}
            />
            <StatusLine
              label="events"
              value={props.eventCount}
              color="magenta"
              fill={meter(Math.min(props.eventCount, total), total, 14)}
            />
            <Text dimColor>
              sync <Text color="white">{props.ready ? "live" : props.progress}</Text>
            </Text>
          </Box>
        </Box>

        <Box flexDirection={props.compact ? "column" : "row"} justifyContent="space-between">
          <Text dimColor>
            oracle <Text color="white">{props.oracleInfo}</Text>
            {"  "}queue <Text color="white">{props.queueInfo}</Text>
          </Text>
          <Text dimColor>
            wallet <Text color="white">{props.walletInfo}</Text>
            {"  "}rpc <Text color="white">{props.rpcHost}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function StatusLine({ label, value, color, fill }: {
  label: string;
  value: number;
  color: string;
  fill: string;
}) {
  return (
    <Text>
      {label.padEnd(8, " ")} <Text color={color}>{fill}</Text> <Text bold color={color}>{String(value).padStart(3, " ")}</Text>
    </Text>
  );
}
