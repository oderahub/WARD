# Test policy

```policy
version: "0.1"
dailySpendWeiCap: "1 ether"
expiresAt: "2028-01-01T00:00:00.000Z"
targets:
  - target: "0x1111111111111111111111111111111111111111"
    selectors:
      - selector: "set(uint256)"
        valueCapPerCall: "0.5 ether"
        tier: IMMEDIATE
```
