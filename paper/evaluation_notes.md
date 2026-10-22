# Evaluation Notes for Paper Section 4

## Experimental Setup

- Hardware: Intel Core i7-12700H (1 socket, multi-core), 16 GB RAM
- OS: Windows 11 Pro (build 26200)
- Node.js: v22.19.0, Hardhat: 2.22.x
- IPFS: Kubo (localhost, only required for `test/integration/ipfsService.test.js`
  — not running for this benchmark pass, so IPFS timings are not included below)
- SEAL BFV: poly_modulus_degree=4096, plain_modulus = Batching(4096, 20 bits)
  (see `server/pfeService.js`)
- Circuit: `roleProof.circom` — 5,391 R1CS constraints, 20-level Poseidon
  Merkle tree, Groth16/BN128, 2^14 Powers-of-Tau ceremony

## Results (from benchmark_results.json, run 2026-08-29T19:49:44.302Z)

| Metric | Mean | Std Dev / Range | Unit |
|--------|------|------------------|------|
| ZKP Merkle tree build (20 levels, 1 leaf) | 59,680.2 | 1 sample | ms |
| ZKP proof generation (server, Groth16/BN128) | 3,640.6 | 1 sample | ms |
| PFEKeyIssuer.verifyAndIssueKey (real Groth16Verifier, incl. pairing check) | 375,645 | 1 sample | gas |
| SEAL BFV encryptAttributes (3 attrs) | 20.92 | ±5.24 | ms |
| SEAL BFV computeCompatibilityScore (homomorphic) | 26.58 | ±3.31 | ms |
| SEAL BFV decryptScore | 1.51 | ±0.37 | ms |
| OrganRegistry.registerDonor | 199,169 | min 197,449 / max 214,561 | gas |
| LifecycleManager.executeRevocation (incl. requestRevocation) | 98,921 | min 98,910 / max 98,922 | gas |
| Application-layer pipeline (encrypt → register → score → decrypt) | 70.11 | 1 sample | ms |

Notes:
- The **Merkle tree build** (~2^20 Poseidon hashes for a 20-level tree with a
  single populated leaf) dominates end-to-end proving latency by two orders
  of magnitude versus the Groth16 proof generation itself (59.7s vs 3.6s).
  This is a pure-JS `circomlibjs` cost, not a circuit or proving-system
  limitation — a production client would either cache the tree incrementally
  (only one leaf changes at registration time) or use a native Poseidon
  implementation.
- ZKP proof generation and on-chain verification gas are reported from a
  single real proof against the actual `Groth16Verifier` contract (not a
  mock) — repeated real proof generation was prohibitively slow for a
  10-sample mean on this hardware (see note above), and Groth16 pairing-check
  gas is deterministic per verification regardless of the specific proof, so
  one sample is representative.
- All other metrics (PFE timings, `registerDonor`/`executeRevocation` gas)
  are averaged over 10 runs against a `MockZKPVerifier`-backed `PFEKeyIssuer`
  deployment, since they do not depend on ZKP proof validity.

## Gas Cost Analysis

At a representative Sepolia gas price of ~20 gwei and ETH ≈ $2,500 (adjust to
actual conditions at deployment time — see `deployments/sepolia.json` after
running `npm run deploy:sepolia`):

| Operation | Gas | Cost @ 20 gwei | Cost @ 20 gwei, $2,500/ETH |
|-----------|-----|----------------|------------------------------|
| `verifyAndIssueKey` (ZKP-gated key issuance) | 375,645 | 0.00751 ETH | ~$18.79 |
| `registerDonor` | 199,169 | 0.00398 ETH | ~$9.96 |
| `executeRevocation` (+ `requestRevocation`) | 98,921 | 0.00198 ETH | ~$4.95 |

These are one-time, per-role or per-record costs (a role key, once issued, is
reused for 4 hours across many `registerDonor`/`getCompatibilityScore` calls),
not a per-transaction recurring cost for routine matching queries — those are
read-only (`view`) and free.

## Comparison Table

| Feature                          | This Work | Samsukha et al. [5] | Block-Privacy [BP] |
|-----------------------------------|-----------|----------------------|----------------------|
| ZKP role authentication          | ✅ Yes    | ❌ No                | ✅ Yes (generic)      |
| PFE polynomial scoring           | ✅ Yes    | ✅ Yes               | ❌ No (general FE)    |
| IPFS off-chain ciphertext store  | ✅ Yes    | ❌ Referenced only   | ✅ Yes                |
| Organ-specific workflow          | ✅ Yes    | ✅ Yes               | ❌ General IoMT       |
| GDPR Art. 17 revocation          | ✅ Yes    | ❌ No                | ❌ No                 |
| ZKP gates PFE key issuance       | ✅ Yes    | ❌ No                | ❌ No                 |
| Clinical matching variables      | 3 vars    | 3 vars               | N/A                   |
| Replay attack protection         | ✅ Yes    | ❌ Not specified     | ❌ Not specified      |
| On-chain ZKP verification (gas)  | 375,645 | N/A | Not reported |
| Proof generation time            | 3,640.6 ms | Not reported | Not reported |
| Post-quantum resistance          | ❌ Future | ❌ No                | ❌ No                 |

## Security Analysis

- **ZKP soundness**: Groth16 under BN128 — binding under the discrete-log
  assumption in the pairing-friendly curve's cyclic group of order `r`.
- **ZKP zero-knowledge**: Groth16 admits a simulator — computational
  zero-knowledge under the same assumption.
- **SEAL BFV correctness**: BFV decryption recovers `plaintext + noise`;
  correctness holds as long as accumulated noise stays below `q/(2t)`. This
  system performs at most one homomorphic multiplication per score
  (`computeCompatibilityScore`), well within the noise budget for
  `poly_modulus_degree=4096`.
- **Nullifier replay protection**: `PFEKeyIssuer.usedNullifiers` rejects a
  reused `Poseidon(credential, salt)` nullifier — exercised in
  `test/zkpVerifier.integration.test.js` and `test/pfeKeyIssuer.test.js`
  ("same nullifier cannot be reused").
- **Key TTL**: PFE keys expire 4 hours after issuance (`KEY_TTL` in
  `PFEKeyIssuer`) — exercised in `test/organRegistry.test.js` ("caller with
  expired key CANNOT register") and `test/pfeKeyIssuer.test.js`.
- **GDPR Art. 17 (Right to Erasure)**: `LifecycleManager.executeRevocation`
  deactivates the on-chain record and emits `RevocationExecuted`, which
  `server/ipfsService.js`'s listener consumes to unpin the IPFS CID.
- **GDPR Art. 5(1)(f) (Integrity & Confidentiality)**: no plaintext clinical
  attributes are ever written on-chain or to IPFS in cleartext — records are
  SEAL BFV ciphertexts wrapped in AES-256-GCM (`pfeService.js`
  `prepareEncryptedRecord`), and only IPFS CID strings and pseudonymous
  addresses are stored on-chain (`OrganRegistry`).
- **Trust model caveat**: see README "Security Model" — the current
  prototype computes ZKP witnesses server-side; this is a deployment
  limitation, not a break of the underlying proof system (see that section
  for the client-side hardening path).
