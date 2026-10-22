# Research and implementation review — 22 October 2026

## Assessment

The repository contains a substantial research prototype: real Groth16 proofs are verified by Solidity, BFV evaluates an encrypted polynomial, and contracts model registration and revocation. However, its current implementation does not support the stronger claims of authenticated professional roles, cryptographically role-scoped functional encryption, hidden clinical attributes on-chain, or guaranteed GDPR erasure.

Fix the authorization and privacy boundaries before adding more clinical variables, deploying publicly, or adding post-quantum components.

Scope: reviewed the application structure, contracts, circuit, backend, frontend, scripts, tests, configuration, progress documents and evaluation outputs; compared against the named Phase II PDF and updated Beamer source in Downloads. Dependencies, generated cryptographic binaries and compiler artifacts were inspected as supporting artifacts rather than exhaustively audited. This is a code/research review, not a formal cryptographic audit or clinical validation. Existing application source was not changed.

## Verification performed

- `npm test`: **70 passing, 5 pending**, with Mocha reporting about 7 seconds. Real Groth16 verification and tampered-proof rejection passed. IPFS tests were skipped because no daemon was reachable.
- `npm run build:frontend`: **failed** because `src/index.css` contains invalid UTF-8. A byte scan confirmed a decoding failure at byte offset 26230.
- A direct BFV service probe returned distance 200/display score 800 for B+ donor → O− recipient with equal HLA values. Changing recipient urgency from 0 to 1 left distance unchanged. The display helper labels 800 an “Excellent match.”
- `contracts/Groth16Verifier.sol` and `contracts/ZKPVerifier_generated.sol` currently have identical SHA-256 hashes. This confirms those source copies match, not that the trusted setup is secure.
- No live browser/MetaMask demo, production deployment, or live IPFS revocation was performed. Findings about those paths below come from code inspection.

## Findings, ordered by priority

### 1. Critical: users can authorize their own chosen role

Evidence: `server/index.js:118`, `server/zkpService.js` (`generateAndRegister`), and `server/index.js:352`.

`/api/zkp/generate-and-register` accepts a caller-chosen credential and role, builds a one-member tree, and registers its root using the owner's signing key. The unauthenticated `/api/dev/register-root` route also accepts arbitrary roots. There is no independent verification that the caller is a doctor, surgeon, etc. A real proof consequently proves knowledge of a credential that the service has just accepted, not a professionally authorized role.

Each login replaces the whole role root, so another user logging into the same role can invalidate an earlier user's pending proof.

Correction: separate institution-approved enrollment from authentication. Maintain a persistent tree containing all enrolled members, issue random credentials, and provide membership paths. Authentication must use an already approved root and never mutate it. Remove privileged development routes from normal operation. Test two concurrent members of the same role and rejection of an unregistered user.

### 2. Critical: the decryption endpoint does not enforce authorization

Evidence: `server/index.js:225` and `server/pfeService.js:311`.

`roleId` and `keyCommitment` are only checked for presence. The route calls `decryptScore(encryptedScore)` without checking a wallet signature, on-chain key validity, commitment equality, role permission, expiry, record activity, or ciphertext provenance. A public commitment is not a secret authentication token.

The endpoint accepts arbitrary BFV ciphertexts, rather than only results of an approved evaluation. This creates a decryption-oracle boundary, not merely an omitted UI restriction. Microsoft SEAL explicitly warns about sharing decryptions of attacker-influenced ciphertexts.

Correction: use wallet-signed challenges/sessions with nonce, expiry and domain binding; check current on-chain authorization; authorize the requested operation and records. Accept record IDs and a fixed approved computation, not user-supplied ciphertexts for unrestricted decryption. Return only the permitted result. Query limits and output leakage still require analysis after authentication is fixed.

### 3. Critical to the research claim: BFV plus HKDF is not function-scoped FE

Evidence: `server/pfeService.js:128`, `server/pfeService.js:136`, `server/pfeService.js:311`, `server/pfeService.js:342`.

One server holds the BFV secret key and decrypts all evaluated ciphertexts. HKDF derives AES keys, but those keys are not BFV function-specific decryption keys. The main registration flow uploads raw BFV bundles and bypasses the optional AES wrapper. `PFEKeyIssuer` issues a public authorization record/commitment, not a cryptographic FE key.

Choose one explicit research direction:

1. Describe and harden the current architecture as **ZKP-authorized BFV computation with a trusted decryption service**. This is the practical continuation.
2. If actual PFE is essential, select a published construction supporting the required polynomial and multi-party data model, implement its setup/key-generation/encryption/decryption algorithms, and evaluate function-key restrictions and collusion assumptions. Renaming BFV operations does not implement FE.

Also state that the backend currently sees plaintext attributes during encryption and credentials during proving. BFV protects storage/computation against parties without the secret key; it does not hide data from this backend.

### 4. High: plaintext clinical metadata is written permanently to the blockchain

Evidence: `contracts/OrganRegistry.sol:30`, `contracts/OrganRegistry.sol:50`, registration functions and events.

Donor/recipient records contain plaintext blood type; recipients also contain plaintext urgency. Public mapping getters expose those fields and raw CID strings without the score gate. Transaction calldata/history also retains submitted values. Therefore “no plaintext attribute appears on-chain” and “only keccak256(CID) is stored” are incorrect descriptions of this implementation.

Correction: decide which metadata truly belongs on-chain. Keep sensitive attributes encrypted off-chain and use suitable commitments where an anchor is necessary. Changing a Solidity mapping to `private` or adding a read modifier does not make blockchain storage confidential. Document visible roles, addresses, timestamps, events and linkability.

### 5. High: the lifecycle UI ABI is incompatible with the contracts

Evidence: `src/components/LifecyclePanel.jsx:14` through `:22`; contracts use string CIDs.

The UI declares `DonorRegistered`, `RevocationExecuted`, `executeRevocation`, and the revocation tuple with `bytes32` CIDs. Changing an event/function parameter from `string` to `bytes32` changes its signature. This can prevent donor discovery, call the wrong selector, or fail tuple decoding. The callback also applies `ethers.hexlify` to the CID.

Correction: derive frontend ABIs from compiled contract artifacts. Use strings consistently and remove hex-only conversion. Add a browser test registering a donor and completing revocation through the actual UI.

### 6. High: production frontend build fails

Evidence: `src/index.css` fails strict UTF-8 decoding; Vite build reproduced the failure.

Correction: inspect and convert the intended stylesheet encoding to UTF-8, then rerun the build. Vite also warns about ESM syntax in a CommonJS config; using a `.mjs` config is a routine cleanup. Add the frontend build to CI so Solidity-only success cannot hide a broken application.

### 7. High: the kidney compatibility model is not clinically justified

Evidence: `server/pfeService.js:237`, `src/utils/pfe.js:121`, registration forms.

The model uses antigen flags resembling red-cell transfusion compatibility, including Rh. Kidney matching does not generally use Rh as an incompatibility criterion. HLA is modeled as one independently entered number per person; the squared difference between these values is not a substitute for donor/recipient tissue typing and crossmatch.

Incompatible blood pairs receive only a soft penalty. In the reproduced B+ → O− case, equal HLA inputs yield 800/1000 and an “Excellent match” label. At default weights and valid input ranges, distance is at most 600, so displayed scores stay between 400 and 1000; the “Poor match” category is unreachable.

Correction: define an organ-specific eligibility policy with clinical guidance. Separate eligibility/exceptions from ranking, model HLA at the pair level using appropriate attributes, and distinguish urgency/allocation priority from biological compatibility. Treat the current formula as synthetic. Do not present a normalized heuristic as a validated compatibility percentage.

### 8. High: urgency is encrypted but never evaluated

Evidence: `server/pfeService.js:197`, `server/pfeService.js:237`; frontend ciphertext fetch discards `ctUrgency`.

There are five ciphertexts, but not five independent clinical variables: three encode one blood-type category. The active polynomial uses blood flags and HLA only. `ALPHA` is unused. The PDF's urgency term and weights differ from the code (which uses HLA weight 300).

Correction: specify one authoritative equation and parameter set. Either implement a justified urgency policy or remove the claim that urgency affects matching. Update README, report, slides and tests together.

### 9. High: proofs are not bound to their intended submitter

Evidence: `circuits/roleProof.circom:109`, `contracts/PFEKeyIssuer.sol:87`.

The public signals do not include the intended wallet, chain or issuer contract. Another wallet could submit the same visible proof first and receive its own session record, consuming the nullifier. This is a front-running risk inferred from the code; it was not exercised against a live network.

Correction: bind the intended recipient and application domain into the proven statement and enforce them in the issuer. Keep an explicit relayer model if desired. The nullifier blocks reuse of the same proof, but does not establish who may submit it. Random salts permit fresh authentication; they do not revoke compromised credentials.

### 10. High: private credentials are logged

Evidence: `server/zkpService.js:131` logs `circuitInput.credential` and part of the Merkle path. This also appeared during the test run with synthetic test credentials.

The README/PDF assertion that credentials are never logged is false. Reassigning JS string properties after proving does not guarantee secure memory erasure.

Correction: remove private-input logging, check error/telemetry paths, and describe memory handling honestly. Use randomly issued high-entropy credentials instead of predictable professional identifiers/passphrases. The public deterministic credential/role commitment also links repeat uses and permits testing weak guesses.

### 11. High: IPFS unpinning does not guarantee erasure or GDPR compliance

Evidence: `server/ipfsService.js:131`; report GDPR sections.

Local unpinning and garbage collection do not remove replicas or cached copies on other IPFS nodes, nor blockchain history. The code treats GC failure as nonfatal while returning success. Cryptographic access revocation also cannot claw back plaintext or keys already copied by an authorized party.

Correction: describe the mechanism as local retention/access revocation under stated assumptions. Consider controlled storage, record-level key separation and accountable key destruction, explicit replica/backup retention policy, and observable deletion jobs. Protect searchable ciphertexts and evaluation keys consistently with that design. Do not assume an AES wrapper alone permits continued homomorphic computation. GDPR assessment must include applicable retention exceptions and governance, not just unpinning. Data minimisation is Article 5(1)(c), not 5(1)(b) as stated in the PDF.

### 12. High: revocation can target the wrong CID and scheduled cleanup is unreliable

Evidence: `contracts/LifecycleManager.sol:125`, `:197`, `server/ipfsService.js:186`.

Manual execution accepts a caller-provided CID without checking it against the donor. Scheduled execution emits the literal `scheduled`. Its listener falls back to an in-memory CID map, but normal frontend upload does not supply the assigned donor ID, and restarts lose that map. The listener has no durable event cursor/retry queue, so downtime can lose cleanup work. Recipients have no corresponding lifecycle path.

Correction: resolve/bind the canonical CID to the record; support both entity types; persist jobs and processed block/log identifiers; replay missed events with confirmation/reorg handling; distinguish requested/on-chain-deactivated/off-chain-completed/failed states. Run a keeper for schedules. `processScheduled` bounds completed items to 50 but can still scan an unbounded array; use pagination/cursors or another bounded queue.

### 13. High: encryption keys disappear on backend restart

Evidence: `server/pfeService.js:128` and `:141` create fresh keys on initialization.

Existing IPFS ciphertexts survive a restart but no longer have their original BFV secret key available. Node restarts, `nodemon` reloads and multiple backend workers can therefore make data unreadable or mix incompatible key generations.

Correction: define key custody, encrypted persistence, backup, rotation and key-version metadata. Separate this from deliberate per-record revocation. A global lost key is data loss, not a lifecycle mechanism.

### 14. Circuit constraints need strengthening

Evidence: `circuits/roleProof.circom:40` and installed `circomlib/circuits/mux1.circom`.

Merkle path selectors are used by `Mux1` without explicit boolean constraints. The installed multiplexer computes an interpolation expression and does not constrain the selector to 0 or 1. Therefore the circuit accepts a broader relation than the documented binary path. This is a constraint defect; no concrete membership forgery was demonstrated here.

Correction: constrain each selector with `s * (s - 1) === 0`, add explicit role range constraints appropriate to the circuit, and test malformed witnesses. Recompile and regenerate/verify all dependent artifacts after circuit changes.

### 15. Trusted setup and regeneration instructions are unsafe for research security claims

Evidence: `scripts/setupCeremony.js:107` through `:121` and `:161`.

Phase 2 skips secret contributions and uses a publicly fixed byte sequence as its beacon. This is a development setup, not a defensible ceremony for adversarial soundness claims. An appropriate secret contribution and verified transcript are required. The printed instruction to overwrite `ZKPVerifier.sol` would destroy the wrapper used by the deployment script; the deployed generated implementation is `Groth16Verifier.sol`.

Correction: follow the documented contribution/verification procedure, record artifact hashes and provenance, preserve the wrapper, and automate exporting the implementation and rebuilding dependents. Do not run the current ceremony just to refresh a demo: it can desynchronize keys and deployed verifiers.

### 16. Role and workflow enforcement is incomplete

Registration checks only that a key is valid, so a Transporter can register donors/recipients. Several permission bits advertise update/transport/transplant capabilities for which there is no implemented organ state machine. There is no allocation reservation preventing conflicting assignments. Key issuer declares revocation-related symbols but has no credential/session revocation function.

Correction: define the actual permission matrix and enforce it on every protected API/contract action. Add an explicit organ lifecycle, allowed transition actors, allocation uniqueness, and credential/session invalidation if these are in scope. Otherwise narrow the claimed workflow.

### 17. Frontend and scale issues remain

- Manual scoring constructs `OrganRegistry` with a provider, while the view method checks `msg.sender`. Use a signer-connected contract or an explicit verified call context. This is separate from confidentiality: a view gate cannot keep public storage secret.
- “Find Best Matches” reads public mappings directly and bypasses that particular view gate. It ranks all pairs rather than producing a feasible one-to-one allocation.
- Each pair uses two API calls. With the shared 100 requests/15 minute limiter, even a 10×10 matrix requires at least 200 score/decrypt calls and hits the limit (before downloads and health polling). Use authorized batch jobs, bounded concurrency, quotas and pagination; consider BFV batching after correctness is established.
- Wallet account/network changes do not clear application authorization state. Generate ABI bindings, validate chain/deployment identity and react to wallet changes.
- The server hardcodes `deployments/localhost.json`; `.env.example` names differ from backend names; no explicit `.env` loader appears in config/server. Simply copying `.env.example` is insufficient unless environment variables are exported or loaded.
- `.gitignore` only excludes artifacts and node_modules. Add `.env` and appropriate secret/generated-local exclusions before adding real credentials.
- `stop-all.ps1` matches processes globally and can stop other projects' Hardhat/Vite/IPFS processes. Track this project's process IDs.
- The CLI proof generator and scratch script still build the full million-leaf tree. Consolidate duplicated Merkle logic; the optimization is not consistently applied across all entry points.
- The declared lint command lacks an evident ESLint configuration/dependency and Solidity parser. Establish a working, scoped lint command.

## Research document corrections

| Claim in report/slides/docs | Defensible current description |
|---|---|
| Role-scoped PFE functional keys | Public session authorization commitments; centralized BFV decryption; optional HKDF/AES helpers |
| ZKP authenticates professional role | Demo self-enrollment followed by a real membership proof; enrollment authority missing |
| No plaintext clinical data on-chain | Blood type and recipient urgency are plaintext on-chain |
| Credential never logged | Current service debug output logs it |
| Five clinical variables / extend to seven | Five ciphertext fields encode three conceptual inputs; only blood and HLA affect scoring |
| Urgency-weighted formula | Urgency term absent; HLA coefficient differs from PDF |
| HLA Merkle root | Frontend hashes a scalar and timestamp as an explicit placeholder |
| Permissioned PoA deployment | Local Hardhat development EVM; repository does not demonstrate a validator consortium |
| Complete GDPR-compliant lifecycle | Donor deactivation and best-effort local unpinning prototype |
| Working UI revocation | Stale frontend CID ABI currently contradicts contracts |
| 69+/72 tests | This run: 70 passing, 5 skipped; state exact environment and skipped coverage |
| Current five-ciphertext benchmark | Saved JSON predates the documented scoring changes; regenerate for a named revision |

The PDF's formula must use donor antigen × (1 − recipient antigen), not a plain antigen product if the latter is what the equation intends. Check that complements are rendered explicitly. The report's permission bit legend differs from `RoleRegistry.sol`.

The PDF says ptau power 12 while repository setup uses power 14; 2^12 is insufficient for the reported 5,391 constraints. React is declared as 19 in package.json, while the PDF lists React 18. References [8] and [18] still contain “Authors” placeholders. Verify all authors, DOI, venue and feature-comparison claims against original publications. This review did not independently verify every cited prior work or establish a “first system” novelty claim.

Cached-zero Merkle updates are an established implementation technique; report the speed improvement as an engineering optimization with a baseline, not a new cryptographic method. Adding ML-KEM/ML-DSA alone would not make the full stack post-quantum: Groth16/BN128 and Ethereum transaction authentication remain relevant dependencies.

## Recommended next work

### Stage 1 — Make the current prototype honest and runnable

Fix UTF-8/build and ABI generation; remove credential logging; disable unrestricted privileged routes; add actual enrollment; authenticate APIs and enforce permission/expiry/revocation checks; stop accepting arbitrary ciphertext decryption. Remove plaintext clinical metadata from new contract designs. Align the report with the actual BFV trust model. Complete when an unregistered/expired/wrong-role user is rejected by both direct API calls and the UI, while an approved user's complete flow works.

### Stage 2 — Make data and lifecycle survive failures

Add versioned key custody and ciphertext schemas; canonical CID binding; persistent revocation jobs with catch-up/retries; recipient revocation; bounded scheduled processing. Complete when a record registered before a backend restart still scores correctly and revocation requested during worker downtime is completed after recovery.

### Stage 3 — Define and validate matching

Choose kidney-specific eligibility and allocation rules with domain guidance. Replace the scalar-HLA proxy or explicitly retain it as synthetic. Specify urgency priority, exceptions and tie-breaking. Compare encrypted outputs against an independent plaintext implementation over all supported blood pairs, parameter boundaries and randomized inputs; test quantization error, modular bounds and BFV noise budget. Only then extend to ischemia time/distance or add constrained assignment.

### Stage 4 — Produce a reproducible research evaluation

Record commit/artifact hashes, hardware, versions, seeds, parameter sets and raw samples. Repeat latency runs with warmups and medians/p95; separate enrollment, proof generation, verification, IPFS, evaluation, decryption and finality. Correct the benchmark label claiming revocation gas includes the request: the helper measures only the returned execution transaction. The current pipeline benchmark excludes IPFS, HTTP, browser and network finality, so do not call it complete application latency.

Add adversarial regression coverage for arbitrary-role enrollment, proof theft, unauthorized/expired decrypt, wrong-CID cleanup, listener downtime, key restarts, malformed selectors and the actual browser lifecycle. Existing E2E tests use mock CID strings and invoke services directly, so they do not validate Express authentication or the live IPFS/browser pipeline. Some verifier tests allow broad errors or do not require an event to exist; tighten those assertions.

Compare meaningful baselines under the same workload: plaintext RBAC, BFV+RBAC, and BFV+ZKP authorization. Measure the cost and privacy benefit of each mechanism. Deploy to a controlled multi-node network after these boundaries work; Sepolia alone will not demonstrate consortium governance.

## Suggested research framing

For the practical BFV direction, an accurate working title is:

**“ZKP-Authorized Homomorphic Matching and Auditable Data Revocation for Organ Donation.”**

Possible research questions: What additional privacy does ZKP membership provide over wallet RBAC? What does it cost? Which outputs can each role learn? How does the system recover from key/service/listener failure? What revocation guarantee remains when ciphertext replicas or prior outputs exist? These questions can produce a stronger contribution than adding more components without a supported threat model.

## External sources consulted

- Microsoft SEAL overview: https://www.microsoft.com/en-us/research/project/microsoft-seal/
- Microsoft SEAL security model and decryption warning: https://github.com/microsoft/SEAL/blob/main/SECURITY.md
- Boneh, Sahai and Waters, functional encryption overview: https://www.cs.utexas.edu/~bwaters/publications/papers/bsw-cacm-survey.pdf
- IPFS persistence and local garbage collection: https://docs.ipfs.tech/concepts/persistence/
- NIDDK kidney transplant matching/crossmatch: https://www.niddk.nih.gov/health-information/kidney-disease/kidney-failure/kidney-transplant
- BIDMC kidney transplant preparation (Rh does not affect matching): https://www.bidmc.org/-/media/files/beth-israel-org/centers-and-departments/transplant-institute/bidmc-preparing-for-kidney-transplant.pdf
- GDPR text, especially Articles 5 and 17: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- Circom proving/setup procedure: https://docs.circom.io/getting-started/proving-circuits/
