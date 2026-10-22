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
import { computeScore, decryptScore, interpretScore, toCompatibilityScore } from '../utils/pfe';
import { downloadFromIPFS } from '../utils/ipfs';

const ORGAN_REGISTRY_ABI = [
  'function getCompatibilityScore(uint256 donorId, uint256 recipientId) view returns (bytes)',
  'function donorCount() view returns (uint256)',
  'function recipientCount() view returns (uint256)',
  'function donors(uint256) view returns (string encCID, uint8 bloodType, bytes32 hlaRoot, address registeredBy, bool active, uint256 ts)',
  'function recipients(uint256) view returns (string encCID, uint8 bloodType, bytes32 hlaRoot, address registeredBy, bool active, uint256 ts, uint8 urgency)',
];

const SCORE_ABI_TYPES = ['string', 'string', 'uint8', 'uint8', 'bytes32', 'bytes32', 'uint8'];

/**
 * Fetch a donor/recipient's real BFV ciphertexts from IPFS (registered via
 * DonorRegister.jsx / RecipientRegister.jsx). Returns null if unavailable
 * (e.g. record predates this ciphertext format, or IPFS daemon isn't
 * reachable) so callers can show a clear error instead of scoring garbage.
 */
async function fetchRealCiphertexts(encCID) {
  try {
    const bundle = await downloadFromIPFS(encCID);
    if (!bundle || !bundle.ctIsA || !bundle.ctIsB || !bundle.ctIsRhPos || !bundle.ctHla) return null;
    return {
      ctIsA:     bundle.ctIsA,
      ctIsB:     bundle.ctIsB,
      ctIsRhPos: bundle.ctIsRhPos,
      ctHla:     bundle.ctHla,
    };
  } catch (err) {
    console.warn('[CompatibilityScore] Could not fetch real ciphertexts for', encCID, err.message);
    return null;
  }
}

export default function CompatibilityScore({ deployments, keyInfo }) {
  const [donorId, setDonorId]         = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [step, setStep]               = useState('idle');
  const [scoreResult, setScoreResult] = useState(null);
  const [error, setError]             = useState('');

  // ── "Find Best Matches" — scans every active donor×recipient pair ────────
  const [matches, setMatches]         = useState(null);
  const [matchStep, setMatchStep]     = useState('idle'); // idle|scanning|done|error
  const [matchError, setMatchError]   = useState('');
  const [matchProgress, setMatchProgress] = useState('');

  // Accepts optional overrides so callers (e.g. "View" on a matched pair)
  // can compute immediately without waiting on a state update + re-render.
  const handleCompute = useCallback(async (overrideDonorId, overrideRecipientId) => {
    const useDonorId     = overrideDonorId     !== undefined ? String(overrideDonorId)     : donorId;
    const useRecipientId = overrideRecipientId !== undefined ? String(overrideRecipientId) : recipientId;

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

      // 1. Fetch encrypted CID commitments from OrganRegistry, then
      //    download+use the REAL BFV ciphertexts from IPFS.
      if (!useDonorId.trim() || !useRecipientId.trim()) {
        throw new Error('Enter both a Donor ID and a Recipient ID.');
      }
      const encodedData = await registry.getCompatibilityScore(parseInt(useDonorId), parseInt(useRecipientId));
      const [donorEncCID, recipEncCID] = ethers.AbiCoder.defaultAbiCoder().decode(SCORE_ABI_TYPES, encodedData);

      const [dCts, rCts] = await Promise.all([
        fetchRealCiphertexts(donorEncCID),
        fetchRealCiphertexts(recipEncCID),
      ]);
      if (!dCts || !rCts) {
        throw new Error('Could not retrieve this pair\'s encrypted attributes from IPFS — is the IPFS daemon running, and were both records registered after the PFE ciphertext format update?');
      }

      setStep('scoring');

      const { encryptedScore } = await computeScore(
        dCts,
        rCts,
        100, // W parameter
        keyInfo.roleId,
        keyInfo.commitment
      );

      setStep('decrypting');

      // 3. Decrypt the score. decryptScore() returns a raw dissimilarity
      //    distance (0 = perfect match) - convert to a compatibility score
      //    (higher = better, out of 1000) before displaying/interpreting it.
      const { score: rawDistance } = await decryptScore(
        encryptedScore,
        keyInfo.roleId,
        keyInfo.commitment
      );
      const score = toCompatibilityScore(rawDistance);

      const interpretation = interpretScore(score);
      setScoreResult({
        score,
        interpretation,
        donorId: useDonorId || 'demo',
        recipientId: useRecipientId || 'demo',
        encryptedScore: encryptedScore.slice(0, 40) + '…',
      });
      // Reflect the actual pair scored back into the input fields (relevant
      // when called via viewMatchDetail() with overrides).
      setDonorId(useDonorId);
      setRecipientId(useRecipientId);
      setStep('done');

    } catch (err) {
      console.error('[CompatibilityScore]', err);
      setError(err.message || 'Score computation failed');
      setStep('error');
    }
  }, [keyInfo, deployments, donorId, recipientId]);

  // ── Find Best Matches: scores every active donor×recipient pair ──────────
  const handleFindMatches = useCallback(async () => {
    if (!keyInfo) { setMatchError('Authenticate your role first.'); setMatchStep('error'); return; }
    if (!deployments) { setMatchError('Contracts not deployed.'); setMatchStep('error'); return; }

    setMatchError('');
    setMatches(null);
    setMatchStep('scanning');
    setMatchProgress('Reading donor/recipient counts…');

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const registry = new ethers.Contract(deployments.OrganRegistry, ORGAN_REGISTRY_ABI, provider);

      const [donorN, recipN] = await Promise.all([
        registry.donorCount().then(Number),
        registry.recipientCount().then(Number),
      ]);

      // 1. Gather each active donor's / recipient's real ciphertexts once
      //    (avoids re-downloading the same IPFS record for every pairing).
      const donorList = [];
      for (let i = 0; i < donorN; i++) {
        setMatchProgress(`Loading donor ${i + 1}/${donorN}…`);
        const d = await registry.donors(i);
        if (!d.active) continue;
        const cts = await fetchRealCiphertexts(d.encCID);
        if (cts) donorList.push({ id: i, ...cts });
      }

      const recipientList = [];
      for (let i = 0; i < recipN; i++) {
        setMatchProgress(`Loading recipient ${i + 1}/${recipN}…`);
        const r = await registry.recipients(i);
        if (!r.active) continue;
        const cts = await fetchRealCiphertexts(r.encCID);
        if (cts) recipientList.push({ id: i, ...cts });
      }

      if (donorList.length === 0 || recipientList.length === 0) {
        setMatchError('No active donor/recipient records with retrievable IPFS data were found. Register at least one of each first.');
        setMatchStep('error');
        return;
      }

      // 2. Score every pair (homomorphic evaluation + decrypt, per pair)
      const results = [];
      const total = donorList.length * recipientList.length;
      let done = 0;
      for (const d of donorList) {
        for (const r of recipientList) {
          setMatchProgress(`Scoring pair ${++done}/${total}…`);
          const { encryptedScore } = await computeScore(
            { ctIsA: d.ctIsA, ctIsB: d.ctIsB, ctIsRhPos: d.ctIsRhPos, ctHla: d.ctHla },
            { ctIsA: r.ctIsA, ctIsB: r.ctIsB, ctIsRhPos: r.ctIsRhPos, ctHla: r.ctHla },
            100,
            keyInfo.roleId,
            keyInfo.commitment
          );
          // decryptScore() returns a raw dissimilarity distance (0 = perfect
          // match) - convert to a compatibility score before ranking/display.
          const { score: rawDistance } = await decryptScore(encryptedScore, keyInfo.roleId, keyInfo.commitment);
          const score = toCompatibilityScore(rawDistance);
          results.push({ donorId: d.id, recipientId: r.id, score, interpretation: interpretScore(score) });
        }
      }

      results.sort((a, b) => b.score - a.score); // higher compatibility first
      setMatches(results);
      setMatchStep('done');

    } catch (err) {
      console.error('[CompatibilityScore] Find matches failed:', err);
      setMatchError(err.message || 'Matching scan failed');
      setMatchStep('error');
    }
  }, [keyInfo, deployments]);

  const viewMatchDetail = useCallback((m) => {
    handleCompute(m.donorId, m.recipientId);
  }, [handleCompute]);

  const isLoading = ['fetching', 'scoring', 'decrypting'].includes(step);
  const isMatching = matchStep === 'scanning';

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

      {/* Auto-matching: scan every active donor×recipient pair */}
      <div className="form-group">
        <button
          id="btn-find-matches"
          className="btn btn-primary btn-full"
          onClick={handleFindMatches}
          disabled={!keyInfo || isMatching || isLoading}
        >
          {isMatching ? <><Spinner /> {matchProgress || 'Scanning…'}</> : '🔍 Find Best Matches (all pairs)'}
        </button>
        <p className="form-hint">
          Scores every active donor against every active recipient using real
          BFV ciphertexts fetched from IPFS, and ranks the results.
        </p>
      </div>

      {matchError && matchStep === 'error' && (
        <div className="alert alert--error">⚠️ {matchError}</div>
      )}

      {matches && matchStep === 'done' && (
        <div className="score-result" style={{ marginBottom: '1.5rem' }}>
          <p className="formula-label">
            {matches.length} pair{matches.length === 1 ? '' : 's'} scored — best match first
          </p>
          <table className="match-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Donor</th>
                <th style={{ textAlign: 'left' }}>Recipient</th>
                <th style={{ textAlign: 'left' }}>Score</th>
                <th style={{ textAlign: 'left' }}>Match</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={`${m.donorId}-${m.recipientId}`} style={i === 0 ? { fontWeight: 'bold' } : undefined}>
                  <td>#{m.donorId}</td>
                  <td>#{m.recipientId}</td>
                  <td style={{ color: m.interpretation.colour }}>{m.score}/1000</td>
                  <td style={{ color: m.interpretation.colour }}>
                    {i === 0 ? '🏆 ' : ''}{m.interpretation.label}
                  </td>
                  <td>
                    <button className="btn-link" onClick={() => viewMatchDetail(m)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="form-hint" style={{ margin: '1rem 0' }}>
        Or look up one specific pair manually:
      </p>

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

      {/* Polynomial formula display */}
      <div className="formula-box">
        <p className="formula-label">Compatibility Distance Equation:</p>
        <p className="formula">
          distance = HLA_WEIGHT·(donor.hla − recip.hla)² + W·(ABO/Rh incompatibility count)
        </p>
        <p className="formula-note">
          ABO/Rh incompatibility count (0–3) is a real donor→recipient blood
          compatibility check evaluated homomorphically — not a same/different
          proxy. Lower distance = better match; displayed as 1000 − distance.
          Variables are fully encrypted during homomorphic evaluation.
        </p>
      </div>

      <button
        id="btn-compute-score"
        className="btn btn-primary btn-full"
        onClick={() => handleCompute()}
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
            <InfoRow label="Data source" value="✅ Real IPFS-registered ciphertexts" />
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
