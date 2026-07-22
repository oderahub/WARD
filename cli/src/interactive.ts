import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import kleur from "kleur";
import { parseEther } from "viem";
import { compileCmd, policyIdCmd, pushCmd } from "./cmd/policy.js";
import { inspectCmd } from "./cmd/inspect.js";
import { preflightCmd } from "./cmd/preflight.js";
import { runTuiCmd } from "./cmd/tui.js";
import {
  queueDispatchCmd,
  queueEnqueueCmd,
  queueExpireCmd,
  queueStatusCmd,
  queueVetoCmd,
} from "./cmd/queue.js";

type Choice = {
  key: string;
  label: string;
  run: (io: InteractiveIO) => Promise<void>;
  closesMenu?: boolean;
};

interface InteractiveIO {
  ask: (question: string, fallback?: string) => Promise<string>;
  required: (question: string, fallback?: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
}

interface Prompter {
  question: (question: string) => Promise<string>;
  close: () => void;
}

export async function runInteractive(): Promise<void> {
  const prompt = createPrompter();
  const io: InteractiveIO = {
    ask: async (question, fallback) => {
      const suffix = fallback === undefined ? "" : ` (${fallback})`;
      const answer = (await prompt.question(`${question}${suffix}: `)).trim();
      return answer || fallback || "";
    },
    required: async (question, fallback) => {
      while (true) {
        const answer = await io.ask(question, fallback);
        if (answer) return answer;
        console.log(kleur.yellow("Required."));
      }
    },
    confirm: async (question) => {
      const answer = (await prompt.question(`${question} [y/N]: `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };

  try {
    console.log(kleur.bold().cyan("Ward CLI"));
    console.log(kleur.gray("Choose an action. Existing command flags still work for scripts.\n"));

    while (true) {
      printMenu();
      const choice = (await prompt.question("Select: ")).trim();
      if (choice === "0" || choice.toLowerCase() === "q") return;
      const item = CHOICES.find((c) => c.key === choice);
      if (!item) {
        console.log(kleur.yellow("Unknown choice.\n"));
        continue;
      }
      console.log("");
      try {
        if (item.closesMenu) prompt.close();
        await item.run(io);
        if (item.closesMenu) return;
      } catch (err) {
        console.error(kleur.red((err as Error)?.message ?? String(err)));
        if (item.closesMenu) return;
      }
      console.log("");
    }
  } finally {
    prompt.close();
  }
}

function createPrompter(): Prompter {
  if (input.isTTY) {
    return createInterface({ input, output });
  }

  const source = readFileSync(0, "utf8");
  const answers = source.length > 0 ? source.split(/\r?\n/) : [];
  if (answers.at(-1) === "") answers.pop();
  let index = 0;
  return {
    question: async (question) => {
      output.write(question);
      if (index >= answers.length) {
        throw new Error(`No input available for prompt: ${question}`);
      }
      const answer = answers[index] ?? "";
      index += 1;
      output.write(`${answer}\n`);
      return answer;
    },
    close: () => {},
  };
}

const CHOICES: Choice[] = [
  {
    key: "1",
    label: "Open full-screen monitor TUI",
    closesMenu: true,
    run: async () => {
      runTuiCmd([], { exitOnFailure: false });
    },
  },
  {
    key: "2",
    label: "Preflight",
    run: async (io) => {
      const min = await io.ask("Minimum STT balance", "0.5");
      await preflightCmd({ minBalance: parseEther(min) });
    },
  },
  {
    key: "3",
    label: "Compile POLICY.md",
    run: async (io) => {
      const path = await io.required("Policy file", "examples/ward-counter/policy.md");
      await compileCmd(path);
    },
  },
  {
    key: "4",
    label: "Publish or update policy",
    run: async (io) => {
      const path = await io.required("Policy file", "examples/ward-counter/policy.md");
      const label = await io.required("Short label");
      if (!(await io.confirm("This sends an on-chain publish/update transaction. Continue?"))) return;
      await pushCmd(path, { label });
    },
  },
  {
    key: "5",
    label: "Compute policy ID",
    run: async (io) => {
      const label = await io.required("Short label");
      const publisher = await io.ask("Publisher address (blank = wallet from PRIVATE_KEY)");
      await policyIdCmd(label, publisher || undefined);
    },
  },
  {
    key: "6",
    label: "Inspect intent JSON",
    run: async (io) => {
      const path = await io.required("Intent JSON file");
      await inspectCmd(path);
    },
  },
  {
    key: "7",
    label: "Queue status",
    run: async (io) => {
      const execId = await io.required("Exec ID");
      await queueStatusCmd(execId);
    },
  },
  {
    key: "8",
    label: "Queue enqueue",
    run: async (io) => {
      const intentPath = await io.required("Intent JSON file");
      const policyId = await io.required("Policy ID");
      const spentToday = await io.ask("Spent today in wei", "0");
      if (!(await io.confirm("This sends an on-chain enqueue transaction. Continue?"))) return;
      await queueEnqueueCmd(intentPath, policyId, { spentToday });
    },
  },
  {
    key: "9",
    label: "Queue dispatch",
    run: async (io) => {
      const execId = await io.required("Exec ID");
      const execute = await io.confirm("Also execute the returned intent transaction?");
      if (!(await io.confirm("This sends an on-chain dispatch transaction. Continue?"))) return;
      await queueDispatchCmd(execId, { execute });
    },
  },
  {
    key: "10",
    label: "Queue veto",
    run: async (io) => {
      const execId = await io.required("Exec ID");
      const reason = await io.required("Reason (<=32 bytes)");
      if (!(await io.confirm("This sends an on-chain veto transaction. Continue?"))) return;
      await queueVetoCmd(execId, reason);
    },
  },
  {
    key: "11",
    label: "Queue expire",
    run: async (io) => {
      const execId = await io.required("Exec ID");
      if (!(await io.confirm("This sends an on-chain expire transaction. Continue?"))) return;
      await queueExpireCmd(execId);
    },
  },
];

function printMenu(): void {
  for (const choice of CHOICES) {
    console.log(`${choice.key.padStart(2, " ")}. ${choice.label}`);
  }
  console.log(" 0. Exit");
}
