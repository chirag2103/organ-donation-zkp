# Preserved prototype baseline

The original tracked prototype was preserved before v2 edits with:

`git archive --format=zip --output=historical/prototype-5edd45f.zip 5edd45f2a6f5abff6b65992a04a4e1c41cf0933a`

The local archive is ignored by Git because it includes generated cryptographic artifacts. The original commit remains the reproducible source reference. Original `benchmark_results*`, `PROGRESS*`, legacy tests and review describe that historical implementation and are not v2 validation evidence. V2 active tests live in `test/v2`; see `docs/PROTOCOL_V2.md` for current claims and `paper/evaluation-v2` for new evidence.
