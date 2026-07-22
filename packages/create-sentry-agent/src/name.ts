// One user name must be both a safe directory segment and a Solidity identifier.

export interface ValidatedName {
  raw: string;
  dirName: string;
  contractName: string;
}

const RESERVED_DIRS = new Set([".", "..", ""]);

export function validateName(input: string | undefined | null): ValidatedName {
  if (typeof input !== "string") {
    throw new Error("name is required");
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error("name must not be empty");
  }
  if (RESERVED_DIRS.has(raw)) {
    throw new Error(`name "${raw}" is reserved`);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error(`name "${raw}" must not contain path separators`);
  }
  if (raw.startsWith(".") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`name "${raw}" must be a plain segment, not a path`);
  }
  // This is the intersection of safe directory names and lossless Solidity identifiers.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(
      `name "${raw}" may only contain letters, digits, "-" and "_"`,
    );
  }
  if (/^[0-9]/.test(raw)) {
    throw new Error(`name "${raw}" must not start with a digit`);
  }

  const dirName = toKebab(raw);
  const contractName = toPascal(raw);

  return { raw, dirName, contractName };
}

function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toPascal(input: string): string {
  const parts = input.split(/[-_]+/).filter(Boolean);
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
