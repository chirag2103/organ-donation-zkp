# Protocol v2 implementation status

The requested revision is implemented as a synthetic, local research prototype. [docs/PROTOCOL_V2.md](docs/PROTOCOL_V2.md) is the authoritative model and trust specification. The original prototype remains available at baseline commit `5edd45f2a6f5abff6b65992a04a4e1c41cf0933a` and the ignored local archive `historical/prototype-5edd45f.zip`.

## Implemented

- Administrator-approved multi-member Poseidon trees, browser-generated random credential files and browser-worker Groth16 proofs; no credential-accepting backend API.
- Explicit boolean selectors, role constraints, wallet/chain/issuer/root-version proof binding, nullifier replay rejection, four-hour authorization and explicit session revocation.
- Wallet-signed single-use API challenges, hashed bearer-token persistence, current on-chain permission/expiry/version checks and wallet-change UI invalidation.
- Canonical record-ID operations; no public arbitrary ciphertext decryption, raw ciphertext download, self-enrollment or unpin APIs.
- Plaintext clinical fields removed from new contracts. Encrypted bundles are wrapped per record, stored on Kubo and anchored by opaque IDs/content commitments.
- Encrypted-at-rest BFV secret and record keys; deployment-specific SQLite namespaces, restart recovery and explicit failure on wrong/missing keys.
- ABO eligibility before synthetic feature/urgency ranking. No Rh penalty, scalar-HLA proxy, compatibility percentage or unsupported optimal allocation.
- Owner-bound, bounded batch jobs and quotas; authorization/activity rechecks before releasing results.
- Donor and recipient revocation; canonical cleanup targets, durable event catch-up, confirmation depth, visible cleanup errors, backoff/retry and bounded schedule processing.
- Generated frontend ABIs, fixed UTF-8 stylesheet, production frontend build, scoped startup/stop tooling, environment/key handling and CI verification workflow.
- Revised paper, slides, bibliography verification notes and a statistical benchmark harness. Original Downloads documents were preserved; revised sources are under `paper/`.

## Validation evidence

The archived full run with `RUN_LIVE_E2E=1` completed **28 passing tests, no skips**. After the later wallet changes, the 23 October default regression completed **35 passing tests and one explicit infrastructure skip**; its eight wallet tests are included in the 35. These are separate runs, not a combined all-live result. The default `npm test` intentionally skips the infrastructure test unless explicitly enabled; run `npm run demo` for the live demonstration independently. Current output is retained in [regression-tests.txt](paper/phase2-report-2026-10-23/evidence/regression-tests.txt).

The suite exercises all ABO pairs and urgency levels, every mismatch-count boundary, seeded synthetic cases, BFV noise-budget positivity, restart key recovery, role enforcement, wrong-wallet/domain/version/replay rejection, two real members of a role, malformed selector rejection, signed challenge misuse, batch ownership and cleanup recovery/failure handling.

The real browser demonstration passed eleven checks against an isolated Kubo daemon and fresh local Hardhat chain, including revocation while the API was offline, successful catch-up after recovery and fail-closed startup when the key database is missing. Its published summary is [paper/evaluation-v2/browser-acceptance.json](paper/evaluation-v2/browser-acceptance.json). It uses an EIP-1193 development-wallet adapter rather than automating the MetaMask extension UI.

`npm run lint`, `npm run compile` and `npm run build:frontend` passed. Versioned v2 proving artifacts were generated and their setup transcript verified. The dedicated research benchmark completed all nine baseline/workload combinations, each with ten warmups and thirty measured samples, plus separately measured authorization and revocation stages. No transport retries occurred in the completed run. [Raw samples](paper/evaluation-v2/benchmark-v2.json), [tables](paper/evaluation-v2/benchmark-v2.md), generated manuscript tables and [standalone figures](paper/evaluation-v2/workload-latency.pdf) are available. `.partial.json` remains progress only. Historical root-level numbers are not reused.

The local supervisor was also checked with a fresh deployment, real Kubo, API, frontend, configured API proxy and scoped shutdown. Its [startup evidence](paper/evaluation-v2/local-startup.json) records the tested ports. This machine denies port 3001, so the ignored local `.env` uses API port 13001; the launcher and frontend honor that configuration.

The [revision manifest](paper/evaluation-v2/revision-manifest.json) freezes source and published evidence hashes. Changes are uncommitted; the recorded parent commit alone is not the revised source identity. Benchmark-specific source/artifact hashes are also retained with the raw measurements.

Production dependency audit after removing the old IPFS client and applying compatible patches: **0 critical, 0 high, 2 moderate**. The recorded audit is [paper/evaluation-v2/dependency-audit.json](paper/evaluation-v2/dependency-audit.json). This is not a full security audit or a claim that development dependencies have no advisories.

## Explicit limitations

- The service is trusted with submitted plaintext and a general BFV secret; it is not FE. Authorized outputs can leak relationships, especially across chosen-record queries.
- Wallets, roles, timestamps and record metadata remain linkable. High-entropy commitments do not provide anonymous enrollment or unlinkable blockchain activity.
- Six binary tissue markers and ranking coefficients are synthetic, not clinically validated HLA/allocation rules. No real patient data should be loaded into this prototype.
- Key persistence is a local encrypted SQLite design, not HSM custody. Operator wrapping-secret/backup retention remains essential. Live key removal does not guarantee forensic deletion from old backups or copied files.
- Local unpin/GC and service key deletion cannot recall remote IPFS replicas, previously copied keys or released outputs. A confirmed-history change halts cleanup for operator audit; irreversible deletion cannot be rolled back.
- Abandoned prepared-but-unregistered uploads are capped per wallet and need operator retention review; they are not automatically erased under an untested policy.
- Application matching jobs interrupted by restart are marked failed and resubmitted, rather than resumed using persisted bearer tokens. Revocation cleanup jobs do resume.
- The setup has one local secret phase-two contributor and an inherited local phase-one transcript. No independent multiparty setup is claimed.
- Performance is measured locally and distinguishes Node proof timing from browser acceptance. It does not establish public-network finality, consortium throughput or clinical benefit.
- Manual MetaMask extension testing, a hospital pilot, clinical review, production deployment, actual FE and post-quantum migration remain outside the agreed scope.
- The formatted Phase II report was compiled and checked as an [eight-page PDF](paper/phase2-report-2026-10-23/organ_donation_report_updated.pdf), with a [self-contained source bundle](paper/phase2-report-2026-10-23.zip). The revised presentation remains a LaTeX source; its final PDF has not been delivered.

## Next use

Follow the README to initialize the ignored wrapping-secret file, build artifacts and start the local supervisor. Generate credentials in the browser, approve only their public leaves through the administrator CLI and authenticate. Keep the baseline and new measurements separate. Review the revised paper with the supervisor using the stated trust model and verified bibliography before submission.
