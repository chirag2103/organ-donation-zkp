// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OrganRegistry.sol";
import "./PFEKeyIssuer.sol";

/**
 * @title LifecycleManager
 * @notice Implements GDPR Article 17 ("right to erasure") for organ donation
 *         records by triggering IPFS unpinning and deactivating on-chain records.
 *
 * Flow:
 *  1. Authorised actor (with bit5 permission) calls requestRevocation()
 *  2. Owner or anyone calls executeRevocation() to emit RevocationExecuted
 *  3. Off-chain backend listens to RevocationExecuted → calls ipfsService.unpinRecord()
 *  4. OrganRegistry.deactivateDonor() is called to mark record inactive
 *
 * Automatic Revocation:
 *  - scheduleAutoRevocation() sets a retention deadline for a donor record
 *  - processScheduled() checks all scheduled records and executes expired ones
 */
contract LifecycleManager {

    // ── Dependencies ──────────────────────────────────────────────────────
    OrganRegistry public immutable organRegistry;
    PFEKeyIssuer  public immutable pfeKeyIssuer;
    address       public owner;

    // ── Constants ─────────────────────────────────────────────────────────
    uint8 public constant PERM_TRIGGER_REVOCATION = 5; // bit5

    // ── Data structures ───────────────────────────────────────────────────
    enum RevocationStatus { None, Requested, Executed }

    struct RevocationRecord {
        RevocationStatus status;
        address          requestedBy;
        uint256          requestedAt;
        string           cid;
        uint256          executedAt;
    }

    struct ScheduledRevocation {
        uint256 donorId;
        uint256 revocationAfter; // Unix timestamp
        bool    executed;
    }

    // ── Storage ───────────────────────────────────────────────────────────
    mapping(uint256 => RevocationRecord)  public revocations;
    ScheduledRevocation[]                 public scheduled;

    // ── Events ────────────────────────────────────────────────────────────
    event RevocationRequested(
        uint256 indexed donorId,
        address         requestedBy,
        uint256         ts
    );
    event RevocationExecuted(
        uint256 indexed donorId,
        string          cid,
        uint256         ts
    );
    event AutoRevocationScheduled(
        uint256 indexed donorId,
        uint256         revocationAfter
    );

    // ── Custom errors ─────────────────────────────────────────────────────
    error NotAuthorised();
    error AlreadyRevoked(uint256 donorId);
    error RevocationNotRequested(uint256 donorId);
    error NoRevocationPermission();

    // ── Modifiers ─────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorised();
        _;
    }

    modifier requireRevocationPermission() {
        bool hasPerm = pfeKeyIssuer.hasPermission(msg.sender, PERM_TRIGGER_REVOCATION);
        if (!hasPerm) revert NoRevocationPermission();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(address _organRegistry, address _pfeKeyIssuer) {
        require(_organRegistry != address(0), "LifecycleManager: zero org addr");
        require(_pfeKeyIssuer  != address(0), "LifecycleManager: zero key addr");
        organRegistry = OrganRegistry(_organRegistry);
        pfeKeyIssuer  = PFEKeyIssuer(_pfeKeyIssuer);
        owner = msg.sender;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Revocation flow
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Initiate a revocation request for a donor record.
     *         Caller must hold a valid key with bit5 (triggerRevocation) permission.
     * @param donorId  ID of the donor record in OrganRegistry.
     */
    function requestRevocation(uint256 donorId)
        external
        requireRevocationPermission
    {
        RevocationRecord storage rec = revocations[donorId];
        if (rec.status == RevocationStatus.Executed) revert AlreadyRevoked(donorId);

        rec.status      = RevocationStatus.Requested;
        rec.requestedBy = msg.sender;
        rec.requestedAt = block.timestamp;

        emit RevocationRequested(donorId, msg.sender, block.timestamp);
    }

    /**
     * @notice Execute a revocation: deactivates the on-chain record and emits
     *         RevocationExecuted (which the backend listens to for IPFS unpinning).
     * @param donorId  Donor record ID.
     * @param cid      The IPFS CID string (provided by backend after lookup).
     */
    function executeRevocation(uint256 donorId, string calldata cid)
        external
        requireRevocationPermission
    {
        RevocationRecord storage rec = revocations[donorId];
        if (rec.status == RevocationStatus.None)     revert RevocationNotRequested(donorId);
        if (rec.status == RevocationStatus.Executed) revert AlreadyRevoked(donorId);

        rec.status     = RevocationStatus.Executed;
        rec.cid        = cid;
        rec.executedAt = block.timestamp;

        // Deactivate on-chain record
        organRegistry.deactivateDonor(donorId);

        emit RevocationExecuted(donorId, cid, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Automatic (scheduled) revocation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Schedule automatic revocation after a retention period.
     * @param donorId        Donor record to revoke.
     * @param retentionDays  Days to retain data before automatic revocation.
     */
    function scheduleAutoRevocation(uint256 donorId, uint256 retentionDays)
        external
        onlyOwner
    {
        uint256 revAfter = block.timestamp + (retentionDays * 1 days);
        scheduled.push(ScheduledRevocation({
            donorId:         donorId,
            revocationAfter: revAfter,
            executed:        false
        }));
        emit AutoRevocationScheduled(donorId, revAfter);
    }

    /**
     * @notice Process all scheduled revocations whose retention period has expired.
     *         Callable by anyone (no permission required) to enable keeper bots.
     *         Processes up to 50 records per call to bound gas usage.
     */
    function processScheduled() external {
        uint256 processed = 0;
        uint256 len = scheduled.length;

        for (uint256 i = 0; i < len && processed < 50; i++) {
            ScheduledRevocation storage s = scheduled[i];
            if (s.executed) continue;
            if (block.timestamp < s.revocationAfter) continue;

            // Mark as executed before external calls (re-entrancy guard)
            s.executed = true;
            processed++;

            // Request if not already requested
            RevocationRecord storage rec = revocations[s.donorId];
            if (rec.status == RevocationStatus.None) {
                rec.status      = RevocationStatus.Requested;
                rec.requestedBy = address(this);
                rec.requestedAt = block.timestamp;
                emit RevocationRequested(s.donorId, address(this), block.timestamp);
            }

            // Only execute if not already done
            if (rec.status != RevocationStatus.Executed) {
                rec.status     = RevocationStatus.Executed;
                rec.executedAt = block.timestamp;
                // cid is empty here; backend resolves the real CID from donorId
                string memory placeholderCid = "scheduled";
                rec.cid = placeholderCid;

                // Deactivate record (may revert if already inactive — safe to ignore)
                try organRegistry.deactivateDonor(s.donorId) {
                    emit RevocationExecuted(s.donorId, placeholderCid, block.timestamp);
                } catch {
                    // Already inactive; still emit for backend to unpin
                    emit RevocationExecuted(s.donorId, placeholderCid, block.timestamp);
                }
            }
        }
    }

    /**
     * @notice Returns number of scheduled revocations.
     */
    function scheduledCount() external view returns (uint256) {
        return scheduled.length;
    }

    /**
     * @notice Returns status of a donor revocation.
     */
    function getRevocationStatus(uint256 donorId)
        external
        view
        returns (RevocationRecord memory)
    {
        return revocations[donorId];
    }
}
