> Historical protocol-v1 evidence. Superseded by docs/PROTOCOL_V2.md and paper/evaluation-v2; do not use these claims or measurements for v2.

# Benchmark Results

Run at: 2026-08-29T19:49:44.302Z
Iterations per metric: 10 (except one-shot ZKP proof generation/verification and full-pipeline latency — see notes)

| Metric | Mean | Std Dev / Range | Unit |
|--------|------|------------------|------|
| ZKP Merkle tree build (20 levels, 1 leaf) | 59680.18 | 1 sample | ms |
| ZKP proof generation (server, Groth16/BN128) | 3640.6 | 1 sample | ms |
| PFEKeyIssuer.verifyAndIssueKey (real Groth16Verifier, incl. pairing check) | 375645 | 1 sample | gas |
| SEAL BFV encryptAttributes (3 attrs) | 20.92 | 5.24 | ms |
| SEAL BFV computeCompatibilityScore (homomorphic) | 26.58 | 3.31 | ms |
| SEAL BFV decryptScore | 1.51 | 0.37 | ms |
| OrganRegistry.registerDonor | 199169 | min 197449 / max 214561 | gas |
| LifecycleManager.executeRevocation (incl. requestRevocation) | 98921 | min 98910 / max 98922 | gas |
| Application-layer pipeline (encrypt → register → score → decrypt) | 70.11 | 1 sample | ms |

> **Note on ZKP metrics:** proof generation and on-chain verification gas are
> reported from a single real proof against the actual `Groth16Verifier`
> contract (not the test mock) rather than a mean over many runs — the
> 20-level Poseidon Merkle tree (~2^20 hashes) makes repeated real proof
> generation prohibitively slow in pure JS on commodity hardware, and the
> Groth16 pairing-check gas cost is deterministic per verification regardless
> of the specific proof/public inputs, so one sample is representative.
> All other metrics (PFE timings, `registerDonor`/`executeRevocation` gas)
> are averaged over 10 runs and do not depend on ZKP proof validity —
> they are measured against a `MockZKPVerifier`-backed `PFEKeyIssuer` deployment.
