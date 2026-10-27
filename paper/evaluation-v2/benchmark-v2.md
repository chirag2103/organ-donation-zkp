# Protocol v2 measured evaluation

Same authenticated HTTP job interface. Plaintext baseline holds synthetic attributes in memory; BFV baselines retrieve AES-wrapped records from real isolated Kubo. Test-only quotas raised. Sequential single-process local execution; not consortium throughput.

Repeated timing metrics use 10 warmups and 30 measured samples. Node proving includes path construction and is not browser latency. Transaction receipt timings are local EVM diagnostics; cold issuance gas is recorded separately from warmed verification samples. Revocation alternates donor and recipient records and measures request, execution and direct local cleanup separately. The cleanup benchmark excludes worker discovery/retry delay, which is covered by recovery tests. Job timings include 100-ms result polling and fresh HTTP connections. Any idempotent polling retries remain in the measured latency and are recorded in JSON metadata.

| Metric | Samples | Median ms | p95 ms |
|---|---:|---:|---:|
| enrollment | 30 | 38.579 | 45.927 |
| membershipPath | 30 | 47.823 | 50.292 |
| proofGeneration | 30 | 2922.250 | 4318.040 |
| verifyTransactionLocal | 30 | 10.446 | 11.763 |
| bfvEncrypt | 30 | 115.157 | 131.599 |
| bfvEvaluate | 30 | 230.733 | 244.979 |
| bfvRelease | 30 | 10.472 | 16.847 |
| plaintextPolicy | 30 | 0.003 | 0.004 |
| walletSignatureCheck | 30 | 10.250 | 13.003 |
| encryptedStorageRoundTrip | 30 | 42.027 | 107.348 |
| revocationRequestLocal | 30 | 1.870 | 2.406 |
| revocationExecutionLocal | 30 | 1.656 | 2.068 |
| localCleanup | 30 | 22.622 | 31.282 |
| HTTP plaintextWalletRbac 1x1 | 30 | 134.877 | 146.707 |
| HTTP plaintextWalletRbac 5x5 | 30 | 291.905 | 336.712 |
| HTTP plaintextWalletRbac 10x10 | 30 | 862.313 | 1080.332 |
| HTTP bfvWalletRbac 1x1 | 30 | 384.682 | 599.395 |
| HTTP bfvWalletRbac 5x5 | 30 | 7203.024 | 7486.875 |
| HTTP bfvWalletRbac 10x10 | 30 | 11946.915 | 17289.180 |
| HTTP bfvZkpAuthorization 1x1 | 30 | 164.476 | 198.896 |
| HTTP bfvZkpAuthorization 5x5 | 30 | 3292.054 | 3423.098 |
| HTTP bfvZkpAuthorization 10x10 | 30 | 12116.838 | 12406.246 |

Gas, variability and raw timing samples are in benchmark-v2.json. Initial dataset registration gas has 20 samples; repeated timing metrics use the sample counts above.
