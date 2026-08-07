# First Transaction — Submission Proof

**This is the linkable transaction required by the hackathon submission.**

- **Network:** Sepolia testnet (chainId 11155111)
- **Executed via:** KeeperHub REST API (`POST /api/execute/transfer`)
- **Action:** 0.001 ETH self-transfer (safe first tx — real onchain, no net funds moved)
- **Transaction hash:** `0x93d9b25be5e5481297d05729fc35f6c54a1c868f17f88234b54e4fb83443206d`
- **Explorer link:** https://sepolia.etherscan.io/tx/0x93d9b25be5e5481297d05729fc35f6c54a1c868f17f88234b54e4fb83443206d
- **KeeperHub executionId:** `6z2f3hr9wi6mlz57vcj3a`
- **On-chain status:** SUCCESS (0x1), block 11413143

## How KeeperHub executed it (verified by on-chain decoding)

KeeperHub uses a **relayer + smart-account** model, so the Etherscan view differs from a naive transfer:

- **Keeper EOA** `0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87` submitted the tx and **paid gas** (sponsored).
- **Router contract** `0x5af5194b4b0909eb978e3cf1e25333852277f07d` (3963 bytes) executed the transfer internally.
  - calldata selector `0x9aefaff8`; args = (owner `<your wallet>`, recipient `<your wallet>`, amount `0.001 ETH`, 65-byte sig).
  - top-level `value` is 0 and gas used 74793 because the ETH moves as an internal transfer, not a bare send.
- **Owner wallet** (an EIP-7702 delegated smart account):
  code = `0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f` → implementation `0x955d84139e7621bc571b117d8eb5d28a4a222c6f`.
- **Gas sponsored on Sepolia:** owner balance was 0.050000 ETH before and after, to the wei.

## Reproduce

```bash
# 1. Simulate (dry-run, no broadcast) — expect success:true, wouldRevert:false
curl -s -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" -H "Content-Type: application/json" \
  -d '{"chainId":"11155111","recipientAddress":"<YOUR_WALLET>","amount":"0.001","simulate":true}'

# 2. Broadcast for real (unique Idempotency-Key header prevents double-send)
curl -s -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"chainId":"11155111","recipientAddress":"<YOUR_WALLET>","amount":"0.001"}'
```
