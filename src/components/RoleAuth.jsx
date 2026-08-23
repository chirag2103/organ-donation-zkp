/**
 * RoleAuth.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * ZKP role authentication panel.
 * Connects MetaMask, generates a Groth16 proof, and calls
 * PFEKeyIssuer.verifyAndIssueKey() to receive a scoped key commitment.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { generateRoleProof, formatProofForContract, generateSalt } from '../utils/zkp';

const ROLE_NAMES = ['Doctor', 'Coordinator', 'Procurement', 'Matching', 'Transporter', 'Surgeon'];
const ROLE_ICONS = ['🩺', '📋', '🏥', '🔗', '🚑', '⚕️'];

const PFEKEY_ISSUER_ABI = [
  'function verifyAndIssueKey(uint8 roleId, uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[4] pubInputs) external',
  'event KeyIssued(address indexed recipient, uint8 roleId, bytes32 keyCommitment, uint256 expiresAt)',
  'function isKeyValid(address user) view returns (bool valid, uint8 roleId, uint256 expiresAt)',
];

export default function RoleAuth({ deployments, onKeyIssued }) {
  const [step, setStep]               = useState('idle');  // idle | connecting | proving | submitting | done | error
  const [credential, setCredential]   = useState('');
  const [roleId, setRoleId]           = useState(0);
  const [account, setAccount]         = useState(null);
  const [keyInfo, setKeyInfo]         = useState(null);
  const [error, setError]             = useState('');
  const [txHash, setTxHash]           = useState('');

  // ── Connect MetaMask ────────────────────────────────────────────────────
  const connectWallet = useCallback(async () => {
    setStep('connecting');
    setError('');
    try {
      if (!window.ethereum) throw new Error('MetaMask not detected. Please install MetaMask.');
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();
      const addr     = await signer.getAddress();
      setAccount(addr);
      setStep('idle');
    } catch (err) {
      setError(err.message);
      setStep('error');
    }
  }, []);

  // ── Main: Generate proof + submit on-chain ───────────────────────────────
  const handleVerify = useCallback(async () => {
    if (!credential.trim()) { setError('Enter your credential hash.'); return; }
    if (!account)            { setError('Connect MetaMask first.');     return; }
    if (!deployments)        { setError('Contracts not deployed.');      return; }

    setError('');
    setStep('proving');

    try {
      // 1. Fetch the Merkle root for the selected role
      const provider   = new ethers.BrowserProvider(window.ethereum);
      const roleRegABI = ['function getRoleRoot(uint8) view returns (bytes32)'];
      const roleReg    = new ethers.Contract(deployments.RoleRegistry, roleRegABI, provider);
      const merkleRoot = await roleReg.getRoleRoot(roleId);

      // 2. Generate random salt
      const salt = generateSalt();

      // 3. Off-chain proof generation
      const { proof, publicInputs } = await generateRoleProof({
        credential: credential.startsWith('0x') ? credential : `0x${credential}`,
        roleId,
        salt,
        merkleRoot,
        pathElements: Array(20).fill('0x0000000000000000000000000000000000000000000000000000000000000000'),
        pathIndices:  Array(20).fill(0),
      });

      setStep('submitting');

      // 4. Submit to PFEKeyIssuer
      const signer    = await provider.getSigner();
      const keyIssuer = new ethers.Contract(deployments.PFEKeyIssuer, PFEKEY_ISSUER_ABI, signer);
      const { a, b, c } = formatProofForContract(proof);

      const tx = await keyIssuer.verifyAndIssueKey(roleId, a, b, c, publicInputs);
      setTxHash(tx.hash);
      const receipt = await tx.wait();

      // 5. Parse KeyIssued event
      const iface     = new ethers.Interface(PFEKEY_ISSUER_ABI);
      const eventLog  = receipt.logs.find(l => {
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
  }, [credential, roleId, account, deployments, onKeyIssued]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="card role-auth">
      <div className="card-header">
        <div className="card-icon">🔐</div>
        <div>
          <h2>Role Authentication</h2>
          <p className="card-subtitle">Prove your role using Zero-Knowledge Proof</p>
        </div>
      </div>

      {/* Wallet connection */}
      <div className="wallet-section">
        {account ? (
          <div className="wallet-connected">
            <span className="dot dot--green" />
            <span className="wallet-addr">{account.slice(0, 6)}…{account.slice(-4)}</span>
          </div>
        ) : (
          <button
            id="btn-connect-wallet"
            className="btn btn-secondary"
            onClick={connectWallet}
            disabled={step === 'connecting'}
          >
            {step === 'connecting' ? <Spinner /> : '🦊 Connect MetaMask'}
          </button>
        )}
      </div>

      {/* Role selector */}
      <div className="form-group">
        <label htmlFor="role-select">Select Your Role</label>
        <div className="role-grid">
          {ROLE_NAMES.map((name, idx) => (
            <button
              key={idx}
              id={`role-btn-${idx}`}
              className={`role-btn${roleId === idx ? ' active' : ''}`}
              onClick={() => setRoleId(idx)}
            >
              <span className="role-icon">{ROLE_ICONS[idx]}</span>
              <span>{name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Credential input */}
      <div className="form-group">
        <label htmlFor="credential-input">Credential Hash (private — never sent on-chain)</label>
        <div className="input-wrapper">
          <input
            id="credential-input"
            type="password"
            className="form-input"
            placeholder="0xYourSecretCredentialHash..."
            value={credential}
            onChange={e => setCredential(e.target.value)}
          />
          <span className="input-icon">🔒</span>
        </div>
        <p className="form-hint">
          Your credential is hashed off-chain. Only the proof is sent to the blockchain.
        </p>
      </div>

      {/* Submit button */}
      <button
        id="btn-verify-role"
        className="btn btn-primary btn-full"
        onClick={handleVerify}
        disabled={!account || step === 'proving' || step === 'submitting' || step === 'done'}
      >
        {step === 'proving'    && <><Spinner /> Generating ZKP Proof…</>}
        {step === 'submitting' && <><Spinner /> Submitting to Blockchain…</>}
        {step === 'done'       && '✓ Role Verified'}
        {(step === 'idle' || step === 'error') && '⚡ Verify & Issue Key'}
      </button>

      {/* Error display */}
      {error && (
        <div className="alert alert--error" role="alert">
          <span>⚠️</span> {error}
        </div>
      )}

      {/* Success panel */}
      {keyInfo && (
        <div className="success-panel">
          <div className="success-header">
            <span className="success-icon">✅</span>
            <h3>Role Verified — Key Issued</h3>
          </div>
          <div className="key-info">
            <InfoRow label="Role"       value={`${ROLE_ICONS[keyInfo.roleId]} ${ROLE_NAMES[keyInfo.roleId]}`} />
            <InfoRow label="Commitment" value={`${keyInfo.commitment?.slice(0, 18)}…`} mono />
            <InfoRow label="Expires"    value={new Date(keyInfo.expiresAt * 1000).toLocaleTimeString()} />
            <InfoRow label="Valid for"  value="4 hours" />
          </div>
          {txHash && (
            <p className="tx-hash">
              Tx: <span className="mono">{txHash.slice(0, 20)}…</span>
            </p>
          )}
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
