> Historical protocol-v1 evidence. Superseded by docs/PROTOCOL_V2.md and paper/evaluation-v2; do not use these claims or measurements for v2.

# Comparison with Prior Work

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
| On-chain ZKP verification (gas)  | 375645 | N/A | Not reported |
| Proof generation time            | 3640.6 ms | Not reported | Not reported |
| Post-quantum resistance          | ❌ Future | ❌ No                | ❌ No                 |
