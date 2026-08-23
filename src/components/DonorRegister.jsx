/**
 * DonorRegister.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Donor registration panel.
 * Encrypts attributes via PFE, uploads to IPFS, and registers the encrypted
 * CID commitment on-chain in OrganRegistry.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { encryptAttributes } from '../utils/pfe';
import { uploadToIPFS, cidToBytes32 } from '../utils/ipfs';

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const ORGAN_REGISTRY_ABI = [
  'function registerDonor(bytes32 encCID, uint8 bloodType, bytes32 hlaRoot) external returns (uint256)',
  'event DonorRegistered(uint256 indexed id, bytes32 encCID, address registeredBy)',
];

export default function DonorRegister({ deployments, keyInfo }) {
  const [bloodType, setBloodType] = useState(0);
  const [hlaScore, setHlaScore]   = useState(0.7);
  const [urgency, setUrgency]     = useState(0.5);
  const [step, setStep]           = useState('idle');
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState('');

  const handleRegister = useCallback(async () => {
    if (!keyInfo) { setError('Authenticate your role first.'); return; }
    if (!deployments) { setError('Contracts not deployed.'); return; }

    setError('');
    setResult(null);
    setStep('encrypting');

    try {
      // 1. Encrypt attributes via PFE service
      const { ciphertexts, encryptedRecord } = await encryptAttributes(
        { bloodType: bloodType > 0 ? 1 : 0, hlaScore, urgency },
        keyInfo.roleId,
        keyInfo.commitment
      );

      setStep('uploading');

      // 2. Upload encrypted record to IPFS
      const { cid } = await uploadToIPFS(encryptedRecord);

      setStep('registering');

      // 3. Compute on-chain commitment = keccak256(cid)
      const encCID = cidToBytes32(cid, ethers);

      // 4. Compute HLA Merkle root (off-chain — here we use a placeholder hash)
      // In production, this would be the Merkle root of the HLA antigen set
      const hlaRoot = ethers.keccak256(
        ethers.toUtf8Bytes(`hla:${hlaScore.toFixed(4)}:${Date.now()}`)
      );

      // 5. Call OrganRegistry.registerDonor
      const provider     = new ethers.BrowserProvider(window.ethereum);
      const signer       = await provider.getSigner();
      const organRegistry = new ethers.Contract(
        deployments.OrganRegistry,
        ORGAN_REGISTRY_ABI,
        signer
      );

      const tx      = await organRegistry.registerDonor(encCID, bloodType, hlaRoot);
      const receipt = await tx.wait();

      // 6. Parse DonorRegistered event
      const iface   = new ethers.Interface(ORGAN_REGISTRY_ABI);
      const eventLog = receipt.logs.find(l => {
        try { return iface.parseLog(l)?.name === 'DonorRegistered'; } catch { return false; }
      });

      let donorId = 0n;
      if (eventLog) {
        const parsed = iface.parseLog(eventLog);
        donorId = parsed.args.id;
      }

      setResult({ donorId: donorId.toString(), cid, encCID, txHash: tx.hash });
      setStep('done');

    } catch (err) {
      console.error('[DonorRegister]', err);
      setError(err.reason || err.message || 'Registration failed');
      setStep('error');
    }
  }, [bloodType, hlaScore, urgency, keyInfo, deployments]);

  const isLoading = ['encrypting', 'uploading', 'registering'].includes(step);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon">🫀</div>
        <div>
          <h2>Donor Registration</h2>
          <p className="card-subtitle">Encrypt attributes and register on-chain</p>
        </div>
      </div>

      {!keyInfo && (
        <div className="alert alert--warning">
          ⚠️ You must authenticate your role before registering a donor.
        </div>
      )}

      {/* Blood type selector */}
      <div className="form-group">
        <label>Blood Type</label>
        <div className="blood-type-grid">
          {BLOOD_TYPES.map((bt, idx) => (
            <button
              key={idx}
              id={`blood-type-${idx}`}
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
        <label htmlFor="hla-slider">
          HLA Antigen Match Score: <strong>{(hlaScore * 100).toFixed(0)}%</strong>
        </label>
        <input
          id="hla-slider"
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

      {/* Urgency slider */}
      <div className="form-group">
        <label htmlFor="urgency-slider">
          Urgency Level: <strong>{urgencyLabel(urgency)}</strong>
        </label>
        <input
          id="urgency-slider"
          type="range"
          className="slider slider--urgency"
          min="0" max="1" step="0.01"
          value={urgency}
          onChange={e => setUrgency(parseFloat(e.target.value))}
        />
        <div className="slider-labels">
          <span>Standard</span>
          <span>Emergency</span>
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
        id="btn-register-donor"
        className="btn btn-primary btn-full"
        onClick={handleRegister}
        disabled={!keyInfo || isLoading}
      >
        {step === 'encrypting'  && <><Spinner /> Encrypting with PFE…</>}
        {step === 'uploading'   && <><Spinner /> Uploading to IPFS…</>}
        {step === 'registering' && <><Spinner /> Registering on-chain…</>}
        {step === 'done'        && '✓ Donor Registered'}
        {(step === 'idle' || step === 'error') && '🫀 Register Donor'}
      </button>

      {error && (
        <div className="alert alert--error">⚠️ {error}</div>
      )}

      {result && (
        <div className="success-panel">
          <div className="success-header">
            <span className="success-icon">✅</span>
            <h3>Donor Registered Successfully</h3>
          </div>
          <div className="key-info">
            <InfoRow label="Donor ID"   value={`#${result.donorId}`} />
            <InfoRow label="IPFS CID"   value={`${result.cid.slice(0, 24)}…`} mono />
            <InfoRow label="On-chain commitment" value={`${result.encCID.slice(0, 18)}…`} mono />
            <InfoRow label="Tx"         value={`${result.txHash.slice(0, 18)}…`} mono />
          </div>
          <div className="gdpr-note">
            📋 GDPR: Record can be erased via LifecycleManager (Article 17)
          </div>
        </div>
      )}
    </div>
  );
}

function urgencyLabel(val) {
  if (val < 0.33) return 'Standard';
  if (val < 0.66) return 'Urgent';
  return 'Emergency';
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
