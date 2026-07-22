# Starter Sentry policy

```policy
version: "0.1"
dailySpendWeiCap: "0 ether"
expiresAt: "2026-12-31T23:59:59.000Z"
targets:
  - target: "0x1111111111111111111111111111111111111111"
    selectors:
      - selector: "increment()"
        tier: DELAYED
        valueCapPerCall: "0 ether"  # TODO confirm cap
        delaySeconds: 300  # TODO set delay
      - selector: "setCount(uint256)"
        tier: DELAYED
        valueCapPerCall: "0 ether"  # TODO confirm cap
        delaySeconds: 300  # TODO set delay
```

