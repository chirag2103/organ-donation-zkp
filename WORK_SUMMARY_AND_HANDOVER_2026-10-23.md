# Research prototype: work summary and handover

**Prepared:** 23 October 2026, Asia/Calcutta  
**Project:** Organ donation research prototype, protocol v2  
**Research title:** ZKP-Authorized Homomorphic Matching and Auditable Record Revocation for Organ Donation

This document records the research revisions, implementation changes, troubleshooting, experiments and report preparation completed during this work. It distinguishes implemented behavior and recorded evidence from remaining validation. It contains no credential secrets, wallet private keys, wrapping secrets or environment-file contents.

The authoritative protocol and matching specification is [docs/PROTOCOL_V2.md](docs/PROTOCOL_V2.md). General operating instructions are in [README.md](README.md), with implementation status in [IMPLEMENTATION_V2.md](IMPLEMENTATION_V2.md).

## 1. Research direction and baseline preservation

- Reframed the research around approved role membership, browser-generated zero-knowledge proofs, authorized BFV computation, encrypted off-chain storage and recoverable local revocation.
- Identified the backend explicitly as a **trusted encryption/decryption service**. It sees submitted clinical attributes and holds the BFV decryption capability; this is not functional encryption.
- Removed unsupported claims of anonymous participation, clinically optimized allocation, guaranteed global erasure, blanket GDPR compliance and an established first-of-its-kind contribution.
- Kept actual FE/PFE, post-quantum security, independent hospital governance, clinical validation and optimal allocation as future work.
- Preserved the original prototype baseline at commit `5edd45f2a6f5abff6b65992a04a4e1c41cf0933a`; an ignored local archive is at `historical/prototype-5edd45f.zip`.
- Kept historical results separate from revision-specific experiments. Revised experiments use fresh synthetic records and isolated local deployments.
- Preserved the original user-supplied Downloads documents and existing unrelated user content.

The four research questions are:

1. Does approved ZKP membership enforce the intended authorization policy?
2. What latency and gas overhead does it add relative to wallet-based RBAC?
3. Does BFV reproduce the specified plaintext matching calculation?
4. Can registration and revocation recover correctly after service restarts and downtime?

## 2. Smart contracts

| Component | Completed change |
|---|---|
| [RoleRegistry.sol](contracts/RoleRegistry.sol) | Administrator-controlled role roots, root versions and explicit operation permissions; no public self-enrollment. |
| [PFEKeyIssuer.sol](contracts/PFEKeyIssuer.sol) | Verifies real membership proofs and issues four-hour authorization sessions. The historical filename remains, but it does **not** issue FE keys. |
| [OrganRegistry.sol](contracts/OrganRegistry.sol) | Stores opaque record identifiers, encrypted-content anchors, entity type, lifecycle state, registering wallet and timestamps. |
| [LifecycleManager.sol](contracts/LifecycleManager.sol) | Handles donor and recipient revocation, retention scheduling and bounded schedule processing. |
| [ZKPVerifier.sol](contracts/ZKPVerifier.sol) | Preserved verifier wrapper around the generated seven-public-signal Groth16 verifier. |
| [WalletRBAC.sol](contracts/benchmark/WalletRBAC.sol) | Separate experimental baseline; not the normal application authorization mechanism. |

Additional protections include proof nullifier replay rejection, wallet/chain/issuer binding, current root-version checks and explicit session revocation. Changing a role root invalidates existing authorization for that role and requires authentication again.

Plaintext ABO, tissue features, urgency and placeholder HLA roots were removed from the revised record contract. The anchor is derived from the canonical CID; raw CIDs are not written as clinical record fields on-chain. Wallets, identifiers, entity types, transactions and timestamps remain observable.

### Implemented role policy

| Role ID | Role | Register donor | Register recipient | Request matching | Request revocation |
|---|---|---|---|---|---|
| 0 | Doctor | Yes | Yes | Yes | No |
| 1 | Coordinator | Yes | Yes | Yes | No |
| 2 | Procurement | Yes | No | Yes | No |
| 3 | Matching | No | No | Yes | No |
| 4 | Transporter | No | No | No | No |
| 5 | Surgeon | No | No | Yes | Yes |

Enrollment/removal, retention schedules, cleanup retries and administrative session revocation use the administrator CLI. No transport or transplant workflow is claimed as implemented.

## 3. Enrollment, credentials and browser proofs

- Browser credential generation creates a random 248-bit secret and exports a local credential JSON file.
- The public membership leaf is the role-bound commitment `Poseidon(secret, roleId)`.
- An administrator approves the public leaf through the CLI. Credential generation or import alone grants no role.
- Persistent, multi-member role trees support more than one approved participant per role. Login reads membership data without changing roots.
- The circuit uses a depth-20 Poseidon Merkle tree, constrains path selectors to booleans and constrains supported role IDs.
- The seven public signals are Merkle root, role ID, nullifier, recipient wallet, chain ID, issuer address and root version.
- Proofs bind authorization to the intended wallet, chain, issuer and approved root version.
- [src/prover.worker.js](src/prover.worker.js) performs real proof generation in a browser worker using versioned WASM and proving-key artifacts with hash checks.
- Missing cryptographic artifacts cause explicit failure. Automatic mock-proof fallback and credential logging were removed.
- [scripts/prepareCircuit.js](scripts/prepareCircuit.js) generates and verifies dependent setup artifacts together, including a genuine secret phase-two contribution and the generated verifier.

Recorded circuit information: **13,513 constraints, 13,538 wires, 42 private inputs and seven public inputs**, using the BN254/bn-128 proof system. The old circuit's constraint count and four-signal description are not used for the revision. Artifact identities are recorded in `circuits/build/manifest-v2.json` and the report provenance.

The setup has one local secret phase-two contributor and an inherited local phase-one transcript. Independent multiparty ceremony security is not established.

### Credential and wallet explanations provided

- A public enrollment leaf is a commitment, not a password or private credential. The secret file enables creation of proofs for that approved leaf.
- Importing the JSON reads it locally with browser file APIs. It is not uploaded to the API. Worker messages remain between the page and its browser worker.
- The backend receives the public information needed for authorization, not the credential secret. Browser/API evidence checks request bodies for secret leakage.
- This does not protect the secret from malicious frontend code, privileged extensions or theft of the local file. A stolen secret can create fresh proofs; enrollment is not permanently bound to the first wallet.
- Hardhat account numbers and application role IDs are different concepts. Importing an account into MetaMask does not enroll it as a Doctor or Surgeon.

## 4. API authorization and access-path changes

Implemented wallet-signed, single-use challenges with a five-minute lifetime. Challenges bind the wallet, origin, chain and issuer. API bearer tokens are stored as hashes, and API sessions cannot outlive on-chain authorization.

Every protected operation rechecks current authorization, role permissions, expiry and root version. Job-result release also checks authorization and job ownership. Account/network changes, invalid sessions and stale asynchronous UI results clear or invalidate frontend authorization state.

Removed public paths that could register roots, self-enroll, decrypt arbitrary ciphertexts or directly unpin caller-selected content. The service chooses the supported computation and resolves canonical records; clients cannot supply arbitrary ciphertexts, scoring weights or decryption functions.

Normal API startup does not require the administrator signing key. Enrollment authority remains outside the normal API process.

Main interfaces implemented:

| Interface | Purpose |
|---|---|
| `GET /api/config`, `GET /api/status` | Public deployment/configuration and service status. |
| `POST /api/auth/challenge`, `POST /api/auth/session` | Wallet challenge and authenticated API session. |
| `DELETE /api/auth/session` | End the API session. |
| `GET /api/roles/:roleId/membership` | Public membership information for proving. |
| `POST /api/records`, `POST /api/records/:id/confirm` | Prepare encrypted registration and confirm its on-chain transaction. |
| `GET /api/records` | Authorized record listing. |
| `POST /api/matches/evaluate` | Evaluate canonical donor/recipient IDs. |
| `POST /api/matches/jobs`, `GET /api/matches/jobs/:id` | Bounded batch ranking and owner-authorized results. |
| `GET /api/records/:id/revocation` | Cleanup status. |

Quotas bound general requests, expensive work, pending registrations and concurrent/batch workloads. Each batch accepts at most ten donor and ten recipient IDs. Interrupted matching jobs become visibly failed and require resubmission; bearer tokens are not persisted inside jobs.

## 5. Encrypted storage and key persistence

- Added SQLite persistence using the supported Node 22 SQLite API, with deployment-specific namespaces and stored public membership, canonical CID mappings, wrapped keys, sessions and cleanup state.
- Persisted versioned BFV key material encrypted at rest under an operator-provided wrapping secret.
- Added per-record AES-GCM data keys around BFV record bundles before Kubo/IPFS upload. Data keys are separately wrapped in the database.
- Existing records remain usable across API restarts when the same deployment, database and wrapping secret are retained.
- Wrong/missing keys fail explicitly. A missing database with existing on-chain records also fails closed rather than silently generating replacement keys.
- Replaced the deprecated IPFS client dependency with a native HTTP Kubo adapter for upload, pin, retrieval, unpin and local garbage collection.
- Added retrieval bounds and timeouts; garbage-collection failures remain visible instead of being reported as successful cleanup.
- Normal APIs return permitted results, not raw BFV record bundles or general decryption access.

Core modules are [server/store.js](server/store.js), [server/crypto.js](server/crypto.js), [server/bfvService.js](server/bfvService.js), [server/storage.js](server/storage.js) and [server/service.js](server/service.js).

## 6. Exact synthetic matching model

ABO eligibility follows the ordinary demo policy: O can donate to O/A/B/AB; A to A/AB; B to B/AB; AB to AB. Rh and incompatible-transplant exceptions are outside this model.

The tissue model consists of six binary synthetic features, not clinically validated HLA typing. For donor features `d`, recipient features `r`, and recipient urgency `u` in `{0,1,2}`:

```text
m = sum((d[k] - r[k])^2), k = 1..6
N = 4200 - 700*m + 900*u
S = round(N / 6), released only when ABO-eligible
```

BFV evaluates the integer numerator. The trusted service decrypts and divides by six for authorized release. Donor urgency does not change ranking. Bounds are `0 <= m <= 6`, `0 <= N <= 6000` and `0 <= S <= 1000`.

Ineligible pairs display **“Ineligible under demo policy”** without a score. Eligible values are **synthetic ranking points**, not compatibility percentages. Ties sort by donor ID and then recipient ID. Ranking neither reserves nor allocates an organ.

ABO uses two encrypted bits and eligibility checks whether the donor has an antigen bit absent from the recipient. Each record has nine ciphertexts: two ABO bits, six features and urgency. The BFV configuration uses polynomial modulus degree 4096, 128-bit security defaults and actual plaintext modulus **1,032,193**. Values are replicated across slots; independent donor/recipient pairs are not packed into SIMD slots. Noise-budget and input-bound checks are included.

The independent reference and shared protocol code are in [shared/protocol.mjs](shared/protocol.mjs), with BFV implementation in [server/bfvService.js](server/bfvService.js).

## 7. Recoverable revocation

- Supports donor and recipient records, resolving cleanup targets from canonical record IDs rather than caller-supplied CIDs.
- Denies new matching access after confirmed on-chain deactivation.
- Persists cleanup jobs, processed event/block identities, retries and event-replay cursors.
- Replays missed revocation events after API downtime.
- Uses configurable confirmation depth: one block locally and six for later nonlocal experiments by default.
- Deletes the service-held record key, unpins canonical local content and runs local garbage collection.
- Reports requested, deactivated, cleanup pending, completed locally and failed states distinctly.
- Retries failed work with bounded exponential backoff and exposes administrator retry controls.
- Uses bounded, cursor-based retention schedule processing instead of unbounded scans.
- Halts for operator review when a processed block identity changes; irreversible cleanup cannot be rolled back.

Implementation: [server/revocation.js](server/revocation.js), [contracts/LifecycleManager.sol](contracts/LifecycleManager.sol), [scripts/admin.js](scripts/admin.js).

“Completed locally” means access denial and the defined local cleanup completed. It does not guarantee deletion of remote replicas, backups, copied keys or previously released results.

## 8. Frontend and local-network troubleshooting

- Rebuilt the revised UI around credential handling, approved-role authentication, encrypted registration, matching, batch progress and revocation status.
- Fixed stylesheet encoding and verified a production frontend build.
- Generated frontend ABIs from compiled contracts and corrected signer/deployment handling.
- Added clearer prerequisites near the disabled authentication control. A credential alone is insufficient: the backend must be available, a wallet connected on the expected chain and the public leaf approved.
- Added [src/wallet.mjs](src/wallet.mjs) to verify the actual provider chain and request `wallet_switchEthereumChain` during connection.
- Added local-chain setup when the wallet reports an unknown network, followed by an explicit switch and actual-chain recheck.
- Added useful errors for rejected requests, an already pending wallet request and a wallet remaining on the wrong network.
- Added eight wallet tests and a separate six-assertion browser check using a simulated EIP-1193 provider.
- Explained that creating a MetaMask network does not necessarily select that network for the connected site; connecting the dapp and selecting the site account are separate from importing a wallet.

Local wallet configuration: RPC `http://127.0.0.1:8545`, chain ID **31337** / hexadecimal `0x7a69`, currency symbol ETH. Connect the intended wallet/network before importing the credential because account/network changes deliberately clear authentication state.

Hardhat fixture accounts are available in `runtime/local-stack/hardhat.log`. Their private keys are intentionally excluded from this handover. They are public development fixtures, not accounts for real funds.

## 9. Startup, deployment and tooling

- Added local initialization, environment templates and ignored secret/runtime paths; pinned the supported Node runtime to 22.19.x through the Node 22 engine range and runtime configuration.
- Added [scripts/localStack.js](scripts/localStack.js), [start-all.ps1](start-all.ps1) and [stop-all.ps1](stop-all.ps1) to supervise the local chain, fresh deployment, Kubo, API and Vite.
- Scoped shutdown to recorded process IDs and creation times rather than broadly killing unrelated Node processes.
- Kept deployment/admin key variables out of normal API/frontend child-process environments.
- Added startup checks for occupied ports, deployed code, chain identity, deployment block identity and verifier artifacts.
- Fixed the API/proxy configuration after Windows denied port 3001 on this machine; the local configuration uses **13001** and is honored by startup and Vite.
- Tested the supervisor with a fresh deployment, real Kubo, API, frontend/proxy and scoped shutdown; evidence is in [local-startup.json](paper/evaluation-v2/local-startup.json).
- Added administrator commands for enrollment/removal, reconciliation, retention schedules, cleanup retry and session revocation.
- Added source checks, ABI export, isolated demonstration, benchmark and result-rendering scripts, plus a Windows verification workflow.

Typical local endpoints are frontend `http://localhost:5173`, Hardhat `http://127.0.0.1:8545`, API `http://127.0.0.1:13001`, Kubo API port 5001 and local gateway port 18080. Configuration remains authoritative if ports are changed.

A fresh supervised chain is different from restarting only the API. Fresh chain deployments use a new database namespace and require enrollment again. An existing credential may be reused by approving its public leaf on that deployment.

## 10. Recorded validation: keep runs separate

| Recorded run | Result | Interpretation |
|---|---|---|
| Archived complete v2 run, 22 October | **28 passed, 0 skipped** | Includes one live infrastructure test containing eleven checks. Predates later wallet UI tests. |
| Latest default regression, 23 October | **35 passed, 1 skipped** | Eight new wallet tests are included in the 35. Live infrastructure was explicitly skipped. |
| Separate wallet-network browser check | **6 assertions passed** | Simulated provider; not MetaMask extension automation. |
| Compilation, source checks and frontend production build | Passed in recorded validation | Does not replace a fresh full live run after subsequent changes. |
| Formatted report build | Eight-page PDF generated and checked | Citations resolved, layout inspected; nonfatal TeX warnings retained in logs. |

The eleven live checks cover rejected unapproved authentication; real browser proof generation and signed authorization; encrypted Kubo registration and opaque anchors; BFV matching; API restart recovery; bounded batch matching; donor revocation and local cleanup; recipient revocation during downtime and replay; restricted Transporter access; missing-database fail-closed startup; and absence of credential secrets in API request bodies.

Regression coverage includes all sixteen ABO combinations, urgency levels, mismatch boundaries, seeded synthetic cases, encrypted/reference agreement, positive noise budgets, key recovery, wrong/missing keys, multiple approved members of one role, proof signal mutation, nonboolean selectors, wallet/domain/version/replay failures, session expiry/revocation, direct API permissions, job ownership and cleanup retries/failures.

Evidence: [archived validation](paper/evaluation-v2/validation.json), [live browser acceptance](paper/evaluation-v2/browser-acceptance.json), [latest regression output](paper/phase2-report-2026-10-23/evidence/regression-tests.txt), [report provenance](paper/phase2-report-2026-10-23/evidence/report-provenance.json).

No completed manual MetaMask end-to-end sign-off is claimed. The earlier full live run and the later default regression must not be combined into an invented “36 passed, zero skipped” result.

## 11. Completed gas measurements

Source: [raw benchmark samples](paper/evaluation-v2/benchmark-v2.json). Gas is an execution quantity, not a fixed fiat price; local Hardhat ETH is test currency.

| Operation | Recorded gas | Measurement scope |
|---|---:|---|
| Wallet-RBAC baseline enrollment | 43,928 | One sample; baseline contract. |
| Approved role-root update | 36,537 | Median of 30 measured updates; not initial empty-role enrollment. |
| First authorization for a wallet | 367,339 | One cold issuance sample. |
| Subsequent ZKP authorization | 310,463 | Median of 30 warmed samples. |
| Record registration | 110,259 | Median of 20 initial dataset registrations. |
| Revocation request | 69,513 | Median of 30 measured samples. |
| Revocation execution | 58,717 | Median of 30 measured samples. |

Adding the request/execution medians gives approximately **128,230 gas** for the two revocation transactions, excluding enrollment and authentication. This sum is not a separately measured joint-distribution statistic.

Credential creation, local proof generation, wallet message signatures, BFV work, IPFS operations and local cleanup consume no blockchain gas themselves; they still consume computing/storage resources. Deployment, initial empty-role enrollment, explicit session revocation and keeper/schedule operations do not have separate measurements in this table.

## 12. Completed performance experiments

Ran three baselines through authenticated HTTP jobs: plaintext with wallet RBAC, BFV with wallet RBAC, and BFV with ZKP authorization. Each used 1×1, 5×5 and 10×10 workloads, with **ten warmups and thirty measured repetitions per repeated timing metric**. Retained raw samples, medians, p95, variability, environment details and source/artifact identities.

### Selected stage timings

| Stage | Median ms | p95 ms |
|---|---:|---:|
| Enrollment | 38.579 | 45.927 |
| Membership-path construction | 47.823 | 50.292 |
| Node proof generation, including path construction | 2,922.250 | 4,318.040 |
| Local verification transaction receipt | 10.446 | 11.763 |
| BFV encryption | 115.157 | 131.599 |
| BFV evaluation | 230.733 | 244.979 |
| Authorized BFV result release | 10.472 | 16.847 |
| Encrypted storage round trip | 42.027 | 107.348 |
| Direct local cleanup | 22.622 | 31.282 |

### End-to-end job timings

| Baseline | Workload | Median ms | p95 ms |
|---|---|---:|---:|
| Plaintext + wallet RBAC | 1×1 | 134.877 | 146.707 |
| Plaintext + wallet RBAC | 5×5 | 291.905 | 336.712 |
| Plaintext + wallet RBAC | 10×10 | 862.313 | 1,080.332 |
| BFV + wallet RBAC | 1×1 | 384.682 | 599.395 |
| BFV + wallet RBAC | 5×5 | 7,203.024 | 7,486.875 |
| BFV + wallet RBAC | 10×10 | 11,946.915 | 17,289.180 |
| BFV + ZKP authorization | 1×1 | 164.476 | 198.896 |
| BFV + ZKP authorization | 5×5 | 3,292.054 | 3,423.098 |
| BFV + ZKP authorization | 10×10 | 12,116.838 | 12,406.246 |

Interpretation and implementation work:

- Jobs reuse established sessions; proof generation and issuance are measured separately rather than repeated per pair/job.
- Plaintext records are in memory; BFV jobs retrieve real AES-wrapped Kubo records. These baselines do not isolate cryptography from storage cost.
- Timings include 100-ms result polling and fresh HTTP connections. Node proof timing is not a browser latency measurement.
- Implemented per-job record caching so each distinct encrypted record is fetched once, while authorization/activity checks remain in force.
- Improved benchmark polling robustness after an earlier interrupted run; completed research results record **zero transport retries**. Partial and smoke-run outputs are not final research evidence.
- Fixed-order runs on one machine do not establish that ZKP causes lower latency when one row happens to be faster. Counterbalanced independent runs remain useful future evaluation.
- Local receipt and direct cleanup timings exclude public-network finality, worker discovery/retry delay and external replica deletion.
- Recorded machine: Intel Core i7-12700H, 16 GB RAM, Windows, Node 22.19.0. Exact dependency versions and artifact hashes are in the raw evidence.

Deliverables: [benchmark tables](paper/evaluation-v2/benchmark-v2.md), [raw JSON](paper/evaluation-v2/benchmark-v2.json), [PDF plot](paper/evaluation-v2/workload-latency.pdf), [SVG plot](paper/evaluation-v2/workload-latency.svg), [plotting dependencies](paper/evaluation-v2/plotting-requirements.txt).

## 13. Research paper, presentation and formatted report

### Revised research sources

- Created [paper/report-v2.tex](paper/report-v2.tex), [slides-v2.tex](paper/slides-v2.tex), revised architecture/results sources and [references-v2.bib](paper/references-v2.bib).
- Added [bibliography verification notes](paper/bibliography-verification.md) and a [claim-to-evidence map](paper/claim-evidence-v2.md).
- Aligned title, abstract, contributions, architecture, protocol, matching model, security, retention discussion, evaluation and limitations with the implemented scope.
- Kept browser proof secrecy separate from enrollment correctness and documented wallet/metadata visibility and trusted decryption.

### Report generated using the supplied old format

Used the user-supplied `organ_donation_report_layout_fixed (1) (1).tex` and `references (1).bib` as source material. Preserved copies under [paper/source-layout](paper/source-layout); Downloads originals were not overwritten.

Retained the two-column A4 format, 10-point type, margins, title/author block, Roman sections, lettered subsections, compact captions and IEEE-style bibliography. The supplied author, institution and guide details were retained.

Rewrote the content for protocol v2, inserted exact matching equations, trust boundaries, four research questions, measured gas/timings/workloads, security limitations and reproducibility details. Corrected the Block-Privacy bibliography author/year information and excluded unsupported placeholder references. The formatted report has ten bibliography entries, including original BFV and Poseidon sources.

Delivered:

| Artifact | Location |
|---|---|
| Compiled eight-page report | [organ_donation_report_updated.pdf](paper/phase2-report-2026-10-23/organ_donation_report_updated.pdf) |
| Main LaTeX source | [organ_donation_report_updated.tex](paper/phase2-report-2026-10-23/organ_donation_report_updated.tex) |
| Self-contained source/evidence ZIP | [phase2-report-2026-10-23.zip](paper/phase2-report-2026-10-23.zip) |
| Report instructions and evidence caveats | [report README](paper/phase2-report-2026-10-23/README.md) |
| Content hashes | [package-manifest.json](paper/phase2-report-2026-10-23/package-manifest.json) |
| Table/evidence generation script | [buildFormattedReport.py](scripts/buildFormattedReport.py) |

Downloaded and verified a portable Tectonic compiler under ignored runtime tooling rather than installing it system-wide. Compiled and visually checked the report, corrected the architecture layout and pagination, verified citation resolution and page boundaries, and retained build logs. Nonfatal underfull-line/font-substitution warnings remain documented. The slides currently have a revised source; a final slides PDF has not been delivered.

The report records the original 22 October performance revision separately from current 23 October UI/source hashes. Generating report tables does not rerun experiments or relabel old measurements.

## 14. Dependency and evidence hygiene

- Removed the deprecated IPFS client and applied compatible dependency fixes/overrides.
- Recorded production audit: **zero critical, zero high and two moderate findings**. This is the saved audit result, not a full security assessment or a claim about every development dependency.
- Ignored credential/runtime databases, local environment files, wrapping material and generated local assets where appropriate.
- Excluded secrets and runtime databases from the report ZIP.
- Preserved raw measurements, setup/artifact identities, machine/dependency metadata, validation output, plot sources and report provenance.

The [evaluation revision manifest](paper/evaluation-v2/revision-manifest.json) freezes an earlier source/evidence snapshot. Later wallet and report changes are not retroactively part of that benchmark revision. Current work is uncommitted; the baseline parent commit alone does not identify the complete revised implementation.

## 15. Practical local workflow

From the repository PowerShell terminal:

```powershell
.\start-all.ps1
```

Keep the supervisor running. Open `http://localhost:5173`, connect the intended MetaMask account and select chain 31337. Generate/import the role credential, then approve **only its public leaf** in another repository terminal:

```powershell
# Replace PUBLIC_LEAF with the public commitment displayed by the browser.
npm run admin -- enroll 0 "PUBLIC_LEAF"
```

Return to the UI, authenticate the approved role, confirm the on-chain proof transaction and sign the API login challenge. Register synthetic records and confirm registration transactions before matching. For revocation, approve/authenticate a role-5 credential with the intended Surgeon wallet.

Useful administrator command forms, with placeholders replaced before execution:

```powershell
npm run admin -- remove 0 "PUBLIC_LEAF"
npm run admin -- reconcile 0
npm run admin -- revoke-session "WALLET_ADDRESS"
npm run admin -- schedule "RECORD_ID" "UNIX_SECONDS"
npm run admin -- retry "RECORD_ID"
```

Stop the supervised stack using:

```powershell
.\stop-all.ps1
```

Useful verification/reproduction commands:

```powershell
npm run lint
npm run compile
npm run build:frontend
npm test
npm run demo
npm run benchmark
npm run results:render
python scripts/buildFormattedReport.py
```

Run demonstration/benchmark profiles separately with their required ports available; stop a conflicting manual stack first. Benchmarks are lengthy and should run without unrelated workloads. `npm test` defaults to skipping live infrastructure. Table regeneration is separate from rebuilding the report PDF; follow the report README for TeX compilation.

Simple expected demo behavior: an O donor and A recipient with identical six features score 700 at urgency 0 and 1000 at urgency 2. An AB donor and A recipient are ineligible and receive no score. These are experimental synthetic points.

## 16. Remaining work and next steps

1. **Complete a manual MetaMask demonstration:** approved Doctor authentication, donor/recipient registration, matching, Surgeon authentication, revocation and observed cleanup status. Earlier troubleshooting is not completed end-to-end sign-off.
2. **Rerun the complete live validation after the wallet/UI changes:** retain a new exact pass/skip report and source identity rather than merging old and new totals.
3. **Review and freeze the revision:** inspect the current uncommitted changes, preserve user edits and create an identifiable reviewed source snapshot/commit. Do not substitute the baseline commit for the revised code.
4. **Review the formatted report with the guides:** confirm institutional details, research interpretation, limitations and bibliography before submission. Compile/finalize the presentation PDF.
5. **Address remaining moderate dependency findings** and document accepted residual operational risks.
6. **Strengthen performance comparisons if causal conclusions are needed:** counterbalance execution order, repeat independent runs and distinguish storage, proof, authorization and BFV costs.
7. **Review retention for abandoned uploads and backups:** pending-registration caps exist, but no untested universal-erasure policy is claimed.

Clinical validation, production key custody, independent multiparty setup, multi-hospital governance, actual functional encryption, post-quantum migration and public deployment remain future research/deployment work.

## 17. Current delivery status

The revised local synthetic prototype, automated demonstration/regression infrastructure, completed benchmark outputs, revised research sources and compiled formatted Phase II report are available in the repository. The principal remaining acceptance work is fresh live validation after the latest wallet changes, manual MetaMask sign-off, review/freeze of the uncommitted revision and final presentation preparation.

This handover documents existing work and evidence. Creating this file does not constitute a new benchmark, live acceptance run or cryptographic setup ceremony.
