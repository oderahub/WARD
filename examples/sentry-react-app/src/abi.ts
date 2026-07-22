// `reset` is present in the ABI but omitted from the demo policy to show rejection before wallet popup.
export const COUNTER_AGENT_ABI = [
  {
    type: "function",
    name: "bump",
    stateMutability: "nonpayable",
    inputs: [{ name: "by", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "reset",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;
