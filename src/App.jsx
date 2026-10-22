/**
 * App.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Main application shell for the ZKP-Authenticated PFE-Gated Organ Donation
 * System. Manages tab navigation, wallet state, key info propagation,
 * and deployment loading.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import RoleAuth          from './components/RoleAuth';
import RegisterPanel     from './components/RegisterPanel';
import CompatibilityScore from './components/CompatibilityScore';
import LifecyclePanel    from './components/LifecyclePanel';

// Deployment addresses — written by scripts/deploy.js
let deployments = null;
try {
  deployments = (await import('./deployments.json', { assert: { type: 'json' } })).default;
} catch {
  // Deployments not yet generated — will show warning
}

const TABS = [
  { id: 'auth',     label: '🔐 Role Auth',    desc: 'ZKP Authentication' },
  { id: 'register', label: '🫀 Register',      desc: 'Donor / Recipient Registration' },
  { id: 'score',    label: '📊 Score',         desc: 'Compatibility' },
  { id: 'lifecycle',label: '⚖️ Lifecycle',     desc: 'GDPR Article 17' },
];

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function App() {
  const [activeTab, setActiveTab]   = useState('auth');
  const [keyInfo, setKeyInfo]       = useState(null);
  const [systemStatus, setStatus]   = useState({ ipfs: null, blockchain: null, seal: null });

  // ── Poll system status ─────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const res  = await fetch(`${API_BASE}/api/status`);
        const data = await res.json();
        setStatus(data);
      } catch {
        setStatus({ ipfs: false, blockchain: false, seal: false });
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    return () => clearInterval(timer);
  }, []);

  // ── Clear key info on expiry ───────────────────────────────────────────
  useEffect(() => {
    if (!keyInfo) return;
    const msLeft = keyInfo.expiresAt * 1000 - Date.now();
    if (msLeft <= 0) { setKeyInfo(null); return; }
    const timer = setTimeout(() => setKeyInfo(null), msLeft);
    return () => clearTimeout(timer);
  }, [keyInfo]);

  const handleKeyIssued = useCallback((info) => {
    setKeyInfo(info);
    setActiveTab('register'); // advance to next step
  }, []);

  // ── Key expiry countdown ───────────────────────────────────────────────
  const [countdown, setCountdown] = useState('');
  useEffect(() => {
    if (!keyInfo) return;
    const tick = () => {
      const ms  = keyInfo.expiresAt * 1000 - Date.now();
      if (ms <= 0) { setCountdown('Expired'); return; }
      const h   = Math.floor(ms / 3600000);
      const m   = Math.floor((ms % 3600000) / 60000);
      const s   = Math.floor((ms % 60000) / 1000);
      setCountdown(`${h}h ${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [keyInfo]);

  return (
    <div className="app">
      {/* ── Animated background ─── */}
      <div className="bg-mesh" aria-hidden="true">
        <div className="mesh-orb mesh-orb--1" />
        <div className="mesh-orb mesh-orb--2" />
        <div className="mesh-orb mesh-orb--3" />
      </div>

      {/* ── Header ─── */}
      <header className="app-header">
        <div className="header-logo">
          <div className="logo-icon">🫀</div>
          <div>
            <h1 className="header-title">ZKP · PFE · Organ Donation</h1>
            <p className="header-subtitle">Privacy-Preserving Transplant Platform on Blockchain</p>
          </div>
        </div>

        {/* System status indicators */}
        <div className="status-row" role="status" aria-label="System status">
          <StatusDot label="IPFS"       ok={systemStatus.ipfs}       />
          <StatusDot label="Blockchain" ok={systemStatus.blockchain}  />
          <StatusDot label="SEAL BFV"   ok={systemStatus.seal}       />
        </div>

        {/* Active key badge */}
        {keyInfo && (
          <div className="key-badge" title={`Commitment: ${keyInfo.commitment}`}>
            <span className="dot dot--green" />
            <span>Key active — {countdown}</span>
          </div>
        )}
      </header>

      {/* ── Novelty banner ─── */}
      <div className="novelty-banner">
        <span>⚡</span>
        <span>
          First system to integrate <strong>ZKP role authentication</strong> gating
          <strong> PFE key issuance</strong> on <strong>IPFS-backed</strong> organ records
          with GDPR Article 17 lifecycle management
        </span>
      </div>

      {/* ── Deployment warning ─── */}
      {!deployments && (
        <div className="alert alert--warning alert--banner">
          ⚠️ No deployment found. Run{' '}
          <code>npx hardhat run scripts/deploy.js --network localhost</code> first.
        </div>
      )}

      {/* ── Navigation tabs ─── */}
      <nav className="tab-nav" role="tablist" aria-label="Main navigation">
        {TABS.map(tab => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`tab-btn${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-label">{tab.label}</span>
            <span className="tab-desc">{tab.desc}</span>
          </button>
        ))}
      </nav>

      {/* ── Tab panels ─── */}
      <main className="app-main" role="tabpanel">
        {activeTab === 'auth' && (
          <RoleAuth
            deployments={deployments}
            onKeyIssued={handleKeyIssued}
          />
        )}
        {activeTab === 'register' && (
          <RegisterPanel
            deployments={deployments}
            keyInfo={keyInfo}
          />
        )}
        {activeTab === 'score' && (
          <CompatibilityScore
            deployments={deployments}
            keyInfo={keyInfo}
          />
        )}
        {activeTab === 'lifecycle' && (
          <LifecyclePanel
            deployments={deployments}
            keyInfo={keyInfo}
          />
        )}
      </main>

      {/* ── Footer ─── */}
      <footer className="app-footer">
        <p>
          🔐 ZKP (Groth16) · 🔑 PFE (BFV/SEAL) · 📦 IPFS (kubo) ·
          ⛓ Ethereum (Hardhat PoA) · GDPR Article 5(1)(f) + 17
        </p>
        <p className="footer-novelty">
          Novel contribution: First integration of ZKP-gated PFE key issuance
          on IPFS-backed organ records (vs. Samsukha 2025, Block-Privacy 2023)
        </p>
      </footer>
    </div>
  );
}

function StatusDot({ label, ok }) {
  const cls = ok === null ? 'pending' : ok ? 'green' : 'red';
  return (
    <div className="status-dot-wrapper">
      <span className={`dot dot--${cls}`} />
      <span className="status-label">{label}</span>
    </div>
  );
}
