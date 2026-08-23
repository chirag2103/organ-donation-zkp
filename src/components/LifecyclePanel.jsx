/**
 * LifecyclePanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * GDPR Article 17 lifecycle management panel.
 * Lists active donors from DonorRegistered events, allows revocation for
 * authorised roles (bit5), and polls for RevocationExecuted confirmations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

const ORGAN_REGISTRY_ABI = [
  'event DonorRegistered(uint256 indexed id, bytes32 encCID, address registeredBy)',
];

const LIFECYCLE_ABI = [
  'function requestRevocation(uint256 donorId) external',
  'function executeRevocation(uint256 donorId, bytes32 cid) external',
  'function getRevocationStatus(uint256 donorId) view returns (tuple(uint8 status, address requestedBy, uint256 requestedAt, bytes32 cid, uint256 executedAt))',
  'event RevocationRequested(uint256 indexed donorId, address requestedBy, uint256 ts)',
  'event RevocationExecuted(uint256 indexed donorId, bytes32 cid, uint256 ts)',
];

const REVOCATION_STATUS = ['None', 'Requested', 'Executed'];
const PERM_TRIGGER_REVOCATION = 5; // bit5

export default function LifecyclePanel({ deployments, keyInfo }) {
  const [donors, setDonors]       = useState([]);
  const [revocationLog, setRevocationLog] = useState([]);
  const [loadingDonors, setLoadingDonors] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [error, setError]         = useState('');

  const hasRevocationPermission = keyInfo &&
    (keyInfo.permissions & (1 << PERM_TRIGGER_REVOCATION)) !== 0;

  // ── Load donors from DonorRegistered events ────────────────────────────
  const loadDonors = useCallback(async () => {
    if (!deployments) return;
    setLoadingDonors(true);
    setError('');

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const registry = new ethers.Contract(
        deployments.OrganRegistry,
        ORGAN_REGISTRY_ABI,
        provider
      );

      // Query all DonorRegistered events from block 0
      const filter = registry.filters.DonorRegistered();
      const events = await registry.queryFilter(filter, 0, 'latest');

      // Fetch revocation status for each donor
      const lifecycle = new ethers.Contract(
        deployments.LifecycleManager,
        LIFECYCLE_ABI,
        provider
      );

      const donorList = await Promise.all(
        events.map(async (evt) => {
          const { id, encCID, registeredBy } = evt.args;
          let revStatus = 0;
          try {
            const rec = await lifecycle.getRevocationStatus(id);
            revStatus = Number(rec.status);
          } catch {}

          return {
            id:            id.toString(),
            encCID:        encCID,
            registeredBy:  registeredBy,
            txHash:        evt.transactionHash,
            blockNumber:   evt.blockNumber,
            revStatus,
          };
        })
      );

      setDonors(donorList);
    } catch (err) {
      console.error('[Lifecycle]', err);
      setError('Failed to load donor events: ' + err.message);
    } finally {
      setLoadingDonors(false);
    }
  }, [deployments]);

  // ── Poll for revocation events ─────────────────────────────────────────
  const listenForRevocations = useCallback(async () => {
    if (!deployments) return;
    const provider = new ethers.BrowserProvider(window.ethereum);
    const lifecycle = new ethers.Contract(
      deployments.LifecycleManager,
      LIFECYCLE_ABI,
      provider
    );

    lifecycle.on('RevocationExecuted', (donorId, cid, ts) => {
      const entry = {
        donorId:   donorId.toString(),
        cid:       ethers.hexlify(cid),
        ts:        new Date(Number(ts) * 1000).toLocaleString(),
        key:       `${donorId}-${ts}`,
      };
      setRevocationLog(prev => [entry, ...prev].slice(0, 20));
      // Refresh donor list to update status
      setDonors(prev => prev.map(d =>
        d.id === donorId.toString() ? { ...d, revStatus: 2 } : d
      ));
    });

    lifecycle.on('RevocationRequested', (donorId, requestedBy, ts) => {
      setDonors(prev => prev.map(d =>
        d.id === donorId.toString() ? { ...d, revStatus: 1 } : d
      ));
    });

    return () => lifecycle.removeAllListeners();
  }, [deployments]);

  useEffect(() => {
    if (deployments) {
      loadDonors();
      listenForRevocations();
    }
  }, [deployments, loadDonors, listenForRevocations]);

  // ── Request revocation ─────────────────────────────────────────────────
  const handleRevoke = useCallback(async (donor) => {
    if (!hasRevocationPermission) {
      setError('Your role does not have revocation permission (bit5 required).');
      return;
    }

    setRevokingId(donor.id);
    setError('');

    try {
      const provider  = new ethers.BrowserProvider(window.ethereum);
      const signer    = await provider.getSigner();
      const lifecycle = new ethers.Contract(
        deployments.LifecycleManager,
        LIFECYCLE_ABI,
        signer
      );

      // Step 1: Request revocation
      const reqTx = await lifecycle.requestRevocation(donor.id);
      await reqTx.wait();

      // Step 2: Execute revocation (providing CID as the encCID we have on-chain)
      const execTx = await lifecycle.executeRevocation(donor.id, donor.encCID);
      await execTx.wait();

      // Update UI
      setDonors(prev => prev.map(d =>
        d.id === donor.id ? { ...d, revStatus: 2 } : d
      ));
    } catch (err) {
      console.error('[Lifecycle revoke]', err);
      setError(err.reason || err.message || 'Revocation failed');
    } finally {
      setRevokingId(null);
    }
  }, [hasRevocationPermission, deployments]);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon">⚖️</div>
        <div>
          <h2>Lifecycle Manager</h2>
          <p className="card-subtitle">GDPR Article 17 — Right to Erasure</p>
        </div>
      </div>

      {!keyInfo && (
        <div className="alert alert--warning">⚠️ Authenticate your role to manage lifecycle.</div>
      )}

      {!hasRevocationPermission && keyInfo && (
        <div className="alert alert--info">
          ℹ️ Your role does not have revocation permission.
          Revocation requires bit5 (Surgeon or Coordinator).
        </div>
      )}

      {/* Donor list */}
      <div className="section-header">
        <h3>Registered Donors ({donors.length})</h3>
        <button
          id="btn-refresh-donors"
          className="btn btn-secondary btn-sm"
          onClick={loadDonors}
          disabled={loadingDonors}
        >
          {loadingDonors ? <Spinner /> : '↻'} Refresh
        </button>
      </div>

      {error && <div className="alert alert--error">⚠️ {error}</div>}

      {donors.length === 0 && !loadingDonors && (
        <div className="empty-state">
          <span>🫀</span>
          <p>No donor records found. Register a donor first.</p>
        </div>
      )}

      <div className="donor-list">
        {donors.map(donor => (
          <div key={donor.id} className={`donor-card donor-card--${statusClass(donor.revStatus)}`}>
            <div className="donor-card-header">
              <span className="donor-id">Donor #{donor.id}</span>
              <span className={`status-badge status-badge--${statusClass(donor.revStatus)}`}>
                {statusIcon(donor.revStatus)} {REVOCATION_STATUS[donor.revStatus]}
              </span>
            </div>

            <div className="donor-card-body">
              <div className="info-row">
                <span className="info-label">Enc. CID</span>
                <span className="info-value mono">{donor.encCID?.slice(0, 18)}…</span>
              </div>
              <div className="info-row">
                <span className="info-label">Registered by</span>
                <span className="info-value mono">
                  {donor.registeredBy?.slice(0, 8)}…{donor.registeredBy?.slice(-4)}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">Block</span>
                <span className="info-value">#{donor.blockNumber}</span>
              </div>
            </div>

            {hasRevocationPermission && donor.revStatus < 2 && (
              <button
                id={`btn-revoke-${donor.id}`}
                className="btn btn-danger btn-sm"
                onClick={() => handleRevoke(donor)}
                disabled={revokingId === donor.id || donor.revStatus === 2}
              >
                {revokingId === donor.id
                  ? <><Spinner /> Revoking…</>
                  : '🗑 Request GDPR Erasure'}
              </button>
            )}

            {donor.revStatus === 2 && (
              <div className="revoked-notice">
                ✅ Revoked — IPFS unpin triggered automatically
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Revocation log */}
      {revocationLog.length > 0 && (
        <div className="revocation-log">
          <h3>Revocation Log</h3>
          <div className="log-list">
            {revocationLog.map(entry => (
              <div key={entry.key} className="log-entry">
                <span className="log-icon">🗑</span>
                <div className="log-body">
                  <strong>Donor #{entry.donorId}</strong> revoked at {entry.ts}
                  <div className="log-cid mono">{entry.cid.slice(0, 24)}…</div>
                  <div className="log-note">IPFS unpin triggered by backend listener</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function statusClass(s) {
  return ['none', 'requested', 'executed'][s] || 'none';
}
function statusIcon(s) {
  return ['⬜', '🟡', '✅'][s] || '⬜';
}
function Spinner() {
  return <span className="spinner">⟳</span>;
}
