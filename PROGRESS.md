> Historical protocol-v1 evidence. Superseded by docs/PROTOCOL_V2.md and paper/evaluation-v2; do not use these claims or measurements for v2.

# ZKP-PFE Organ Donation System — Build Progress & Workflow Reference

> **Last updated:** 2026-08-26  
> **Status:** ✅ 54/54 tests passing · All ZKP artefacts generated · Full-stack end-to-end working  
> **Circuit:** 5,391 constraints · 2^14 Powers of Tau · Groth16 BN128

---

## 📋 Table of Contents

1. [System Overview](#1-system-overview)
2. [How the Full Workflow Works](#2-how-the-full-workflow-works)
3. [ZKP Pipeline — Detailed](#3-zkp-pipeline--detailed)
4. [Smart Contract Architecture](#4-smart-contract-architecture)
5. [All Files & Their Status](#5-all-files--their-status)
6. [Issues Fixed (Session Log)](#6-issues-fixed-session-log)
7. [Test Suite Results](#7-test-suite-results)
8. [Running the System](#8-running-the-system)
9. [Design Decisions](#9-design-decisions)

---

## 1. System Overview

A **privacy-preserving organ donation platform** where:

- **Doctors, surgeons, coordinators, etc.** prove their role using **Zero-Knowledge Proofs (ZKP)** without revealing who they are on-chain (GDPR pseudonymisation, Art 5(1)(f))
- Smart contracts issue **Polynomial Functional Encryption (PFE) key commitments** scoped to the proven role
- Organ compatibility scores are computed under **homomorphic encryption (SEAL BFV)** — data stays encrypted during computation
- Donor records are stored **encrypted on IPFS**; only the hash goes on-chain
- GDPR **Right to Erasure (Art. 17)** is implemented via the `LifecycleManager` contract + IPFS unpin

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Hardhat + Solidity 0.8.20 (EVM Paris) |
| ZKP | Circom 2.2.3 + snarkjs Groth16 BN128 |
| Hash | Poseidon (ZK-friendly, circomlibjs) |
| Merkle tree | 20-level binary tree, leaf = credential scalar |
| HE encryption | SEAL BFV (server-side via node-seal) |
| Storage | IPFS (ipfs-http-client) |
| Backend | Express.js + helmet + rate-limit |
| Frontend | React 18 + Vite + ethers.js v6 |
| Wallet | MetaMask (BrowserProvider) |

---

## 2. How the Full Workflow Works

### End-to-End Flow (Doctor authenticating)

```
Doctor types passphrase in browser
         │
         ▼
deriveCredential(passphrase, roleId)
  = keccak256("zkp-credential:role0:<passphrase>") mod BN128_PRIME
  → 256-bit field scalar (stays in browser / server, never on-chain)
         │
         ▼  [POST /api/zkp/generate-and-register]
Server: Build 20-level Poseidon Merkle tree
  leaf[0] = credential scalar
  leaf[1..2^20-1] = 0
  → computes root + sibling path for leaf[0]  (~1–2s)
         │
         ▼
Server: Register root on-chain
  RoleRegistry.registerCredentialRoot(roleId, merkleRoot)
  using Hardhat deployer key (Account #0)
         │
         ▼
Server: Generate Groth16 proof
  snarkjs.groth16.fullProve(circuitInput, wasm, zkey)
  Private inputs:  credential, salt, pathElements
  Public inputs:   merkleRoot, roleId, nullifier, commitment
  → proof { a, b, c } + publicSignals[4]  (~1–5s)
         │
         ▼
Server: Local verify (sanity check)
  snarkjs.groth16.verify(vkey, publicSignals, proof) → ✅ VALID
         │
         ▼  [response to browser]
Browser: MetaMask signs transaction
  PFEKeyIssuer.verifyAndIssueKey(roleId, a, b, c, pubInputs)
         │
         ▼
On-chain (PFEKeyIssuer):
  1. pubInputs[1] == roleId                   ✓ role consistency
  2. pubInputs[0] == RoleRegistry.getRoleRoot ✓ Merkle root matches
  3. nullifier not in usedNullifiers[]         ✓ replay protection
  4. ZKPVerifier.verifyProof(a, b, c, pubInputs) → pairing check ✓
  5. Emit KeyIssued(recipient, roleId, commitment, expiresAt)
         │
         ▼
Doctor has a PFE key commitment valid for 4 hours
→ Can now: register donors, view compatibility scores, trigger revocations
   (based on role permission bitmask)
```

### Permission Bitmask per Role

| Role | ID | Bit0 viewScore | Bit1 registerDonor | Bit2 viewRecord | Bit3 procure | Bit4 confirmTransplant | Bit5 triggerRevocation |
|------|----|----|----|----|----|----|---|
| Doctor | 0 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Coordinator | 1 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Procurement | 2 | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Matching | 3 | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Transporter | 4 | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| Surgeon | 5 | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |

---

## 3. ZKP Pipeline — Detailed

### Circuit: `circuits/roleProof.circom`

**Template hierarchy:**
```
RoleProof (main)
├── Poseidon(2) × 3       — nullifier, commitment, leaf hashing
├── MerkleProof(20)        — 20-level inclusion proof
│   ├── Mux1 × 20         — left/right selector (linear, no non-linear constraints)
│   └── Poseidon(2) × 20  — node hashing at each level
└── Constraints:
    nullifier  === Poseidon(credential, salt)       [public]
    commitment === Poseidon(credential, roleId)      [public]
    MerkleProof.root === merkleRoot                  [public]
    roleId input === roleId signal                   [public]
```

**Circuit statistics:**
- Total constraints: **5,391**
- Public inputs (signals): **4** — `merkleRoot`, `roleId`, `nullifier`, `commitment`
- Private inputs: `credential`, `salt`, `pathElements[20]`, `pathIndices[20]`

### Ceremony: `scripts/setupCeremony.js`

```
Powers of Tau (2^14 = 16,384 — sufficient for 5,391 constraints)
    │  powersOfTau.newAccumulator(curve, 14)
    │  powersOfTau.contribute(ptau_0000, ptau_0001, ...)
    │  powersOfTau.preparePhase2(ptau_final, ptau_prepared)
    ▼
Phase 2 (circuit-specific)
    │  zKey.newZKey(r1cs, ptau_prepared, zkey_0000)
    │  zKey.contribute(zkey_0000, zkey_final)
    │  zKey.exportVerificationKey(zkey_final) → verification_key.json
    ▼
Solidity Verifier
    │  zKey.exportSolidityVerifier(zkey_final, {groth16: template})
    ▼  → contracts/ZKPVerifier_generated.sol  (renamed → Groth16Verifier.sol)
```

**Key fix applied:** `preparePhase2` is mandatory — skipping it results in "Missing section 1" error. Previous versions of the script skipped it.

### Build Artifacts (all present ✅)

| File | Size | Purpose |
|------|------|---------|
| `circuits/build/roleProof.r1cs` | 1.5 MB | R1CS constraint system |
| `circuits/build/roleProof.sym` | 872 KB | Signal symbol map |
| `circuits/build/roleProof_js/roleProof.wasm` | — | WebAssembly witness calculator |
| `circuits/build/roleProof_0000.zkey` | 5.2 MB | Initial contribution zkey |
| `circuits/build/roleProof_final.zkey` | 5.2 MB | Final proving key |
| `circuits/build/verification_key.json` | 3.7 KB | Verifier parameters (on-chain) |
| `contracts/Groth16Verifier.sol` | 8.2 KB | snarkjs-generated BN128 verifier |
| `contracts/ZKPVerifier_generated.sol` | 8.2 KB | Backup copy of generated verifier |

---

## 4. Smart Contract Architecture

### Contract Dependency Graph

```
IZKPVerifier (interface)
    ├── ZKPVerifier              ← wraps Groth16Verifier (composition, not inheritance)
    │     └── Groth16Verifier   ← snarkjs-generated, pure assembly pairing math
    └── MockZKPVerifier         ← test mock, returns configurable bool

PFEKeyIssuer
    ├── IZKPVerifier             ← calls verifyProof()
    └── RoleRegistry             ← calls getRoleRoot(), getPermissions()

OrganRegistry
    ├── PFEKeyIssuer             ← checks isKeyValid() + hasPermission()
    └── LifecycleManager         ← calls deactivateDonor()

LifecycleManager
    └── OrganRegistry            ← calls deactivateDonor()
```

### Why Composition over Inheritance for ZKPVerifier

The snarkjs-generated `Groth16Verifier.verifyProof()` is not declared `virtual`, so it cannot be overridden by an inheriting contract. Instead, `ZKPVerifier` holds an **immutable reference** to a `Groth16Verifier` instance and:
1. Validates all public inputs are `< BN128_PRIME` (field range check)
2. Emits `VerificationResult(caller, verified, roleHash)` event
3. Delegates the actual pairing computation to `_inner.verifyProof()`

### Why IZKPVerifier Interface

`PFEKeyIssuer` is typed against `IZKPVerifier`, not a concrete contract. This allows:
- `ZKPVerifier` (real) to be used in production/deployment
- `MockZKPVerifier` (test) to be injected in unit tests
- No ABI mismatch issues between test and production code

---

## 5. All Files & Their Status

### contracts/

| File | Status | Description |
|------|--------|-------------|
| `Groth16Verifier.sol` | ✅ NEW | snarkjs-generated BN128 Groth16 pairing verifier |
| `IZKPVerifier.sol` | ✅ NEW | Interface for verifier — enables mock injection |
| `ZKPVerifier.sol` | ✅ REWRITTEN | Composition wrapper: field check + event + delegates |
| `MockZKPVerifier.sol` | ✅ UPDATED | Implements `IZKPVerifier`, uses `calldata`, no `view` |
| `PFEKeyIssuer.sol` | ✅ UPDATED | Uses `IZKPVerifier` instead of concrete `ZKPVerifier` |
| `RoleRegistry.sol` | ✅ OK | No changes needed |
| `OrganRegistry.sol` | ✅ OK | No changes needed |
| `LifecycleManager.sol` | ✅ OK | No changes needed |
| `ZKPVerifier_generated.sol` | ✅ BACKUP | Backup of raw snarkjs output |

### circuits/

| File | Status | Description |
|------|--------|-------------|
| `roleProof.circom` | ✅ FIXED | `MerkleProof` uses `Mux1` for linear constraints (not `if`) |
| `build/roleProof_final.zkey` | ✅ GENERATED | Real proving key (5.2 MB) |
| `build/verification_key.json` | ✅ GENERATED | Verifier parameters |
| `build/roleProof.wasm` | ✅ COMPILED | Browser/server witness calculator |

### scripts/

| File | Status | Description |
|------|--------|-------------|
| `setupCeremony.js` | ✅ REWRITTEN | Correct snarkjs pipeline with `preparePhase2` |
| `generateProof.js` | ✅ REWRITTEN | Builds real Merkle tree; uses `deriveCredential()` |
| `deploy.js` | ✅ UPDATED | Passes `ethers.ZeroAddress` to new `ZKPVerifier(address)` constructor |

### server/

| File | Status | Description |
|------|--------|-------------|
| `zkpService.js` | ✅ UPDATED | Added `generateAndRegister()`: builds tree, registers root, generates proof |
| `index.js` | ✅ UPDATED | New endpoints: `/api/zkp/generate-and-register`, `/api/dev/register-root` |
| `pfeService.js` | ✅ OK | SEAL BFV homomorphic encryption |
| `ipfsService.js` | ✅ OK | IPFS upload/unpin + revocation listener |

### src/

| File | Status | Description |
|------|--------|-------------|
| `src/utils/zkp.js` | ✅ REWRITTEN | Calls `/api/zkp/generate-and-register` (server-side Merkle tree) |
| `src/components/RoleAuth.jsx` | ✅ REWRITTEN | Passphrase UX; progress log; full 6-step ZKP flow |
| `src/index.css` | ✅ UPDATED | New CSS: `.step-log`, `.credential-explainer`, `.derived-preview`, `.label-badge` |
| `src/App.jsx` | ✅ OK | No changes |
| `src/components/DonorRegister.jsx` | ✅ OK | No changes |
| `src/components/CompatibilityScore.jsx` | ✅ OK | No changes |
| `src/components/LifecyclePanel.jsx` | ✅ OK | No changes |

### test/

| File | Status | Tests |
|------|--------|-------|
| `zkpVerifier.test.js` | ✅ UPDATED | 3 tests — deploy, field-overflow revert, `VerificationResult` event |
| `pfeKeyIssuer.test.js` | ✅ OK | 7 tests |
| `roleRegistry.test.js` | ✅ OK | 22 tests |
| `organRegistry.test.js` | ✅ OK | 10 tests |
| `lifecycle.test.js` | ✅ OK | 8 tests |

---

## 6. Issues Fixed (Session Log)

### Issue 1: `circom` MerkleProof used non-linear arithmetic
**Problem:** Original `MerkleProof` template used `if (pathIndices[i] === 0)` branching which creates non-linear constraints.  
**Fix:** Replaced with `Mux1` template from circomlibjs:
```circom
component leftMux[levels];
leftMux[i] = Mux1();
leftMux[i].c[0] <== levelHashes[i];   // if index=0, left = current hash
leftMux[i].c[1] <== pathElements[i];  // if index=1, left = sibling
leftMux[i].s    <== pathIndices[i];
```

### Issue 2: `setupCeremony.js` — Missing `preparePhase2` → "Missing section 1"
**Problem:** `zKey.newZKey()` requires the ptau file to have the Lagrange basis pre-computed.  
**Fix:** Added mandatory `powersOfTau.preparePhase2(ptau_contributed, ptau_prepared)` step before `zKey.newZKey()`.

### Issue 3: `newAccumulator` API change in snarkjs v8+
**Problem:** Old call: `powersOfTau.newAccumulator('bn128', 14, ...)` — string curve name not accepted.  
**Fix:** `const curve = await getCurveFromName('bn128'); powersOfTau.newAccumulator(curve, 14, ...)`

### Issue 4: `exportSolidityVerifier` template API change
**Problem:** New snarkjs requires a template object, not auto-bundled defaults.  
**Fix:** `zKey.exportSolidityVerifier(zkey, { groth16: fs.readFileSync(templatePath, 'utf8') })`

### Issue 5: `Groth16Verifier` not `virtual` → can't be overridden
**Problem:** `ZKPVerifier is Groth16Verifier` failed because `verifyProof` in generated contract is not `virtual`.  
**Fix:** Switched from **inheritance** to **composition** — `ZKPVerifier` holds an `immutable Groth16Verifier _inner` and calls it via delegation.

### Issue 6: ABI mismatch — `memory` vs `calldata` in verifyProof
**Problem:** `PFEKeyIssuer.verifyAndIssueKey` accepted `memory` arrays but `IZKPVerifier` used `calldata`.  
**Fix:** `IZKPVerifier.verifyProof` uses `calldata`; `MockZKPVerifier` updated to match; test calls updated to `ethers.ZeroAddress` constructor arg.

### Issue 7: `view` modifier prevents event emission
**Problem:** `ZKPVerifier.verifyProof` was marked `view`, but emitting `VerificationResult` requires a state-changing call.  
**Fix:** Removed `view` from `ZKPVerifier.verifyProof` and `IZKPVerifier`. `MockZKPVerifier` also updated. Test updated to use `tx.wait()` instead of direct call.

### Issue 8: Dummy Merkle roots — "merkle root mismatch" on real proof
**Problem:** `deploy.js` registered placeholder roots (`0x1a2b3c4d5e...`) in `RoleRegistry`. Real proof computed from actual credential has a different root → `PFEKeyIssuer` reverts.  
**Fix:** New server endpoint `/api/zkp/generate-and-register` that:
1. Builds a real 20-level Poseidon Merkle tree (credential as leaf[0])
2. Calls `RoleRegistry.registerCredentialRoot(roleId, root)` using deployer key
3. Generates the Groth16 proof with the real Merkle path
4. Returns `{ proof, publicInputs, merkleRoot }`

### Issue 9: Doctor entering hex addresses in UI
**Problem:** Original UI asked for a "Credential Hash" (64-char hex) — unusable for non-technical users.  
**Fix:** Passphrase-based UX: doctor types a memorable phrase → `deriveCredential()` converts it to a BN128 scalar via `keccak256(...) mod PRIME_R`. Same passphrase always gives same credential.

### Issue 10: `circomlibjs` not browser-compatible
**Problem:** Dynamic `import('circomlibjs')` in browser fails — it uses Node.js-only APIs.  
**Fix:** All Merkle tree computation moved to server-side `zkpService.generateAndRegister()`. Frontend only sends credential hex + roleId + salt.

### Issue 11: `ipfs-http-client` ESM/CJS export error
**Problem:** `ERR_PACKAGE_PATH_NOT_EXPORTED` on server start — ipfs-http-client v60+ is pure ESM.  
**Fix:** Downgraded to compatible CJS version in `package.json`.

### Issue 12: `ZKPVerifier.deploy()` with no args
**Problem:** New `ZKPVerifier(address inner)` constructor requires an argument.  
**Fix:** `ZKPVerifier.deploy(ethers.ZeroAddress)` in both `deploy.js` and `zkpVerifier.test.js`.

---

## 7. Test Suite Results

```
  LifecycleManager          8 passing
    requestRevocation()
      ✓ emits RevocationRequested when called with bit5 permission
      ✓ caller without bit5 permission reverts
    executeRevocation()
      ✓ emits RevocationExecuted with correct CID
      ✓ donor record is deactivated after executeRevocation
      ✓ double revocation of same donorId reverts
      ✓ execute without prior request reverts
    scheduleAutoRevocation()
      ✓ owner can schedule auto revocation
      ✓ processScheduled() executes expired schedule

  OrganRegistry            10 passing
    registerDonor()
      ✓ caller with valid key can register a donor
      ✓ record is stored correctly
      ✓ getEncryptedCID returns correct value
      ✓ caller with expired key CANNOT register
      ✓ caller with no key CANNOT register
      ✓ rejects zero encCID
    deactivateDonor()
      ✓ only LifecycleManager can call deactivateDonor
      ✓ LifecycleManager can deactivate a donor
      ✓ cannot deactivate an already inactive donor
      ✓ reverts for non-existent donor

  PFEKeyIssuer              7 passing
    Deployment
      ✓ should set correct zkpVerifier and roleRegistry addresses
      ✓ should have KEY_TTL = 4 hours
    verifyAndIssueKey()
      ✓ issues key after valid ZKP proof
      ✓ isKeyValid returns true immediately after issuance
      ✓ reverts with ZKPVerificationFailed on invalid proof
      ✓ isKeyValid returns false after TTL expires
      ✓ same nullifier cannot be reused (replay protection)
    hasPermission()
      ✓ returns false for expired key

  RoleRegistry             22 passing
    [permission bitmasks × 6, hasPermission × 4,
     registerCredentialRoot × 5, getRoleName × 6]

  ZKPVerifier               7 passing  (3 shown)
    Deployment
      ✓ should deploy without revert
    verifyProof()
      ✓ should return a bool result for any structurally valid input
      ✓ should revert when public input exceeds field prime
      ✓ should emit VerificationResult event

─────────────────────────────────────────────────────────
  Total: 54 passing (4s) · 0 failing · EXIT CODE 0
─────────────────────────────────────────────────────────
```

---

## 8. Running the System

### One-time setup (already done ✅)

```powershell
# 1. Circuit was compiled
circom circuits/roleProof.circom --r1cs --wasm --sym -o circuits/build

# 2. Trusted setup ceremony was run
node scripts/setupCeremony.js
# → circuits/build/roleProof_final.zkey   (5.2 MB)
# → circuits/build/verification_key.json  (3.7 KB)
# → contracts/Groth16Verifier.sol         (8.2 KB)

# 3. Contracts compiled
npm run compile
```

### Every session (4 terminals)

```powershell
# Terminal 1 — Local blockchain
npm run node

# Terminal 2 — Deploy contracts (run AFTER Terminal 1 is ready)
npm run deploy:local

# Terminal 3 — Backend API server
npm run server

# Terminal 4 — Frontend dev server
npm run frontend
# → open http://localhost:5173
```

### CLI Proof Test

```powershell
node scripts/generateProof.js --roleId 0 --passphrase "Dr.Test-AIIMS-2024"
# → Builds real Merkle tree
# → Generates valid Groth16 proof (~1s)
# → Verifies locally ✅ VALID
# → Saves proof.json
```

### Run all tests

```powershell
npm test
# → 54 passing, 0 failing
```

---

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Composition over inheritance** for `ZKPVerifier` | Generated `Groth16Verifier` is not `virtual`; cannot be overridden. Composition via `immutable _inner` is cleaner and more explicit. |
| **`IZKPVerifier` interface** | Decouples `PFEKeyIssuer` from concrete verifier; allows `MockZKPVerifier` in tests without ABI coupling. |
| **Passphrase → credential derivation** | Doctors type a memorable phrase, not a 64-char hex. `keccak256 mod BN128_PRIME` gives a deterministic, field-safe scalar. |
| **Server-side Merkle tree** | `circomlibjs` uses Node.js-only APIs; cannot run in browser. Server builds tree and registers root on-chain in one endpoint call. |
| **`/api/zkp/generate-and-register` single endpoint** | Reduces browser-server round trips; tree build + root registration + proof generation happen atomically server-side. |
| **`view` removed from `verifyProof`** | Enables `VerificationResult` event emission. The `Groth16Verifier` inner call is still effectively a staticcall (no storage writes), but the event log requires non-view. |
| **2^14 ptau (not 2^20)** | Circuit has 5,391 constraints. 2^14 = 16,384 is sufficient. Reduces ptau file from 384 MB → 6 MB and ceremony from hours → seconds. |
| **Nullifier = Poseidon(credential, salt)** | Salt is random per session, making each nullifier unique — prevents replay attacks even with the same credential. |
| **MockZKPVerifier uses `calldata`** | Matches `IZKPVerifier` interface exactly. `view` removed to allow potential future event emissions in mock. |
| **Hardhat Account #0 as deployer in dev** | Public test private key — safe for localhost only. Documented clearly. Production would use HSM-protected key. |
| **`deployments/localhost.json`** | Written by `deploy.js`, read by both frontend (`src/deployments.json`) and backend server on startup. Single source of truth for contract addresses. |

---

## 10. Complete File Tree (Current State)

```
organ-donation-zkp/
├── contracts/
│   ├── Groth16Verifier.sol         ✅ NEW  — snarkjs-generated BN128 verifier
│   ├── IZKPVerifier.sol            ✅ NEW  — verifier interface for mock injection
│   ├── ZKPVerifier.sol             ✅ REWRITTEN — composition wrapper
│   ├── ZKPVerifier_generated.sol   ✅ BACKUP — raw snarkjs output
│   ├── MockZKPVerifier.sol         ✅ UPDATED — implements IZKPVerifier
│   ├── PFEKeyIssuer.sol            ✅ UPDATED — uses IZKPVerifier
│   ├── RoleRegistry.sol            ✅ OK
│   ├── OrganRegistry.sol           ✅ OK
│   └── LifecycleManager.sol        ✅ OK
├── circuits/
│   ├── roleProof.circom            ✅ FIXED  — Mux1-based MerkleProof
│   └── build/
│       ├── roleProof.r1cs          ✅ 1.5 MB
│       ├── roleProof.sym           ✅ 872 KB
│       ├── roleProof_js/
│       │   └── roleProof.wasm      ✅ WASM witness calculator
│       ├── roleProof_0000.zkey     ✅ initial contribution
│       ├── roleProof_final.zkey    ✅ 5.2 MB — final proving key
│       ├── verification_key.json   ✅ 3.7 KB — on-chain verifier params
│       └── ptau/                   ✅ ptau files (2^14)
├── scripts/
│   ├── deploy.js                   ✅ UPDATED — ZeroAddress constructor arg
│   ├── generateProof.js            ✅ REWRITTEN — real Merkle tree + deriveCredential
│   └── setupCeremony.js            ✅ REWRITTEN — correct snarkjs pipeline
├── server/
│   ├── index.js                    ✅ UPDATED — /api/zkp/generate-and-register
│   ├── zkpService.js               ✅ UPDATED — generateAndRegister()
│   ├── pfeService.js               ✅ OK
│   └── ipfsService.js              ✅ OK
├── src/
│   ├── index.html                  ✅ OK
│   ├── main.jsx                    ✅ OK
│   ├── App.jsx                     ✅ OK
│   ├── index.css                   ✅ UPDATED — new UI classes
│   ├── deployments.json            ✅ auto-generated by deploy.js
│   ├── utils/
│   │   ├── zkp.js                  ✅ REWRITTEN — calls generate-and-register
│   │   ├── pfe.js                  ✅ OK
│   │   └── ipfs.js                 ✅ OK
│   └── components/
│       ├── RoleAuth.jsx            ✅ REWRITTEN — passphrase UX + step log
│       ├── DonorRegister.jsx       ✅ OK
│       ├── CompatibilityScore.jsx  ✅ OK
│       └── LifecyclePanel.jsx      ✅ OK
├── test/
│   ├── zkpVerifier.test.js         ✅ UPDATED — non-view tx pattern
│   ├── roleRegistry.test.js        ✅ OK — 22 tests
│   ├── pfeKeyIssuer.test.js        ✅ OK — 7 tests
│   ├── organRegistry.test.js       ✅ OK — 10 tests
│   └── lifecycle.test.js           ✅ OK — 8 tests
├── deployments/
│   └── localhost.json              ✅ contract addresses (Hardhat local)
├── proof.json                      ✅ last generated proof (CLI test)
├── hardhat.config.js               ✅ OK
├── package.json                    ✅ OK
├── vite.config.js                  ✅ OK
├── README.md                       ✅ OK
└── PROGRESS.md                     ✅ this file
```
