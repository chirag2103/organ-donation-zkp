import React, { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import abis from "./generated/abis.json";
import { FIELD, hash, ROLES } from "../shared/protocol.mjs";
import {
  requireWallet,
  checkWalletChain,
  selectWalletChain,
} from "./wallet.mjs";

const API = import.meta.env.VITE_API_URL || "";
const jsonDownload = (value, name) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export default function App() {
  const [cfg, setCfg] = useState(null),
    [account, setAccount] = useState(""),
    [credential, setCredential] = useState(null);
  const [session, setSession] = useState(null),
    [role, setRole] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [entityType, setEntityType] = useState(0),
    [abo, setAbo] = useState("O"),
    [features, setFeatures] = useState([0, 0, 0, 0, 0, 0]),
    [urgency, setUrgency] = useState(0);
  const [records, setRecords] = useState([]),
    [donor, setDonor] = useState(""),
    [recipient, setRecipient] = useState(""),
    [result, setResult] = useState(null),
    [job, setJob] = useState(null),
    [tab, setTab] = useState("access");
  const [cleanup, setCleanup] = useState({}),
    [pending, setPending] = useState(null);
  const worker = useRef(null),
    cancelProof = useRef(null),
    generation = useRef(0),
    sessionRef = useRef(null);
  sessionRef.current = session;
  async function api(url, body, method = body === undefined ? "GET" : "POST") {
    const requestGeneration = generation.current;
    const response = await fetch(API + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(sessionRef.current
          ? { Authorization: "Bearer " + sessionRef.current.token }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (requestGeneration !== generation.current) {
      throw Error("Wallet changed; the previous request result was discarded");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        setSession(null);
        setRecords([]);
        setResult(null);
        setJob(null);
      }
      throw Error(value.error || "Request failed");
    }
    return value;
  }
  const run = (fn) => async () => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    api("/api/config")
      .then(setCfg)
      .catch((e) => setMessage(e.message));
    const reset = () => {
      generation.current++;
      worker.current?.terminate();
      cancelProof.current?.(Error("Wallet changed; authenticate again"));
      setSession(null);
      setAccount("");
      setCredential(null);
      setRecords([]);
      setResult(null);
      setJob(null);
      setPending(null);
    };
    window.ethereum?.on("accountsChanged", reset);
    window.ethereum?.on("chainChanged", reset);
    return () => {
      window.ethereum?.removeListener("accountsChanged", reset);
      window.ethereum?.removeListener("chainChanged", reset);
      worker.current?.terminate();
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => {
      setSession(null);
      setRecords([]);
      setResult(null);
      setJob(null);
    }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    const timer = setTimeout(
      () =>
        api("/api/matches/jobs/" + job.id)
          .then(setJob)
          .catch((e) => {
            setMessage(e.message);
            setJob(null);
          }),
      700
    );
    return () => clearTimeout(timer);
  }, [job]);
  const permissions = cfg && session ? cfg.permissions[session.roleId] : 0;
  const authenticationHint = busy
    ? "Finish the current operation or respond to the pending wallet prompt."
    : !cfg
    ? "Backend configuration is unavailable. Start the stack, then reload this page."
    : !account
    ? "Connect your wallet using the button at the top of this page before authenticating."
    : !credential
    ? "Create or import your approved role credential to authenticate."
    : "After the administrator approves the public leaf above, authenticate and confirm the wallet transaction and login signature.";
  async function signer() {
    await checkWalletChain(window.ethereum, cfg.deployment);
    const p = new ethers.BrowserProvider(window.ethereum);
    return p.getSigner();
  }
  async function connect() {
    if (!cfg) throw Error("Backend configuration unavailable");
    const provider = requireWallet(window.ethereum);
    await provider.request({ method: "eth_requestAccounts" });
    setMessage("Approve the Hardhat network switch in MetaMask if prompted...");
    await selectWalletChain(provider, cfg.deployment);
    setAccount(await (await signer()).getAddress());
    setMessage(
      "Wallet connected on chain " +
        cfg.deployment.chainId +
        ". Import your approved credential to authenticate."
    );
  }
  function newCredential() {
    const bytes = crypto.getRandomValues(new Uint8Array(31)),
      secret = BigInt(
        "0x" +
          Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")
      );
    const c = {
      version: 2,
      roleId: role,
      secret: secret.toString(),
      leaf: hash(secret, role).toString(),
    };
    setCredential(c);
    jsonDownload(c, "research-role-" + role + ".json");
  }
  async function importCredential(file) {
    const c = JSON.parse(await file.text());
    if (
      c.version !== 2 ||
      !Number.isInteger(c.roleId) ||
      c.roleId < 0 ||
      c.roleId > 5 ||
      BigInt(c.secret) <= 0n ||
      BigInt(c.secret) >= FIELD ||
      hash(c.secret, c.roleId).toString() !== c.leaf
    )
      throw Error("Invalid credential file");
    setCredential(c);
    setRole(c.roleId);
    setMessage("Credential loaded locally; secret is never sent to the API.");
  }
  async function authenticate() {
    if (!credential || !account)
      throw Error("Connect wallet and create/import your approved credential");
    const attempt = generation.current,
      membership = await api("/api/roles/" + credential.roleId + "/membership");
    setMessage("Generating wallet-bound proof locally in a browser worker...");
    const proof = await new Promise((resolve, reject) => {
      const w = new Worker(new URL("./prover.worker.js", import.meta.url), {
        type: "module",
      });
      worker.current = w;
      cancelProof.current = reject;
      w.onmessage = ({ data }) => {
        w.terminate();
        cancelProof.current = null;
        data.error ? reject(Error(data.error)) : resolve(data);
      };
      w.onerror = () => {
        w.terminate();
        reject(Error("Proof worker failed"));
      };
      w.postMessage({
        credential,
        membership,
        address: account,
        deployment: cfg.deployment,
        manifest: cfg.manifest,
      });
    });
    if (attempt !== generation.current) throw Error("Wallet changed");
    const wallet = await signer();
    if ((await wallet.getAddress()) !== account) throw Error("Wallet changed");
    const contract = new ethers.Contract(
      cfg.deployment.PFEKeyIssuer,
      abis.PFEKeyIssuer,
      wallet
    );
    setMessage("Confirm authorization transaction in your wallet...");
    await (
      await contract.verifyAndIssueKey(
        credential.roleId,
        proof.a,
        proof.b,
        proof.c,
        proof.signals
      )
    ).wait();
    const challenge = await api("/api/auth/challenge", { address: account });
    const signature = await wallet.signMessage(challenge.message);
    const s = await api("/api/auth/session", {
      nonce: challenge.nonce,
      signature,
    });
    if (attempt !== generation.current) throw Error("Wallet changed");
    setSession(s);
    sessionRef.current = s;
    setMessage("Approved role authenticated.");
    if (cfg.permissions[s.roleId] & 7) {
      setTab("records");
      await refresh();
    } else {
      setTab("access");
    }
  }
  async function refresh() {
    setRecords(await api("/api/records"));
  }
  async function finishRegistration(record) {
    const contract = new ethers.Contract(
      cfg.deployment.OrganRegistry,
      abis.OrganRegistry,
      await signer()
    );
    await (
      await contract.registerRecord(record.id, record.anchor, record.entityType)
    ).wait();
    await api("/api/records/" + record.id + "/confirm", {});
    setPending(null);
    setMessage("Encrypted record registered: " + record.id);
    await refresh();
  }
  async function register() {
    const p = await api("/api/records", {
      entityType,
      attributes: { abo, features, urgency },
    });
    setPending(p);
    await finishRegistration(p);
  }
  async function revoke(id) {
    const c = new ethers.Contract(
      cfg.deployment.LifecycleManager,
      abis.LifecycleManager,
      await signer()
    );
    const status = Number(await c.status(id));
    if (status === 0) await (await c.requestRevocation(id)).wait();
    if (status < 2) await (await c.executeRevocation(id)).wait();
    const state = await api("/api/records/" + id + "/revocation");
    setCleanup((prev) => ({ ...prev, [id]: state.state }));
    await refresh();
    setMessage("Record deactivated. Local cleanup runs asynchronously.");
  }
  return (
    <div className="app">
      <header>
        <p className="eyebrow">Synthetic research prototype | protocol v2</p>
        <h1>Organ Donation Research</h1>
        <p>
          ZKP-authorized homomorphic matching and auditable record revocation
        </p>
        <p className="notice">
          Trusted BFV encryption/decryption service. Wallets and transaction
          metadata remain visible. Ranking points are experimental, not clinical
          advice or compatibility probabilities.
        </p>
        <button onClick={run(connect)} disabled={!cfg || busy}>
          {account
            ? "Wallet " + account.slice(0, 10) + "..."
            : "Connect wallet"}
        </button>
        {session && (
          <span className="badge">
            {ROLES[session.roleId]} | expires{" "}
            {new Date(session.expiresAt).toLocaleTimeString()}
          </span>
        )}
      </header>
      <nav>
        {["access", "records", "matching", "revocation"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {message && (
        <p role="status" className="status">
          {message}
        </p>
      )}
      {busy && <p aria-live="polite">Working...</p>}
      {tab === "access" && (
        <section>
          <h2>Approved role membership</h2>
          <p>
            Create a credential locally, give its public leaf to the institution
            administrator, then authenticate after approval. Each root update
            requires members to authenticate again.
          </p>
          <label>
            Role
            <select
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(Number(e.target.value))}
            >
              {ROLES.map((r, i) => (
                <option value={i} key={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={newCredential}>
            Create and download credential
          </button>
          <label>
            Import credential
            <input
              aria-label="Import credential"
              type="file"
              accept=".json"
              onChange={(e) =>
                e.target.files[0] &&
                run(() => importCredential(e.target.files[0]))()
              }
            />
          </label>
          {credential && (
            <>
              <p>Public enrollment leaf (role {credential.roleId}):</p>
              <code data-testid="enrollment-leaf">{credential.leaf}</code>
              <p>Administrator command:</p>
              <code>
                npm run admin -- enroll {credential.roleId} {credential.leaf}
              </code>
            </>
          )}
          <p>
            Keep the downloaded secret file private. It is not an employee
            identifier or password.
          </p>
          <button
            disabled={busy || !cfg || !credential || !account}
            aria-describedby="authentication-help"
            onClick={run(authenticate)}
          >
            Authenticate approved role
          </button>
          <p id="authentication-help">{authenticationHint}</p>
        </section>
      )}
      {tab === "records" && (
        <section>
          <h2>Encrypted synthetic records</h2>
          <p>
            Attributes are sent to the trusted service for encryption. Only an
            opaque ID and encrypted-content anchor are submitted to the
            blockchain.
          </p>
          <label>
            Record type
            <select
              aria-label="Record type"
              value={entityType}
              onChange={(e) => setEntityType(Number(e.target.value))}
            >
              <option value={0}>Donor</option>
              <option value={1}>Recipient</option>
            </select>
          </label>
          <label>
            ABO group
            <select
              aria-label="ABO group"
              value={abo}
              onChange={(e) => setAbo(e.target.value)}
            >
              {["O", "A", "B", "AB"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>
              Six synthetic binary tissue features; not clinical HLA typing
            </legend>
            {features.map((x, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  aria-label={"Feature " + (i + 1)}
                  checked={!!x}
                  onChange={(e) =>
                    setFeatures((prev) =>
                      prev.map((v, j) =>
                        j === i ? Number(e.target.checked) : v
                      )
                    )
                  }
                />
                Feature {i + 1}
              </label>
            ))}
          </fieldset>
          <label>
            Recipient urgency
            <select
              aria-label="Recipient urgency"
              value={urgency}
              onChange={(e) => setUrgency(Number(e.target.value))}
            >
              {[0, 1, 2].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              busy || !(permissions & (entityType === 0 ? 2 : 4)) || !!pending
            }
            onClick={run(register)}
          >
            Encrypt and register record
          </button>
          {pending && (
            <button onClick={run(() => finishRegistration(pending))}>
              Retry pending wallet registration
            </button>
          )}
          <button disabled={!(permissions & 7) || busy} onClick={run(refresh)}>
            Refresh records
          </button>
          <RecordTable records={records} />
        </section>
      )}
      {tab === "matching" && (
        <section>
          <h2>Synthetic matching</h2>
          <p>
            ABO eligibility first; eligible ranking = round(700 * (1 -
            mismatches/6) + 150 * recipient urgency). No Rh rule, allocation or
            reservation.
          </p>
          <label>
            Donor
            <select
              aria-label="Donor"
              value={donor}
              onChange={(e) => setDonor(e.target.value)}
            >
              <option value="">Select donor</option>
              {records
                .filter((r) => r.entityType === 0 && r.active)
                .map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
            </select>
          </label>
          <label>
            Recipient
            <select
              aria-label="Recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">Select recipient</option>
              {records
                .filter((r) => r.entityType === 1 && r.active)
                .map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
            </select>
          </label>
          <button
            disabled={busy || !(permissions & 1) || !donor || !recipient}
            onClick={run(async () =>
              setResult(
                await api("/api/matches/evaluate", {
                  donorId: donor,
                  recipientId: recipient,
                })
              )
            )}
          >
            Evaluate pair
          </button>
          {result && (
            <p data-testid="match-result">
              {result.eligible
                ? result.score + " synthetic ranking points"
                : "Ineligible under demo policy"}
            </p>
          )}
          <button
            disabled={busy || !(permissions & 1)}
            onClick={run(async () =>
              setJob(
                await api("/api/matches/jobs", {
                  donorIds: records
                    .filter((r) => r.entityType === 0 && r.active)
                    .slice(0, 10)
                    .map((r) => r.id),
                  recipientIds: records
                    .filter((r) => r.entityType === 1 && r.active)
                    .slice(0, 10)
                    .map((r) => r.id),
                })
              )
            )}
          >
            Rank batch (up to 10 x 10)
          </button>
          {job && (
            <>
              <p>
                Batch: {job.state} | {job.results?.length || 0} evaluated
              </p>
              {job.error && <p>{job.error}</p>}
              <ol>
                {job.results?.map((r) => (
                  <li key={r.donorId + r.recipientId}>
                    {r.donorId.slice(0, 12)} to {r.recipientId.slice(0, 12)}:{" "}
                    {r.eligible
                      ? r.score + " points"
                      : "Ineligible under demo policy"}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
      {tab === "revocation" && (
        <section>
          <h2>Auditable local revocation</h2>
          <p>
            Surgeons deactivate records on-chain. The worker deletes the
            service-held record key and retries local IPFS cleanup. External
            replicas and previously learned data cannot be recalled.
          </p>
          <button disabled={!(permissions & 7) || busy} onClick={run(refresh)}>
            Refresh records
          </button>
          {records.map((r) => (
            <article key={r.id}>
              <code>{r.id}</code>
              <p>
                {r.entityType === 0 ? "Donor" : "Recipient"} |{" "}
                {r.active ? "active" : "deactivated"} |{" "}
                {cleanup[r.id] || r.revocation}
              </p>
              <button
                disabled={busy || !(permissions & 8) || !r.active}
                onClick={run(() => revoke(r.id))}
              >
                Revoke {r.id.slice(0, 10)}
              </button>
              <button
                disabled={busy || !session}
                onClick={run(async () => {
                  const s = await api("/api/records/" + r.id + "/revocation");
                  setCleanup((prev) => ({ ...prev, [r.id]: s.state }));
                })}
              >
                Check cleanup {r.id.slice(0, 10)}
              </button>
            </article>
          ))}
        </section>
      )}
      <footer>
        BFV homomorphic encryption | browser Groth16 membership proof |
        encrypted IPFS records | local Hardhat development network
      </footer>
    </div>
  );
}
function RecordTable({ records }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Opaque record ID</th>
          <th>Type</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            <td>
              <code>{r.id}</code>
            </td>
            <td>{r.entityType === 0 ? "Donor" : "Recipient"}</td>
            <td>{r.active ? "active" : "deactivated"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
