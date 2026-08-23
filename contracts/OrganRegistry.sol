// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PFEKeyIssuer.sol";

/**
 * @title OrganRegistry
 * @notice Stores encrypted donor and recipient records as keccak256(IPFS CID)
 *         commitments. Plain CIDs and patient data are NEVER stored on-chain.
 *
 * Access Control:
 *   - All write operations require a valid PFE key (verified via PFEKeyIssuer)
 *   - deactivateDonor / deactivateRecipient are restricted to LifecycleManager
 *
 * GDPR Design:
 *   - No PII is stored on-chain; only pseudonymous commitments
 *   - Records are deactivated (not deleted) to maintain audit trail
 *   - Actual data revocation is achieved via IPFS unpinning (off-chain)
 */
contract OrganRegistry {

    // ── Dependency ────────────────────────────────────────────────────────
    PFEKeyIssuer public immutable pfeKeyIssuer;

    // ── Authorised LifecycleManager (set post-deploy) ─────────────────────
    address public lifecycleManager;
    address public owner;

    // ── Data structures ───────────────────────────────────────────────────
    struct DonorRecord {
        bytes32 encCID;          // keccak256 of the IPFS CID string
        uint8   bloodType;       // 0=A+, 1=A-, 2=B+, 3=B-, 4=AB+, 5=AB-, 6=O+, 7=O-
        bytes32 hlaRoot;         // Merkle root of HLA antigen set (off-chain)
        address registeredBy;    // Pseudonymous address of registering party
        bool    active;
        uint256 ts;              // Registration timestamp
    }

    struct RecipientRecord {
        bytes32 encCID;
        uint8   bloodType;
        bytes32 hlaRoot;
        address registeredBy;
        bool    active;
        uint256 ts;
        uint8   urgency;         // 0=standard, 1=urgent, 2=emergency
    }

    // ── Storage ───────────────────────────────────────────────────────────
    mapping(uint256 => DonorRecord)     public donors;
    mapping(uint256 => RecipientRecord) public recipients;
    uint256 public donorCount;
    uint256 public recipientCount;

    // ── Events ────────────────────────────────────────────────────────────
    event DonorRegistered(
        uint256 indexed id,
        bytes32         encCID,
        address         registeredBy
    );
    event RecipientRegistered(
        uint256 indexed id,
        bytes32         encCID,
        address         registeredBy
    );
    event DonorDeactivated(uint256 indexed id, address deactivatedBy);
    event RecipientDeactivated(uint256 indexed id, address deactivatedBy);
    event LifecycleManagerSet(address indexed mgr);

    // ── Custom errors ─────────────────────────────────────────────────────
    error NotAuthorised();
    error InvalidKey();
    error DonorNotFound(uint256 id);
    error RecipientNotFound(uint256 id);
    error AlreadyInactive(uint256 id);
    error ZeroEncCID();

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorised();
        _;
    }

    modifier onlyValidKey() {
        (bool valid, , ) = pfeKeyIssuer.isKeyValid(msg.sender);
        if (!valid) revert InvalidKey();
        _;
    }

    modifier onlyLifecycleManager() {
        if (msg.sender != lifecycleManager) revert NotAuthorised();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(address _pfeKeyIssuer) {
        require(_pfeKeyIssuer != address(0), "OrganRegistry: zero address");
        pfeKeyIssuer = PFEKeyIssuer(_pfeKeyIssuer);
        owner = msg.sender;
    }

    // ── Admin: Set LifecycleManager ───────────────────────────────────────

    /**
     * @notice Links the LifecycleManager contract (called once after deployment).
     */
    function setLifecycleManager(address _mgr) external onlyOwner {
        require(_mgr != address(0), "OrganRegistry: zero mgr address");
        lifecycleManager = _mgr;
        emit LifecycleManagerSet(_mgr);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Donor operations
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a new donor record with encrypted IPFS CID commitment.
     * @param encCID    keccak256(ipfs_cid_string) — binds record to IPFS content.
     * @param bloodType Blood type code (0–7).
     * @param hlaRoot   Merkle root of HLA antigen matches (computed off-chain).
     * @return id       Assigned donor ID.
     */
    function registerDonor(
        bytes32 encCID,
        uint8   bloodType,
        bytes32 hlaRoot
    ) external onlyValidKey returns (uint256 id) {
        if (encCID == bytes32(0)) revert ZeroEncCID();
        id = donorCount++;
        donors[id] = DonorRecord({
            encCID:       encCID,
            bloodType:    bloodType,
            hlaRoot:      hlaRoot,
            registeredBy: msg.sender,
            active:       true,
            ts:           block.timestamp
        });
        emit DonorRegistered(id, encCID, msg.sender);
    }

    /**
     * @notice Deactivate a donor record (called by LifecycleManager on revocation).
     */
    function deactivateDonor(uint256 donorId)
        external
        onlyLifecycleManager
    {
        if (donors[donorId].ts == 0) revert DonorNotFound(donorId);
        if (!donors[donorId].active) revert AlreadyInactive(donorId);
        donors[donorId].active = false;
        emit DonorDeactivated(donorId, msg.sender);
    }

    /**
     * @notice Returns the encrypted CID commitment for a donor.
     */
    function getEncryptedCID(uint256 donorId)
        external
        view
        returns (bytes32)
    {
        if (donors[donorId].ts == 0) revert DonorNotFound(donorId);
        return donors[donorId].encCID;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recipient operations
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a new recipient record.
     * @param encCID    keccak256(ipfs_cid_string).
     * @param bloodType Blood type code (0–7).
     * @param hlaRoot   HLA Merkle root.
     * @param urgency   0=standard, 1=urgent, 2=emergency.
     * @return id       Assigned recipient ID.
     */
    function registerRecipient(
        bytes32 encCID,
        uint8   bloodType,
        bytes32 hlaRoot,
        uint8   urgency
    ) external onlyValidKey returns (uint256 id) {
        if (encCID == bytes32(0)) revert ZeroEncCID();
        require(urgency <= 2, "OrganRegistry: invalid urgency");
        id = recipientCount++;
        recipients[id] = RecipientRecord({
            encCID:       encCID,
            bloodType:    bloodType,
            hlaRoot:      hlaRoot,
            registeredBy: msg.sender,
            active:       true,
            ts:           block.timestamp,
            urgency:      urgency
        });
        emit RecipientRegistered(id, encCID, msg.sender);
    }

    /**
     * @notice Deactivate a recipient record.
     */
    function deactivateRecipient(uint256 recipientId)
        external
        onlyLifecycleManager
    {
        if (recipients[recipientId].ts == 0) revert RecipientNotFound(recipientId);
        if (!recipients[recipientId].active) revert AlreadyInactive(recipientId);
        recipients[recipientId].active = false;
        emit RecipientDeactivated(recipientId, msg.sender);
    }

    /**
     * @notice Returns the recipient encrypted CID.
     */
    function getRecipientEncryptedCID(uint256 recipientId)
        external
        view
        returns (bytes32)
    {
        if (recipients[recipientId].ts == 0) revert RecipientNotFound(recipientId);
        return recipients[recipientId].encCID;
    }
}
