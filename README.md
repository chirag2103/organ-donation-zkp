# ZKP-Authorized Homomorphic Matching and Auditable Record Revocation

Synthetic research prototype, protocol v2. The backend is a **trusted BFV encryption/decryption service**. Browser Groth16 proofs authorize approved role membership; they do not hide wallet activity. This is not functional encryption, clinical allocation or a GDPR compliance determination.

The authoritative behavior, interfaces, trust model and equation are in [docs/PROTOCOL_V2.md](docs/PROTOCOL_V2.md). The prior prototype is preserved by commit and local archive in [historical/README.md](historical/README.md).

## Requirements

- Windows, Node 22.19.x, npm 10; the built-in SQLite API emits an experimental warning.
- Existing `circom.exe` and `circomlib` for circuit rebuilding.
- Kubo (`ipfs.exe`) for real encrypted storage; provide `IPFS_BINARY` if it is not on PATH.
- MetaMask or a compatible wallet for manual use. The automated demo uses installed Edge through Playwright and a development-wallet adapter.
- The local Hardhat mnemonic/accounts are public test fixtures. Never use their keys on real networks or expose the development RPC publicly.

## Prepare once

```powershell
npm ci
npm run init:local
npm run circuit:compile
npm run ceremony
npm run compile
npm run build:frontend
```

`init:local` creates an ignored `.env` with a random wrapping secret without printing it. Preserve that secret and the runtime database securely; losing the secret loses access to stored keys. `ceremony` adds a real secret phase-two contribution and verifies the transcript. It inherits a local phase-one transcript and does not claim an independent multiparty setup. It updates the generated implementation, never the verifier wrapper.

## Run the application

```powershell
.\start-all.ps1
# Equivalent supervisor: node scripts/localStack.js
```

The supervisor starts a fresh local Hardhat deployment, isolated local Kubo repository (API 5001, gateway 18080), API and Vite, writing logs and owned process IDs under `runtime/local-stack`. Keep the terminal open. Open http://localhost:5173 manually and select chain 31337 in the wallet. Stop with Ctrl+C or `.\stop-all.ps1`. Existing occupied service ports cause startup failure rather than reuse of an unknown stack. Each fresh chain uses a deployment-bound data namespace; old records are not migrated.

The API honors `PORT` in `.env` or the shell; the supervisor and frontend proxy use the same value. Windows denied binding to port 3001 on the tested machine, so its ignored local `.env` uses `PORT=13001`. A fresh deployment, API/frontend/proxy readiness and scoped shutdown were verified with that setting. The default example remains 3001; set another available port when needed.

To run services manually: start `npm run node`, deploy with `npm run deploy:local`, start a Kubo daemon, then `npm run server` and `npm run frontend`. Ensure configured RPC/IPFS URLs and deployment match. Backend binds to loopback only. A standalone production frontend must set `VITE_API_URL` or provide an `/api` reverse proxy; development uses the Vite proxy.

## Approve membership and authenticate

The Connect wallet button requests a switch to the deployment's chain through MetaMask. Approve the prompt; if the local Hardhat network is missing, the app requests adding it with the correct RPC URL first. A saved network still needs to be selected for the site. Rejected or already-pending wallet prompts are reported explicitly. Account/network changes clear authorization and credentials, so connect before importing your credential file.

1. In Access, connect the wallet and create/download a role credential file. Keep its secret private.
2. The institution administrator reviews the participant independently, then approves the **public leaf** displayed by the browser:

```powershell
npm run admin -- enroll 0 <publicLeaf>
# Remove an enrolled credential; all older sessions for this role become invalid:
npm run admin -- remove 0 <publicLeaf>
# Reconcile a pending root publication after a failed admin transaction:
npm run admin -- reconcile 0
```

3. Click Authenticate approved role. The browser proves membership locally, submits the wallet-bound proof and signs a one-use API challenge.
4. Register synthetic donor/recipient records, evaluate eligible pairs and run ranking batches.
5. Authenticate a separately approved Surgeon credential to revoke either record type. Check cleanup state after deactivation.

Role root updates invalidate existing role sessions. Local administrator tooling uses the unlocked development owner; outside local development it requires `ADMIN_PRIVATE_KEY` supplied to the administrator process only. Never put it in the service `.env`.

```powershell
npm run admin -- revoke-session <wallet>
npm run admin -- schedule <recordId> <unixSeconds>
npm run admin -- retry <recordId>
```

There are no public self-enrollment, proof-generation, arbitrary decryption, ciphertext-download or direct-unpin APIs. New record preparation is two-phase: encrypted upload, wallet registration, API confirmation. The UI permits retry after a wallet transaction failure. Pending uploads require operator retention review if abandoned; they are not silently counted as registered records.

## Synthetic policy

ABO eligibility precedes ranking. Rh is excluded. Six binary synthetic tissue markers are a toy representation, not clinical HLA typing. With mismatch count `m` and recipient urgency `u` in 0/1/2:

```
N = 4200 - 700*m + 900*u     # evaluated under BFV
S = round(N / 6)           # released for eligible pairs only
```

Weights are experimental. Ineligible pairs receive no score. Scores are ranking points, not compatibility percentages, and ranking does not reserve or allocate organs.

## Verification and evaluation

```powershell
npm run lint
npm test
npm run build:frontend
# Actual browser + API + isolated Kubo + local blockchain:
$env:IPFS_BINARY = '<absolute path to ipfs.exe>'  # if needed
npm run demo
# Same live acceptance as a test, otherwise explicitly skipped by npm test:
$env:RUN_LIVE_E2E = '1'
npm run test:integration
# Compile, export ABIs, check sources, build and run the full suite with live acceptance:
npm run verify
# Dedicated sequential performance run; avoid other tests/dev workloads:
npm run benchmark
```

`npm test` runs protocol-v2 tests; historical tests are preserved but not treated as validation of the incompatible revision. The live demo stores ignored runtime logs, synthetic credential fixtures and a completion screenshot. Published evidence excludes keys and credentials. Browser tests use an EIP-1193 adapter, not the MetaMask extension interface.

Benchmarks retain 10 warmups and 30 measured repetitions, raw samples, median/p95, machine details, source hashes and artifact metadata. Authenticated HTTP workloads compare plaintext wallet RBAC, BFV wallet RBAC and BFV ZKP authorization for 1x1, 5x5 and 10x10 matrices. Benchmark-only quotas are raised in its isolated harness; production defaults stay enforced. The plaintext baseline holds synthetic input in memory, while BFV retrieves encrypted records from real Kubo, so differences include storage/protection costs. Node proof timing is not browser latency. Results and evidence live in `paper/evaluation-v2/`; old root-level benchmark files are historical.

## Research documents

- [Protocol and threat model](docs/PROTOCOL_V2.md)
- [Updated Phase II report PDF in the supplied two-column layout](paper/phase2-report-2026-10-23/organ_donation_report_updated.pdf)
- [Editable report source](paper/phase2-report-2026-10-23/organ_donation_report_updated.tex) and [self-contained report ZIP](paper/phase2-report-2026-10-23.zip)
- [Report build instructions and evidence notes](paper/phase2-report-2026-10-23/README.md)
- [Earlier single-column article](paper/report-v2.tex)
- [Revised presentation source](paper/slides-v2.tex)
- [Verified bibliography and unresolved candidates](paper/bibliography-verification.md)
- [Paper claim-to-evidence map](paper/claim-evidence-v2.md)
- [Completed benchmark tables](paper/evaluation-v2/benchmark-v2.md) and [raw samples](paper/evaluation-v2/benchmark-v2.json)
- [Standalone workload figure](paper/evaluation-v2/workload-latency.pdf)
- [Frozen source/evidence hashes](paper/evaluation-v2/revision-manifest.json)
- [Implementation status and remaining limits](IMPLEMENTATION_V2.md)

From the `paper` directory, use `pdflatex report-v2`, `bibtex report-v2`, then run `pdflatex report-v2` twice; build `slides-v2.tex` with pdflatex. A LaTeX installation is required. Results are included from generated TeX snippets when available. Original Downloads files remain intact.

After a complete benchmark, `npm run results:render` regenerates the manuscript tables and standalone latency figure. The renderer uses Matplotlib when installed, otherwise ReportLab for PDF/SVG; the tested plotting dependency is recorded in `paper/evaluation-v2/plotting-requirements.txt`. Install it in a separate Python environment when reproducing the figure. Incomplete `.partial.json` output is never used as final results.

## Operational limits

The API sees submitted attributes and owns the BFV secret. Metadata and approved scores can leak information. Local key removal/unpin/GC does not erase backups, remote replicas, copied keys or past outputs. Deep confirmed-chain changes halt cleanup for operator audit. Keys are prototype custody in SQLite, not an HSM. This local single-process system is not ready for patient data or public deployment. See the protocol for quotas, state transitions and exclusions.
