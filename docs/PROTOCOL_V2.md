# Protocol v2: authoritative specification

Title: **ZKP-Authorized Homomorphic Matching and Auditable Record Revocation for Organ Donation**.

This is a synthetic research prototype on a local Hardhat development EVM. The backend is a trusted BFV encryption/decryption service. It sees submitted clinical inputs during encryption and holds general BFV secret-key capability. It is not functional encryption, anonymous authentication, a clinical allocation tool, a consortium deployment or a GDPR compliance determination.

## Actors and authorization

Six roles: Doctor (0), Coordinator (1), Procurement (2), Matching (3), Transporter (4), Surgeon (5).
Permission bits: match=0, register donor=1, register recipient=2, revoke record=3.
Masks: `[7,7,3,1,0,9]`. Administrator CLI controls enrollment, membership removal, session revocation, retention schedules and cleanup retries. The API never accepts an administrator private key. Local Hardhat accounts are public development fixtures and are not a secure institutional deployment.

The browser samples a 248-bit random credential secret. Its role-bound leaf is `Poseidon(secret, roleId)`. A separate administrator approves that public leaf. A persistent SQLite membership document contains an ordered list of leaves for each role. The depth-20 Poseidon tree has zero-valued unused leaves and explicitly boolean path selectors. Membership publication writes intent before the on-chain transaction; the API refuses inconsistent roots until `admin reconcile` succeeds. Every root change increments its version and invalidates all prior sessions for that role.

The browser worker proves knowledge of a credential and valid membership path. It fetches versioned WASM/proving artifacts and verifies their SHA-256 hashes against the server manifest. Private inputs never enter an API request. Public signal order is `[root, role, nullifier, recipient, chainId, issuer, rootVersion]`. The nullifier is:

```
Poseidon(secret, Poseidon(salt,
  Poseidon(recipient, Poseidon(chainId, Poseidon(issuer, rootVersion)))))
```

The contract checks recipient=`msg.sender`, current chain/issuer, current role root/version, unused nullifier and the Groth16 pairing relation. It issues a four-hour authorization session, not an encryption key. Owner or subject may revoke a session. Credential removal plus root update is required to prevent future proofs from that credential; revoking a session alone does not prevent its holder from authenticating again.

API login uses a five-minute, wallet-signed single-use challenge containing origin, chain, issuer, wallet, random nonce and expiry. The API stores hashes of random bearer tokens. Each protected request rechecks on-chain session validity, role and root version. API expiry is capped at on-chain expiry. Tokens remain in browser memory. Wallet/network changes and local expiry erase UI authorization and results. Local transport is loopback HTTP; remote deployment would require TLS and its own operational review.

## Records, trust and visibility

`POST /api/records` accepts `{entityType, attributes}` where entityType is 0 donor or 1 recipient; attributes are `{abo, features, urgency}`. `abo` is O/A/B/AB; features are exactly six binary synthetic tissue markers; urgency is an integer 0/1/2. The markers are not clinical HLA typing. Rh is not modeled. Donor urgency is accepted for schema symmetry but has no ranking effect.

The service encrypts two ABO antigen bits, six feature bits and urgency as nine BFV ciphertexts. Parameters: degree 4096, tc128 parameter validation, BFVDefault coefficient modulus, PlainModulus.Batching(4096,20). Integer inputs are not fixed-point scaled. Intermediate polynomial values are bounded and decryption checks a positive noise budget.

Each bundle has its own random AES-256-GCM data key and record-ID-associated authenticated data. Only this AES envelope is added to IPFS. The data key and versioned BFV secret key are encrypted under an operator-supplied 32-byte wrapping secret before SQLite persistence. Loss of that secret is unrecoverable. The service fails on missing BFV keys with existing records or a wrong wrapping secret; it does not silently replace them. BFV secret version 1 remains available for other records after one record's wrapping key is removed.

Preparation returns `{id,anchor,entityType,state}`. The browser submits `registerRecord(id,anchor,entityType)` from its authorized wallet, then confirms registration with the API. The anchor is keccak256 of the canonical CID of the AES-wrapped bundle. The chain stores only opaque IDs, anchors, entity type, activity, registrant wallet and time. These are public and linkable. There is no plaintext ABO, feature vector, urgency or CID on-chain. The API validates record owner/type/anchor/activity against the chain before evaluation. Direct contract records without canonical service data cannot be scored.

No normal API returns raw BFV bundles or accepts arbitrary ciphertexts, weights, evaluation functions or requested cleanup CIDs. The service retains general plaintext and decryption access by design. Authorized scores can leak relationships and, with chosen records/repeated queries, information about inputs. Fixed outputs and quotas do not establish FE, differential privacy or prevention of inference attacks. Only synthetic data is permitted in this prototype.

## Eligibility and ranking

Eligibility is the ordinary synthetic ABO policy: O to any ABO; A to A/AB; B to B/AB; AB to AB. It is computed as the encrypted incompatibility count `A_d*(1-A_r)+B_d*(1-B_r)`. Only zero is eligible. Incompatible-transplant exceptions are outside scope.

For eligible pairs only, with six binary feature values:

```
m = sum((d[k]-r[k])^2, k=0..5)
u = recipient urgency, in {0,1,2}
N = 4200 - 700*m + 900*u
S = round(N/6)
```

The service evaluates N under BFV, then releases S after approved decryption. Bounds: 0 <= m <= 6, 0 <= N <= 6000, 0 <= S <= 1000. Experimental weights are not clinically validated. Ineligible results are `{eligible:false,score:null}`; no score or percentage is displayed. Eligible results are synthetic ranking points. Sort eligible first, score descending, donor ID ascending, recipient ID ascending. No reservation, transplantation state machine or optimal assignment is implied.

## API and quotas

- `POST /api/auth/challenge` `{address}` -> `{nonce,message,expiresAt}`.
- `POST /api/auth/session` `{nonce,signature}` -> `{token,address,roleId,rootVersion,expiresAt}`.
- `DELETE /api/auth/session` invalidates the current bearer token.
- `GET /api/config` returns public deployment, role and artifact metadata.
- `GET /api/roles/:roleId/membership` returns public leaves, root and version.
- `POST /api/records` prepares encrypted storage; `POST /api/records/:id/confirm` verifies the wallet's registration.
- `GET /api/records` returns authorized nonclinical record metadata.
- `POST /api/matches/evaluate` `{donorId,recipientId}` returns only the approved result.
- `POST /api/matches/jobs` `{donorIds,recipientIds}` creates a batch; each side has 1..10 distinct IDs.
- `GET /api/matches/jobs/:id` is owner-only and rechecks authorization and record activity.
- `GET /api/records/:id/revocation` reports local cleanup state.

Limits: 1000 general requests/IP/15 minutes; 100 expensive requests/IP/15 minutes; one active batch/wallet; 200 submitted batch pairs/wallet/15 minutes; at most 20 pending registrations/wallet. A 10x10 batch uses one job request, not 200 public compute/decrypt calls. Each job caches encrypted BFV bundles so distinct records are fetched/unwrapped once, then discards the cache at completion/failure; authorization and canonical activity are still checked for each evaluation and result retrieval. Browser result release and batch retrieval recheck current activity; prior copied outputs cannot be recalled. Interrupted batch jobs are marked failed on restart and must be resubmitted; bearer tokens are never persisted in job records.

## Revocation and recovery

The surgeon requests and executes revocation by opaque record ID for either entity type. No caller-selected CID is accepted. Confirmed chain deactivation immediately blocks new evaluations, independently of cleanup completion.

The durable worker scans ordered request/execution logs in bounded block ranges, checkpoints block/hash/index metadata and queues canonical cleanup jobs. Default confirmation depth is one locally and six outside local development. A detected change in already-processed block history halts cleanup for administrator audit; key deletion cannot be undone. This is not a claim of perfect reorg recovery.

Cleanup removes the service-held wrapped data key, unpins the canonical CID and performs local Kubo GC. GC/unpin failure remains failed and retries with exponential backoff capped at one hour; an administrator may queue an immediate retry. States: requested, deactivated, cleanup pending, completed locally, failed. The on-chain deactivated state remains authoritative for access denial. Retention processing inspects at most 50 entries/call, using a wraparound cursor so future entries are revisited. A local keeper submits the permissionless processor from a development account.

Deleting keys from the live database is not a guarantee of forensic destruction across WAL, backups, disks, administrator copies, previously unwrapped data or remote IPFS replicas. The wrapping secret and backups require an operator retention policy. This mechanism demonstrates local retention/access revocation, not universal erasure or legal compliance.

## Reproducibility and exclusions

Pin Node 22.19, retain lockfile and artifact hashes, and preserve the baseline commit archive. The revised Groth16 setup uses a real secret phase-two contribution and verifies the transcript against R1CS and prepared ptau. It inherits a local phase-one setup and remains a single-contributor development trust assumption; no independent multiparty ceremony is claimed.

Use a fresh deployment/data namespace. Existing v1 ciphertexts/contracts are intentionally incompatible. The tests distinguish mocked storage/chain checks from real Groth16 and live Kubo/browser evidence. Synthetic comparison baselines and stage timing are not deployment throughput or evidence of clinical benefit. Proving timing includes witness/path construction. Repeated timing experiments, including local transaction receipts and direct revocation cleanup, use ten warmups and thirty measured samples. Receipt timings are local EVM diagnostics, not public-network consensus time; direct cleanup excludes worker discovery/retry delay. Gas samples distinguish initial issuance from subsequent updates of the same wallet session. PFE, post-quantum primitives, multi-institution governance, clinician-approved models, production key custody and public deployments remain future work.
