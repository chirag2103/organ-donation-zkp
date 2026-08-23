// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RoleRegistry
 * @notice Manages role-scoped Merkle roots for ZKP credential verification.
 *         Six roles are defined, each with a permission bitmask and a Merkle
 *         root of valid credentials (set off-chain by the system owner).
 *
 * Permission Bitmask Layout:
 *   bit0 = viewCompatibilityScore
 *   bit1 = viewDonorIdentity
 *   bit2 = updateOrganStatus
 *   bit3 = initiateTransport
 *   bit4 = confirmTransplant
 *   bit5 = triggerRevocation
 */
contract RoleRegistry is Ownable {

    // ── Roles ─────────────────────────────────────────────────────────────
    uint8 public constant ROLE_DOCTOR       = 0;
    uint8 public constant ROLE_COORDINATOR  = 1;
    uint8 public constant ROLE_PROCUREMENT  = 2;
    uint8 public constant ROLE_MATCHING     = 3;
    uint8 public constant ROLE_TRANSPORTER  = 4;
    uint8 public constant ROLE_SURGEON      = 5;
    uint8 public constant ROLE_COUNT        = 6;

    // ── Permission bitmasks per role ──────────────────────────────────────
    // bit0 = viewCompatibilityScore
    // bit1 = viewDonorIdentity
    // bit2 = updateOrganStatus
    // bit3 = initiateTransport
    // bit4 = confirmTransplant
    // bit5 = triggerRevocation
    mapping(uint8 => uint256) private _permissions;

    // ── Merkle roots per role (set by owner after off-chain ceremony) ─────
    mapping(uint8 => bytes32) private _credentialRoots;

    // ── Events ────────────────────────────────────────────────────────────
    event CredentialRootUpdated(uint8 indexed roleId, bytes32 merkleRoot);

    // ── Custom errors ─────────────────────────────────────────────────────
    error InvalidRoleId(uint8 roleId);
    error ZeroMerkleRoot();

    // ── Constructor ───────────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {
        // Set permission bitmasks for all 6 roles
        // DOCTOR: can view compatibility, view identity, update status, confirm transplant
        _permissions[ROLE_DOCTOR]       = 0x17; // bits: 10111 = 0+1+2+4 = 23 → bits 0,1,2,4
        // COORDINATOR: all permissions except triggerRevocation bit
        _permissions[ROLE_COORDINATOR]  = 0x1F; // bits: 0-4 = 31
        // PROCUREMENT: view score, update status, initiate transport
        _permissions[ROLE_PROCUREMENT]  = 0x0D; // bits: 0,2,3 = 13
        // MATCHING: only view score and identity
        _permissions[ROLE_MATCHING]     = 0x03; // bits: 0,1 = 3
        // TRANSPORTER: initiate transport only
        _permissions[ROLE_TRANSPORTER]  = 0x08; // bit3 = 8
        // SURGEON: view score, view identity, confirm transplant, trigger revocation
        _permissions[ROLE_SURGEON]      = 0x33; // bits: 0,1,4,5 = 51
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier validRole(uint8 roleId) {
        if (roleId >= ROLE_COUNT) revert InvalidRoleId(roleId);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner-only: set credential Merkle root for a role
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register or update the Merkle root of valid credentials for a role.
     * @param roleId     Role identifier (0–5).
     * @param merkleRoot Keccak/Poseidon Merkle root from off-chain credential tree.
     */
    function registerCredentialRoot(uint8 roleId, bytes32 merkleRoot)
        external
        onlyOwner
        validRole(roleId)
    {
        if (merkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        _credentialRoots[roleId] = merkleRoot;
        emit CredentialRootUpdated(roleId, merkleRoot);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the permission bitmask for a given role.
     */
    function getPermissions(uint8 roleId)
        external
        view
        validRole(roleId)
        returns (uint256)
    {
        return _permissions[roleId];
    }

    /**
     * @notice Returns the Merkle root registered for a role.
     */
    function getRoleRoot(uint8 roleId)
        external
        view
        validRole(roleId)
        returns (bytes32)
    {
        return _credentialRoots[roleId];
    }

    /**
     * @notice Checks whether a role has a specific permission bit set.
     * @param roleId     Role to check.
     * @param permBit    Bit position (0–5) to test.
     */
    function hasPermission(uint8 roleId, uint8 permBit)
        external
        view
        validRole(roleId)
        returns (bool)
    {
        return (_permissions[roleId] & (1 << permBit)) != 0;
    }

    /**
     * @notice Returns human-readable role name for a given ID (off-chain use).
     */
    function getRoleName(uint8 roleId)
        external
        pure
        validRole(roleId)
        returns (string memory)
    {
        string[6] memory names = [
            "DOCTOR",
            "COORDINATOR",
            "PROCUREMENT",
            "MATCHING",
            "TRANSPORTER",
            "SURGEON"
        ];
        return names[roleId];
    }
}
