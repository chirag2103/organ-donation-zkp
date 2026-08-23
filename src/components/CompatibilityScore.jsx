/**
 * CompatibilityScore.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Compatibility scoring panel.
 * Fetches encrypted CIDs from OrganRegistry, computes PFE polynomial score
 * in the encrypted domain, then decrypts and displays the result.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { computeScore, decryptScore, interpretScore } from '../utils/pfe';

const ORGAN_REGISTRY_ABI = [
  'function getEncryptedCID(uint256 donorId) view returns (bytes32)',
  'function getRecipientEncryptedCID(uint256 recipientId) view returns (bytes32)',
];

export default function CompatibilityScore({ deployments, keyInfo }) {
  const [donorId, setDonorId]         = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [step, setStep]               = useState('idle');
  const [scoreResult, setScoreResult] = useState(null);
  const [error, setError]             = useState('');

  // For demo: user provides ciphertexts directly (in real app, fetched from IPFS)
  const [ct1, setCt1] = useState('');
  const [ct2, setCt2] = useState('');
  const [ct3, setCt3] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleCompute = useCallback(async () => {
    if (!keyInfo) { setError('Authenticate your role first.'); return; }
    if (!deployments) { setError('Contracts not deployed.'); return; }

    setError('');
    setScoreResult(null);
    setStep('fetching');

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const registry = new ethers.Contract(
        deployments.OrganRegistry,
        ORGAN_REGISTRY_ABI,
        provider
      );

      // 1. Fetch encrypted CID commitments (on-chain data is just bytes32 hash)
      let donorEncCID = null, recipientEncCID = null;
      if (donorId.trim()) {
        donorEncCID = await registry.getEncryptedCID(parseInt(donorId));
      }
      if (recipientId.trim()) {
        recipientEncCID = await registry.getRecipientEncryptedCID(parseInt(recipientId));
      }

      setStep('scoring');

      // 2. Compute encrypted compatibility score using provided or demo ciphertexts
      // In production, ciphertexts would be downloaded from IPFS using the CID
      const demoBloodTypeCt  = ct1 || 'DEMO_CT1_BASE64';
      const demoHlaScoreCt   = ct2 || 'DEMO_CT2_BASE64';
      const demoUrgencyCt    = ct3 || 'DEMO_CT3_BASE64';

      const { encryptedScore } = await computeScore(
        demoBloodTypeCt,
        demoHlaScoreCt,
        demoUrgencyCt,
        keyInfo.roleId,
        keyInfo.commitment
      );

      setStep('decrypting');

      // 3. Decrypt the score
      const { score } = await decryptScore(
        encryptedScore,
        keyInfo.roleId,
        keyInfo.commitment
      );

      const interpretation = interpretScore(score);
      setScoreResult({
        score,
        interpretation,
        donorId: donorId || 'demo',
        recipientId: recipientId || 'demo',
        encryptedScore: encryptedScore.slice(0, 40) + '…',
      });
      setStep('done');

    } catch (err) {
      console.error('[CompatibilityScore]', err);
      setError(err.message || 'Score computation failed');
      setStep('error');
    }
  }, [keyInfo, deployments, donorId, recipientId, ct1, ct2, ct3]);

  const isLoading = ['fetching', 'scoring', 'decrypting'].includes(step);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon">📊</div>
        <div>
          <h2>Compatibility Score</h2>
          <p className="card-subtitle">Homomorphic polynomial evaluation in the encrypted domain</p>
        </div>
      </div>

      {!keyInfo && (
        <div className="alert alert--warning">⚠️ Authenticate your role to compute scores.</div>
      )}

      {/* ID inputs */}
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="donor-id">Donor ID</label>
          <input
            id="donor-id"
            type="number"
            className="form-input"
            placeholder="0"
            value={donorId}
            min="0"
            onChange={e => setDonorId(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="recipient-id">Recipient ID</label>
          <input
            id="recipient-id"
            type="number"
            className="form-input"
            placeholder="0"
            value={recipientId}
            min="0"
            onChange={e => setRecipientId(e.target.value)}
          />
        </div>
      </div>

      {/* Advanced: ciphertext inputs */}
      <button
        className="btn-link"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? '▲ Hide' : '▼ Show'} advanced ciphertext inputs
      </button>

      {showAdvanced && (
        <div className="advanced-inputs">
          <p className="form-hint">
            In production, ciphertexts are automatically retrieved from IPFS using the CID.
            Paste base64 ciphertexts below for manual testing.
          </p>
          {[
            { id: 'ct1-input', label: 'ct1 — Blood Type Compatibility', val: ct1, set: setCt1 },
            { id: 'ct2-input', label: 'ct2 — HLA Match Score', val: ct2, set: setCt2 },
            { id: 'ct3-input', label: 'ct3 — Urgency Level', val: ct3, set: setCt3 },
          ].map(({ id, label, val, set }) => (
            <div key={id} className="form-group">
              <label htmlFor={id}>{label}</label>
              <textarea
                id={id}
                className="form-input form-textarea"
                placeholder="Base64 BFV ciphertext…"
                value={val}
                onChange={e => set(e.target.value)}
                rows={2}
              />
            </div>
          ))}
        </div>
      )}

      {/* Polynomial formula display */}
      <div className="formula-box">
        <p className="formula-label">Kidney Compatibility Polynomial:</p>
        <p className="formula">
          f(x) = 0.05 + 0.40·x₁ + 0.30·x₂ + 0.15·x₃ + 0.05·x₁x₂ + 0.05·x₂x₃
        </p>
        <p className="formula-note">
          x₁=blood type compatibility · x₂=HLA match · x₃=urgency (all encrypted)
        </p>
      </div>

      <button
        id="btn-compute-score"
        className="btn btn-primary btn-full"
        onClick={handleCompute}
        disabled={!keyInfo || isLoading}
      >
        {step === 'fetching'   && <><Spinner /> Fetching encrypted CIDs…</>}
        {step === 'scoring'    && <><Spinner /> Homomorphic evaluation…</>}
        {step === 'decrypting' && <><Spinner /> Decrypting score…</>}
        {step === 'done'       && '✓ Score Computed'}
        {(step === 'idle' || step === 'error') && '⚡ Compute Compatibility Score'}
      </button>

      {error && <div className="alert alert--error">⚠️ {error}</div>}

      {scoreResult && (
        <div className="score-result">
          <div className="score-header">
            <span className="score-number" style={{ color: scoreResult.interpretation.colour }}>
              {scoreResult.score}
            </span>
            <span className="score-max">/1000</span>
            <span className="score-label" style={{ color: scoreResult.interpretation.colour }}>
              {scoreResult.interpretation.label}
            </span>
          </div>

          {/* Visual bar */}
          <div className="score-bar-track" role="progressbar"
            aria-valuenow={scoreResult.score} aria-valuemin={0} aria-valuemax={1000}>
            <div
              className="score-bar-fill"
              style={{
                width: `${scoreResult.interpretation.pct}%`,
                background: scoreResult.interpretation.colour,
              }}
            />
          </div>
          <div className="score-pct">{scoreResult.interpretation.pct.toFixed(1)}% compatibility</div>

          <div className="key-info" style={{ marginTop: '1rem' }}>
            <InfoRow label="Donor ID"    value={`#${scoreResult.donorId}`} />
            <InfoRow label="Recipient"   value={`#${scoreResult.recipientId}`} />
            <InfoRow label="Enc. score"  value={scoreResult.encryptedScore} mono />
          </div>

          <div className="privacy-notice">
            🔐 Score computed entirely in the encrypted domain — no plaintext attributes exposed
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
