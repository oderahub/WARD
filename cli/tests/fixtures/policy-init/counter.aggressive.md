# Starter Sentry policy

```policy
version: "0.1"
dailySpendWeiCap: "1 ether"  # TODO confirm cap
expiresAt: "2026-12-31T23:59:59.000Z"
targets:
  - target: "0x1111111111111111111111111111111111111111"
    selectors:
      - selector: "increment()"
        tier: IMMEDIATE
        valueCapPerCall: "0 ether"  # TODO confirm cap
        delaySeconds: 0
      - selector: "setCount(uint256)"
        tier: IMMEDIATE
        valueCapPerCall: "0 ether"  # TODO confirm cap
        delaySeconds: 0
```

