/**
 * RoleAuth.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * ZKP role authentication panel.
 *
 * Full flow:
 *   1. Doctor types passphrase → credential scalar derived off-chain
 *   2. 20-level Poseidon Merkle tree built in-browser with credential as leaf[0]
 *   3. Merkle root sent to backend → registered on-chain (dev mode)
 *   4. Backend generates Groth16 proof with real Merkle path
 *   5. Proof submitted to PFEKeyIssuer.verifyAndIssueKey() via MetaMask
 *   6. PFE key commitment issued for 4 hours
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import {
  generateRoleProof,
  formatProofForContract,
  generateSalt,
} from '../utils/zkp';

const ROLE_NAMES  = ['Doctor', 'Coordinator', 'Procurement', 'Matching', 'Transporter', 'Surgeon'];
const ROLE_ICONS  = ['🩺', '📋', '🏥', '🔗', '🚑', '⚕️'];
const ROLE_HINTS  = [
  'e.g. your hospital ID + date of joining',
  'e.g. your department code + employee number',
  'e.g. your procurement license number',
  'e.g. your matching algorithm access code',
  'e.g. your vehicle registration + license',
  'e.g. your surgical license number',
];

// BN128 scalar field prime
const PRIME_R = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

const PFEKEY_ISSUER_ABI = [
  'function verifyAndIssueKey(uint8 roleId, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[4] calldata pubInputs) external',
  'event KeyIssued(address indexed recipient, uint8 roleId, bytes32 keyCommitment, uint256 expiresAt)',
  'function isKeyValid(address user) view returns (bool valid, uint8 roleId, uint256 expiresAt)',
];

/**
 * Derive a BN128-field-compatible credential scalar from a passphrase.
 * credential = keccak256("zkp-credential:role<N>:<passphrase>") mod PRIME_R
 *
 * This matches the logic in scripts/generateProof.js — same passphrase
 * always produces the same scalar, giving a stable Merkle leaf.
 */
function deriveCredential(passphrase, roleId) {
  const preimage = ethers.toUtf8Bytes(`zkp-credential:role${roleId}:${passphrase}`);
  const hash     = ethers.keccak256(preimage);  // 0x-prefixed 32-byte hex
  const scalar   = BigInt(hash) % PRIME_R;
  return '0x' + scalar.toString(16).padStart(64, '0');
}

// Step labels shown in progress UI
const STEP_LABELS = {
  idle:        '',
  connecting:  'Connecting wallet…',
  building:    '🌲 Building Merkle tree…',
  registering: '📋 Registering Merkle root on-chain…',
  proving:     '⚡ Generating ZKP proof…',
  submitting:  '📡 Submitting to blockchain…',
  done:        '✅ Role Verified',
  error:       '',
};

export default function RoleAuth({ deployments, onKeyIssued }) {
  const [step, setStep]               = useState('idle');
  const [passphrase, setPassphrase]   = useState('');
  const [showPass, setShowPass]       = useState(false);
  const [roleId, setRoleId]           = useState(0);
  const [account, setAccount]         = useState(null);
  const [keyInfo, setKeyInfo]         = useState(null);
  const [error, setError]             = useState('');
  const [txHash, setTxHash]           = useState('');
  const [derivedCred, setDerivedCred] = useState('');
  const [stepLog, setStepLog]         = useState([]);

  const addLog = (msg) => setStepLog(prev => [...prev.slice(-4), msg]); // keep last 5

  // ── Connect MetaMask ──────────────────────────────────────────────────────
  const connectWallet = useCallback(async () => {
    setStep('connecting');
    setError('');
    try {
      if (!window.ethereum) throw new Error('MetaMask not detected. Please install MetaMask.');
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();
      setAccount(await signer.getAddress());
      setStep('idle');
    } catch (err) {
      setError(err.message);
      setStep('error');
    }
  }, []);

  // ── Preview derived credential ────────────────────────────────────────────
  const previewCredential = useCallback(() => {
    if (!passphrase.trim()) return;
    const cred = deriveCredential(passphrase, roleId);
    setDerivedCred(cred);
  }, [passphrase, roleId]);

  // ── Main: Full ZKP flow ───────────────────────────────────────────────────
  const handleVerify = useCallback(async () => {
    if (!passphrase.trim()) { setError('Enter your credential passphrase.'); return; }
    if (!account)            { setError('Connect MetaMask first.');           return; }
    if (!deployments)        { setError('Contracts not deployed — run npm run deploy:local.'); return; }

    setError('');
    setStepLog([]);

    try {
      // ── Step 1: Derive credential scalar off-chain ────────────────────────
      const credentialHex = deriveCredential(passphrase, roleId);
      setDerivedCred(credentialHex);

      // ── Step 2: Build Merkle tree + register root + generate proof (server) ──
      setStep('building');
      const salt = generateSalt();
      addLog('Building Merkle tree + registering root + generating proof…');
      const { proof, publicInputs, merkleRoot } = await generateRoleProof({
        credential: credentialHex,
        roleId,
        salt,
      });
      addLog(`✓ Merkle root: ${merkleRoot ? merkleRoot.slice(0,18) : '?'}…`);
      addLog('✓ Root registered on-chain');
      addLog('✓ Proof generated & verified locally');

      // ── Step 6: Submit proof on-chain via MetaMask ────────────────────────
      setStep('submitting');
      addLog('Submitting proof to PFEKeyIssuer…');

      const provider  = new ethers.BrowserProvider(window.ethereum);
      const signer    = await provider.getSigner();
      const keyIssuer = new ethers.Contract(deployments.PFEKeyIssuer, PFEKEY_ISSUER_ABI, signer);
      const { a, b, c } = formatProofForContract(proof);

      const tx = await keyIssuer.verifyAndIssueKey(roleId, a, b, c, publicInputs);
      setTxHash(tx.hash);
      addLog(`Tx submitted: ${tx.hash.slice(0,14)}…`);

      const receipt = await tx.wait();
      addLog(`✓ Mined in block ${receipt.blockNumber}`);

      // ── Step 7: Parse KeyIssued event ─────────────────────────────────────
      const iface    = new ethers.Interface(PFEKEY_ISSUER_ABI);
      const eventLog = receipt.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'KeyIssued'; } catch { return false; }
      });

      let commitment = '', expiresAt = 0;
      if (eventLog) {
        const parsed = iface.parseLog(eventLog);
        commitment   = parsed.args.keyCommitment;
        expiresAt    = Number(parsed.args.expiresAt);
      }

      const info = { roleId, commitment, expiresAt, account };
      setKeyInfo(info);
      setStep('done');
      if (onKeyIssued) onKeyIssued(info);

    } catch (err) {
      console.error('[RoleAuth]', err);
      setError(err.reason || err.message || 'Transaction failed');
      setStep('error');
    }
  }, [passphrase, roleId, account, deployments, onKeyIssued]);

  const reset = useCallback(() => {
    setStep('idle'); setPassphrase(''); setKeyInfo(null);
    setError(''); setTxHash(''); setDerivedCred(''); setStepLog([]);
  }, []);

  const isBusy = ['building','registering','proving','submitting'].includes(step);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="card role-auth">
      <div className="card-header">
        <div className="card-icon">🔐</div>
        <div>
          <h2>Role Authentication</h2>
          <p className="card-subtitle">Prove your role using Zero-Knowledge Proof — no identity revealed</p>
        </div>
      </div>

      {/* ── Wallet ── */}
      <div className="wallet-section">
        {account ? (
          <div className="wallet-connected">
            <span className="dot dot--green" />
            <span className="wallet-addr-label">Connected wallet:</span>
            <span className="wallet-addr">{account.slice(0,8)}…{account.slice(-6)}</span>
            <span className="wallet-privacy-note">
              🛡️ Your address is <em>not</em> part of the ZKP proof
            </span>
          </div>
        ) : (
          <div className="wallet-cta">
            <button
              id="btn-connect-wallet"
              className="btn btn-secondary btn-full"
              onClick={connectWallet}
              disabled={step === 'connecting'}
            >
              {step === 'connecting' ? <><Spinner /> Connecting…</> : '🦊 Connect MetaMask Wallet'}
            </button>
            <p className="form-hint">No wallet address is ever included in the ZKP proof.</p>
          </div>
        )}
      </div>

      {/* ── Role grid ── */}
      <div className="form-group">
        <label>Select Your Role</label>
        <div className="role-grid">
          {ROLE_NAMES.map((name, idx) => (
            <button
              key={idx}
              id={`role-btn-${idx}`}
              className={`role-btn${roleId === idx ? ' active' : ''}`}
              onClick={() => { setRoleId(idx); setDerivedCred(''); }}
              disabled={isBusy}
            >
              <span className="role-icon">{ROLE_ICONS[idx]}</span>
              <span>{name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Passphrase ── */}
      <div className="form-group">
        <label htmlFor="passphrase-input">
          Your Credential Passphrase
          <span className="label-badge">Private · Off-chain Only</span>
        </label>

        <div className="credential-explainer">
          <span className="info-icon">💡</span>
          <span>
            Type a memorable passphrase — <strong>not</strong> your wallet address.
            It's hashed into a ZKP credential locally and never sent anywhere as plaintext.
          </span>
        </div>

        <div className="input-wrapper">
          <input
            id="passphrase-input"
            type={showPass ? 'text' : 'password'}
            className="form-input"
            placeholder={`e.g. ${ROLE_HINTS[roleId]}`}
            value={passphrase}
            onChange={e => { setPassphrase(e.target.value); setDerivedCred(''); }}
            onBlur={previewCredential}
            autoComplete="off"
            spellCheck={false}
            disabled={isBusy}
          />
          <button
            className="input-icon input-icon--btn"
            onClick={() => setShowPass(v => !v)}
            title={showPass ? 'Hide passphrase' : 'Show passphrase'}
            aria-label="Toggle passphrase visibility"
          >
            {showPass ? '🙈' : '👁️'}
          </button>
        </div>
        <p className="form-hint">
          Use the <strong>same passphrase every time</strong> for the same role to reproduce the same identity.
        </p>

        {derivedCred && (
          <div className="derived-preview">
            <span className="derived-label">🔑 Derived credential (for your reference):</span>
            <code className="derived-hash">{derivedCred.slice(0,20)}…{derivedCred.slice(-8)}</code>
            <span className="derived-note">This scalar is what the ZKP circuit uses internally.</span>
          </div>
        )}
      </div>

      {/* ── Progress log ── */}
      {stepLog.length > 0 && (
        <div className="step-log">
          {stepLog.map((msg, i) => (
            <div key={i} className="step-log-line">{msg}</div>
          ))}
        </div>
      )}

      {/* ── Step indicator ── */}
      {isBusy && (
        <div className="step-indicator">
          <Spinner /> {STEP_LABELS[step]}
        </div>
      )}

      {/* ── Submit ── */}
      {step !== 'done' && (
        <button
          id="btn-verify-role"
          className="btn btn-primary btn-full"
          onClick={handleVerify}
          disabled={!account || !passphrase.trim() || isBusy}
        >
          {isBusy ? <><Spinner /> {STEP_LABELS[step]}</> : '⚡ Verify & Issue Role Key'}
        </button>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="alert alert--error" role="alert">
          <span>⚠️</span> {error}
        </div>
      )}

      {/* ── Success ── */}
      {keyInfo && (
        <div className="success-panel">
          <div className="success-header">
            <span className="success-icon">✅</span>
            <h3>Role Verified — PFE Key Issued</h3>
          </div>
          <p className="success-note">
            Your role was proved on-chain. Identity was <strong>never revealed</strong>.
          </p>
          <div className="key-info">
            <InfoRow label="Role"       value={`${ROLE_ICONS[keyInfo.roleId]} ${ROLE_NAMES[keyInfo.roleId]}`} />
            <InfoRow label="Commitment" value={`${keyInfo.commitment?.slice(0,20)}…`} mono />
            <InfoRow label="Expires"    value={new Date(keyInfo.expiresAt * 1000).toLocaleTimeString()} />
            <InfoRow label="Valid for"  value="4 hours" />
          </div>
          {txHash && (
            <p className="tx-hash">Tx: <span className="mono">{txHash.slice(0,22)}…</span></p>
          )}
          <button className="btn btn-secondary btn-sm" onClick={reset} style={{marginTop:'1rem'}}>
            🔄 Authenticate Again
          </button>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true">⟳</span>;
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}
