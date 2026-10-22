/**
 * RecipientRegister.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recipient registration panel.
 * Mirrors DonorRegister.jsx: encrypts attributes via PFE, uploads the raw
 * ciphertext bundle to IPFS, and registers the CID commitment on-chain via
 * OrganRegistry.registerRecipient (also records urgency, used in matching).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { encryptAttributes } from '../utils/pfe';
import { uploadToIPFS } from '../utils/ipfs';

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URGENCY_LEVELS = [
  { value: 0, label: 'Standard' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'Emergency' },
];

const ORGAN_REGISTRY_ABI = [
  'function registerRecipient(string encCID, uint8 bloodType, bytes32 hlaRoot, uint8 urgency) external returns (uint256)',
  'event RecipientRegistered(uint256 indexed id, string encCID, address registeredBy)',
];

export default function RecipientRegister({ deployments, keyInfo }) {
  const [bloodType, setBloodType]     = useState(0);
  const [hlaScore, setHlaScore]       = useState(0.7);
  const [urgencyLevel, setUrgencyLevel] = useState(0); // 0/1/2 for on-chain field
  const [step, setStep]               = useState('idle');
  const [result, setResult]           = useState(null);
  const [error, setError]             = useState('');

  const handleRegister = useCallback(async () => {
    if (!keyInfo) { setError('Authenticate your role first.'); return; }
    if (!deployments) { setError('Contracts not deployed.'); return; }

    setError('');
    setResult(null);
    setStep('encrypting');

    try {
      // PFE scoring's urgency variable is normalised 0–1; the on-chain
      // urgency field is a 0/1/2 class — encrypt the normalised version.
      const urgencyScaled = urgencyLevel / 2;

      // 1. Encrypt attributes via PFE service (SEAL BFV ciphertexts).
      //    bloodType is passed as the real 0-7 category (see BLOOD_TYPES
      //    above) — the backend decomposes it into (isA, isB, isRhPos) for
      //    real ABO/Rh compatibility scoring, not a same/different proxy.
      const { ciphertexts } = await encryptAttributes(
        { bloodType, hlaScore, urgency: urgencyScaled },
        keyInfo.roleId,
        keyInfo.commitment
      );

      setStep('uploading');

      // 2. Upload the raw ciphertext bundle to IPFS (see DonorRegister.jsx
      //    for why this isn't AES-wrapped with a session-ephemeral key).
      const bundle = JSON.stringify({ ...ciphertexts, ts: Date.now() });
      const encryptedRecord = btoa(bundle);
      const { cid } = await uploadToIPFS(encryptedRecord);

      setStep('registering');

      const encCID = cid;
      const hlaRoot = ethers.keccak256(
        ethers.toUtf8Bytes(`hla:${hlaScore.toFixed(4)}:${Date.now()}`)
      );

      // 3. Call OrganRegistry.registerRecipient
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();
      const organRegistry = new ethers.Contract(
        deployments.OrganRegistry,
        ORGAN_REGISTRY_ABI,
        signer
      );

      const tx      = await organRegistry.registerRecipient(encCID, bloodType, hlaRoot, urgencyLevel);
      const receipt = await tx.wait();

      const iface    = new ethers.Interface(ORGAN_REGISTRY_ABI);
      const eventLog = receipt.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'RecipientRegistered'; } catch { return false; }
      });

      let recipientId = 0n;
      if (eventLog) {
        const parsed = iface.parseLog(eventLog);
        recipientId  = parsed.args.id;
      }

      setResult({ recipientId: recipientId.toString(), cid, encCID, txHash: tx.hash });
      setStep('done');

    } catch (err) {
      console.error('[RecipientRegister]', err);
      setError(err.reason || err.message || 'Registration failed');
      setStep('error');
    }
  }, [bloodType, hlaScore, urgencyLevel, keyInfo, deployments]);

  const isLoading = ['encrypting', 'uploading', 'registering'].includes(step);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon">🏥</div>
        <div>
          <h2>Recipient Registration</h2>
          <p className="card-subtitle">Encrypt attributes and register on-chain</p>
        </div>
      </div>

      {!keyInfo && (
        <div className="alert alert--warning">
          ⚠️ You must authenticate your role before registering a recipient.
        </div>
      )}

      {/* Blood type selector */}
      <div className="form-group">
        <label>Blood Type</label>
        <div className="blood-type-grid">
          {BLOOD_TYPES.map((bt, idx) => (
            <button
              key={idx}
              id={`recip-blood-type-${idx}`}
              className={`blood-btn${bloodType === idx ? ' active' : ''}`}
              onClick={() => setBloodType(idx)}
            >
              {bt}
            </button>
          ))}
        </div>
      </div>

      {/* HLA score slider */}
      <div className="form-group">
        <label htmlFor="recip-hla-slider">
          HLA Antigen Match Score: <strong>{(hlaScore * 100).toFixed(0)}%</strong>
        </label>
        <input
          id="recip-hla-slider"
          type="range"
          className="slider"
          min="0" max="1" step="0.01"
          value={hlaScore}
          onChange={e => setHlaScore(parseFloat(e.target.value))}
        />
        <div className="slider-labels">
          <span>0% (No match)</span>
          <span>100% (Perfect match)</span>
        </div>
      </div>

      {/* Urgency selector (matches OrganRegistry's 0/1/2 field) */}
      <div className="form-group">
        <label>Urgency</label>
        <div className="blood-type-grid">
          {URGENCY_LEVELS.map(({ value, label }) => (
            <button
              key={value}
              id={`recip-urgency-${value}`}
              className={`blood-btn${urgencyLevel === value ? ' active' : ''}`}
              onClick={() => setUrgencyLevel(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Privacy notice */}
      <div className="privacy-notice">
        <span>🔐</span>
        <span>
          Attributes are BFV-encrypted before leaving your browser.
          Only the IPFS CID commitment is stored on-chain.
        </span>
      </div>

      {/* Register button */}
      <button
        id="btn-register-recipient"
        className="btn btn-primary btn-full"
        onClick={handleRegister}
        disabled={!keyInfo || isLoading}
      >
        {step === 'encrypting'  && <><Spinner /> Encrypting with PFE…</>}
        {step === 'uploading'   && <><Spinner /> Uploading to IPFS…</>}
        {step === 'registering' && <><Spinner /> Registering on-chain…</>}
        {step === 'done'        && '✓ Recipient Registered'}
        {(step === 'idle' || step === 'error') && '🏥 Register Recipient'}
      </button>

      {error && (
        <div className="alert alert--error">⚠️ {error}</div>
      )}

      {result && (
        <div className="success-panel">
          <div className="success-header">
            <span className="success-icon">✅</span>
            <h3>Recipient Registered Successfully</h3>
          </div>
          <div className="key-info">
            <InfoRow label="Recipient ID" value={`#${result.recipientId}`} />
            <InfoRow label="IPFS CID"     value={`${result.cid.slice(0, 24)}…`} mono />
            <InfoRow label="On-chain commitment" value={`${result.encCID.slice(0, 18)}…`} mono />
            <InfoRow label="Tx"           value={`${result.txHash.slice(0, 18)}…`} mono />
          </div>
          <div className="gdpr-note">
            📋 Note: GDPR Article 17 revocation via LifecycleManager currently
            covers donor records only (see Lifecycle tab).
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="spinner">⟳</span>;
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}
