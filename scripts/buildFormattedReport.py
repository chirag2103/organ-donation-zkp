"""Generate evidence-linked tables/assets for the supplied-format Phase II report.

Run from the repository root. The authored main TeX and bibliography are preserved.
This does not rerun performance experiments or alter archived measurements.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "paper/phase2-report-2026-10-23"
EVALUATION = ROOT / "paper/evaluation-v2"
for subdir in ["tables", "figures", "evidence"]:
    (REPORT / subdir).mkdir(parents=True, exist_ok=True)

data = json.loads((EVALUATION / "benchmark-v2.json").read_text(encoding="utf-8"))
assert data["meta"]["complete"] and data["meta"]["profile"] == "research"
assert data["meta"]["samples"] == 30 and data["meta"]["warmups"] == 10
for values in data["timings"].values():
    assert values["samples"] == len(values["raw"]) == 30
assert sum(len(workloads) for workloads in data["workloads"].values()) == 9
for workloads in data["workloads"].values():
    for values in workloads.values():
        assert values["samples"] == len(values["raw"]) == 30

log_path = REPORT / "evidence/regression-tests.txt"
raw_log = log_path.read_bytes()
log = raw_log.decode("utf-16" if raw_log.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
passed = int(re.search(r"(\d+) passing", log).group(1))
skipped_match = re.search(r"(\d+) pending", log)
skipped = int(skipped_match.group(1)) if skipped_match else 0
assert not re.search(r"\d+ failing", log)

def tex(path, lines):
    (REPORT / path).write_text("\n".join(lines) + "\n", encoding="utf-8")

tex("tables/evidence-macros.tex", [
    f"\\newcommand{{\\CurrentTestsPassed}}{{{passed}}}",
    f"\\newcommand{{\\CurrentTestsSkipped}}{{{skipped}}}",
    f"\\newcommand{{\\ProofMedianMs}}{{{data['timings']['proofGeneration']['median']:,.2f}}}",
    f"\\newcommand{{\\EvaluationMedianMs}}{{{data['timings']['bfvEvaluate']['median']:,.2f}}}",
    f"\\newcommand{{\\VerificationMedianGas}}{{{data['gas']['verifyAndIssue']['median']:,.0f}}}",
])

stage_labels = {
    "enrollment": "Approved-root enrollment",
    "membershipPath": "Membership witness",
    "proofGeneration": "Node proof generation",
    "verifyTransactionLocal": "Local authorization receipt",
    "bfvEncrypt": "BFV record encryption",
    "bfvEvaluate": "BFV policy evaluation",
    "bfvRelease": "Permitted-result release",
    "walletSignatureCheck": "Wallet-signature check",
    "encryptedStorageRoundTrip": "Encrypted storage retrieval",
    "revocationRequestLocal": "Local revocation request",
    "revocationExecutionLocal": "Local deactivation receipt",
    "localCleanup": "Direct local cleanup",
}
lines = [r"\begin{table}[t]", r"\centering\scriptsize",
         r"\caption{Stage timing in milliseconds: 10 warmups and 30 measured samples per row. SD is population standard deviation.}",
         r"\label{tab:timings}", r"\setlength{\tabcolsep}{3pt}\renewcommand{\arraystretch}{1.1}",
         r"\begin{tabularx}{\columnwidth}{>{\raggedright\arraybackslash}Xrrr}",
         r"\toprule Stage & Median & p95 & SD\\\midrule"]
for key, label in stage_labels.items():
    v = data["timings"][key]
    lines.append(f"{label} & {v['median']:,.2f} & {v['p95']:,.2f} & {v['std']:,.2f}" + r"\\")
lines += [r"\bottomrule\end{tabularx}", r"\end{table}"]
tex("tables/stage-timings.tex", lines)

gas_labels = {
    "walletRbacEnroll": "Wallet-RBAC enrollment (baseline)",
    "enrollment": "Role-root update",
    "initialVerificationIssuance": "First wallet authorization",
    "verifyAndIssue": "Warmed reauthorization",
    "recordRegistration": "One record registration",
    "revocationRequest": "Revocation request",
    "revocationExecution": "Revocation execution",
}
lines = [r"\begin{table}[t]", r"\centering\scriptsize",
         r"\caption{Gas used: medians for repeated series, individual gas for one-sample rows.}",
         r"\label{tab:gas}", r"\setlength{\tabcolsep}{3pt}\renewcommand{\arraystretch}{1.1}",
         r"\begin{tabularx}{\columnwidth}{>{\raggedright\arraybackslash}Xrr}",
         r"\toprule Operation & Gas & Samples\\\midrule"]
for key, label in gas_labels.items():
    v = data["gas"][key]
    value, count = (v["median"], v["samples"]) if isinstance(v, dict) else (v, 1)
    lines.append(f"{label} & {value:,.0f} & {count}" + r"\\")
lines += [r"\bottomrule\end{tabularx}",
          r"\par\smallskip\raggedright First enrollment of an empty role, deployment, session revocation and retention scheduling/keeper gas were not separately measured. Off-chain stages incur no chain transaction gas.",
          r"\end{table}"]
tex("tables/gas.tex", lines)

baseline_labels = {"plaintextWalletRbac": "Plaintext + wallet RBAC",
                   "bfvWalletRbac": "BFV + wallet RBAC",
                   "bfvZkpAuthorization": "BFV + ZKP authorization"}
lines = [r"\begin{table*}[t]", r"\centering\scriptsize",
         r"\caption{Authenticated HTTP matching-job latency in milliseconds: 10 warmups and 30 measured samples per configuration. Jobs use established sessions and include 100-ms result polling.}",
         r"\label{tab:workloads}", r"\renewcommand{\arraystretch}{1.12}",
         r"\begin{tabularx}{\textwidth}{>{\raggedright\arraybackslash}Xlrrr}",
         r"\toprule Configuration & Matrix & Median & p95 & SD\\\midrule"]
for baseline, workloads in data["workloads"].items():
    for size, v in workloads.items():
        matrix = "$" + size.replace("x", r"\times") + "$"
        lines.append(f"{baseline_labels[baseline]} & {matrix} & {v['median']:,.2f} & {v['p95']:,.2f} & {v['std']:,.2f}" + r"\\")
lines += [r"\bottomrule\end{tabularx}", r"\end{table*}"]
tex("tables/workloads.tex", lines)

for name, destination in [
    ("benchmark-v2.json", "benchmark-v2.json"),
    ("validation.json", "validation-baseline.json"),
    ("browser-acceptance.json", "browser-acceptance-baseline.json"),
    ("dependency-audit.json", "dependency-audit.json"),
]:
    shutil.copyfile(EVALUATION / name, REPORT / "evidence" / destination)
for suffix in ["pdf", "png", "svg"]:
    shutil.copyfile(EVALUATION / f"workload-latency.{suffix}", REPORT / "figures" / f"workload-latency.{suffix}")
wallet_check = ROOT / "runtime/wallet-network-check/evidence.json"
if wallet_check.exists():
    shutil.copyfile(wallet_check, REPORT / "evidence/wallet-network-check.json")

source_paths = [
    "src/App.jsx", "src/wallet.mjs", "src/prover.worker.js", "shared/protocol.mjs",
    "server/auth.js", "server/app.js", "server/bfvService.js", "server/chain.js",
    "server/service.js", "server/storage.js", "server/revocation.js", "server/store.js",
    "contracts/PFEKeyIssuer.sol", "contracts/RoleRegistry.sol", "contracts/OrganRegistry.sol",
    "contracts/LifecycleManager.sol", "circuits/roleProof.circom", "package-lock.json",
    "test/v2/wallet.test.js", "scripts/buildFormattedReport.py",
]
provenance = {
    "reportDate": "2026-10-23", "reportTimezone": "Asia/Calcutta",
    "layoutSource": "User-supplied two-column Phase II report; originals preserved in paper/source-layout",
    "performanceEvidenceDate": data["meta"]["date"],
    "performanceParentCommit": data["meta"]["commit"],
    "performanceWorkingTree": data["meta"]["workingTree"],
    "performanceNote": "Original benchmark source/artifact hashes remain in benchmark-v2.json. Current UI hashes are distinct; no old measurements are relabeled as a new performance run.",
    "regression": {"passed": passed, "skipped": skipped, "profile": "default; live infrastructure explicitly skipped"},
    "currentSourceHashes": {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in source_paths},
    "circuitManifest": json.loads((ROOT / "circuits/build/manifest-v2.json").read_text()),
    "originalDocumentHashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT / "paper/source-layout").glob("original-*")},
}
(REPORT / "evidence/report-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
print(f"Generated supplied-format report tables and evidence: {passed} passing, {skipped} skipped; original measurements unchanged.")
