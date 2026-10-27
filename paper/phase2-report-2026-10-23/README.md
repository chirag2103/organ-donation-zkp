# Updated Phase II report in the supplied layout

Main source: `organ_donation_report_updated.tex`.

Compiled report: [organ_donation_report_updated.pdf](organ_donation_report_updated.pdf), eight A4 pages. The rendered layout, citation resolution, numerical tables and page boundaries were checked. The retained build log includes nonfatal underfull-line and template font-substitution warnings.

The supplied report's two-column A4 article format is retained: 10-point type, one-inch top/bottom margins, 0.75-inch side margins, a 0.25-inch column gap, centered title/author block, Roman section numbering, lettered subsections, compact captions, wide figures/tables and IEEE-style bibliography. Author, roll number, institution and guides follow the supplied document. The report date is October 2026.

The content describes protocol v2: approved browser ZKP membership, wallet/API authorization, a trusted BFV encryption/decryption service, nine ciphertexts per record, encrypted Kubo storage and recoverable local revocation. Actual FE, clinical validation, anonymity, universal erasure, legal compliance and public/consortium deployment are not presented as implemented achievements.

## Build

From this directory with a standard TeX installation:

```text
pdflatex organ_donation_report_updated.tex
bibtex organ_donation_report_updated
pdflatex organ_donation_report_updated.tex
pdflatex organ_donation_report_updated.tex
```

Or, with Tectonic:

```text
tectonic --untrusted --keep-logs organ_donation_report_updated.tex
```

The deliverable ZIP is self-contained for a LaTeX editor such as Overleaf. Select `organ_donation_report_updated.tex` as the main document. Keep its `references.bib`, `tables/` and `figures/` alongside it. Generated tables require no Python during TeX compilation.

To regenerate the tables and copied evidence from the repository, run `python scripts/buildFormattedReport.py` from the repository root, then rebuild the PDF. This uses the completed original benchmark; it does not rerun or alter performance measurements.

## Evidence and interpretation

- Performance: the completed 22 October 2026 research benchmark, with 10 warmups and 30 measured samples per repeated timing metric, all nine workload configurations, gas, variability and raw samples. Initial dataset-registration gas has 20 samples; cold authorization and wallet-RBAC enrollment are individual samples.
- Archived complete validation: 28 passing tests, zero skips, including one infrastructure test containing 11 live checks.
- Current regression, 23 October 2026: 35 passing tests and one explicit infrastructure skip. Eight wallet-network tests are included in the 35, not an additional test total.
- Separate wallet UI browser check: six assertions using a simulated EIP-1193 provider. It is not actual MetaMask extension automation or proof of completed manual sign-off.
- The raw benchmark's source/artifact hashes identify the performance revision. `evidence/report-provenance.json` separately records current source hashes and the hashes of the supplied original documents.

Do not interpret small timing differences between fixed-order runs as a causal benefit of ZKP. Jobs use established sessions; proof generation and on-chain issuance are measured separately. The plaintext baseline uses in-memory records while BFV retrieves encrypted records from real Kubo. Local receipt/cleanup timings do not measure public-network consensus, external erasure or clinical outcomes.

## Bibliography and source preservation

`references.bib` uses verified entries from the corrected bibliography plus original BFV and Poseidon sources. The incorrect Block-Privacy author list/year in the supplied bibliography was corrected using the publisher record. Entries with placeholder authors or unverified primary contents are not silently reused as evidence. Literature-table descriptions avoid inferring feature absence from an abstract.

The original report and bibliography are preserved under `paper/source-layout/` in the repository. Their Downloads originals remain unchanged. No wallet keys, credential files, wrapping secrets, environment files or runtime databases are part of this report bundle.
