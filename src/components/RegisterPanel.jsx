/**
 * RegisterPanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Wraps DonorRegister / RecipientRegister behind a Donor|Recipient toggle so
 * a single "Register" tab covers both sides of the OrganRegistry workflow.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import DonorRegister from './DonorRegister';
import RecipientRegister from './RecipientRegister';

export default function RegisterPanel({ deployments, keyInfo }) {
  const [mode, setMode] = useState('donor'); // 'donor' | 'recipient'

  return (
    <div>
      <div className="tab-nav" role="tablist" aria-label="Register donor or recipient" style={{ marginBottom: '1rem' }}>
        <button
          id="register-mode-donor"
          role="tab"
          aria-selected={mode === 'donor'}
          className={`tab-btn${mode === 'donor' ? ' active' : ''}`}
          onClick={() => setMode('donor')}
        >
          <span className="tab-label">🫀 Donor</span>
        </button>
        <button
          id="register-mode-recipient"
          role="tab"
          aria-selected={mode === 'recipient'}
          className={`tab-btn${mode === 'recipient' ? ' active' : ''}`}
          onClick={() => setMode('recipient')}
        >
          <span className="tab-label">🏥 Recipient</span>
        </button>
      </div>

      {mode === 'donor'
        ? <DonorRegister deployments={deployments} keyInfo={keyInfo} />
        : <RecipientRegister deployments={deployments} keyInfo={keyInfo} />}
    </div>
  );
}
