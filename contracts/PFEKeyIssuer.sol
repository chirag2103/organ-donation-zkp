// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IZKPVerifier.sol";
import "./RoleRegistry.sol";

/**
 * @title PFEKeyIssuer
 * @notice Issues role-scoped PFE functional key commitments after verifying
 *         a Groth16 ZKP role proof. Keys are valid for 4 hours.
 *
 * Flow:
 *  1. Caller submits ZKP proof + public inputs to verifyAndIssueKey()
 *  2. ZKPVerifier.verifyProof() is called; reverts on failure
 *  3. Nullifier is checked for replay attacks
 *  4. Key commitment = keccak256(caller, roleId, timestamp, permissions)
 *  5. KeyIssued event is emitted; userKeys mapping updated
 */
contract PFEKeyIssuer {

    // ── Dependencies ──────────────────────────────────────────────────────
    IZKPVerifier  public immutable zkpVerifier;
    RoleRegistry  public immutable roleRegistry;

    // ── Constants ─────────────────────────────────────────────────────────
    uint256 public constant KEY_TTL = 4 hours;

    // ── Data structures ───────────────────────────────────────────────────
    struct IssuedKey {
        bytes32  commitment;
        uint8    roleId;
        uint256  expiresAt;
        uint256  permissions;
        bool     active;
    }

    // ── Storage ───────────────────────────────────────────────────────────
    mapping(address  => IssuedKey) public userKeys;
    mapping(bytes32  => bool)      public usedNullifiers; // Replay protection

    // ── Events ────────────────────────────────────────────────────────────
    event KeyIssued(
        address indexed recipient,
        uint8           roleId,
        bytes32         keyCommitment,
        uint256         expiresAt
    );

    event KeyRevoked(address indexed user, bytes32 commitment);

    // ── Custom errors ─────────────────────────────────────────────────────
    error ZKPVerificationFailed();
    error NullifierAlreadyUsed(bytes32 nullifier);
    error KeyNotExpiredYet();

    // ── Constructor ───────────────────────────────────────────────────────
    constructor(address _zkpVerifier, address _roleRegistry) {
        require(_zkpVerifier != address(0), "PFEKeyIssuer: zero zkp address");
        require(_roleRegistry != address(0), "PFEKeyIssuer: zero registry address");
        zkpVerifier  = IZKPVerifier(_zkpVerifier);
        roleRegistry = RoleRegistry(_roleRegistry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core: Verify ZKP and issue PFE key commitment
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Verifies the Groth16 proof and issues a scoped PFE key commitment.
     * @param roleId      Claimed role (0–5); must match publicInputs[1].
     * @param a           Proof element A (G1 point).
     * @param b           Proof element B (G2 point).
     * @param c           Proof element C (G1 point).
     * @param pubInputs   Public inputs: [merkleRoot, roleId, nullifier, commitment]
     *
     * @dev publicInputs layout (matches circom main output order):
     *   pubInputs[0] = merkleRoot  — must match RoleRegistry.getRoleRoot(roleId)
     *   pubInputs[1] = roleId      — must equal the roleId parameter
     *   pubInputs[2] = nullifier   — Poseidon(credential, salt); replay guard
     *   pubInputs[3] = commitment  — Poseidon(credential, roleId)
     */
    function verifyAndIssueKey(
        uint8             roleId,
        uint256[2]   memory a,
        uint256[2][2] memory b,
        uint256[2]   memory c,
        uint256[4]   memory pubInputs
    ) external {
        // 1. Validate roleId consistency
        require(uint256(roleId) == pubInputs[1], "PFEKeyIssuer: roleId mismatch");

        // 2. Validate merkleRoot matches registry
        bytes32 registryRoot = roleRegistry.getRoleRoot(roleId);
        require(
            bytes32(pubInputs[0]) == registryRoot,
            "PFEKeyIssuer: merkle root mismatch"
        );

        // 3. Check nullifier for replay attack
        bytes32 nullifier = bytes32(pubInputs[2]);
        if (usedNullifiers[nullifier]) revert NullifierAlreadyUsed(nullifier);

        // 4. Verify the Groth16 proof
        bool valid = zkpVerifier.verifyProof(a, b, c, pubInputs);
        if (!valid) revert ZKPVerificationFailed();

        // 5. Mark nullifier as used
        usedNullifiers[nullifier] = true;

        // 6. Fetch role permissions
        uint256 permissions = roleRegistry.getPermissions(roleId);

        // 7. Derive key commitment (deterministic, bound to caller + role + time)
        bytes32 commitment = keccak256(
            abi.encodePacked(msg.sender, roleId, block.timestamp, permissions)
        );

        // 8. Record key
        uint256 expiresAt = block.timestamp + KEY_TTL;
        userKeys[msg.sender] = IssuedKey({
            commitment:  commitment,
            roleId:      roleId,
            expiresAt:   expiresAt,
            permissions: permissions,
            active:      true
        });

        emit KeyIssued(msg.sender, roleId, commitment, expiresAt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns whether a user currently holds a valid (non-expired) key.
     * @return valid      True if key exists and has not expired.
     * @return roleId     The role bound to the key (0 if invalid).
     * @return expiresAt  Unix timestamp of expiry (0 if invalid).
     */
    function isKeyValid(address user)
        external
        view
        returns (bool valid, uint8 roleId, uint256 expiresAt)
    {
        IssuedKey storage k = userKeys[user];
        if (!k.active || block.timestamp >= k.expiresAt) {
            return (false, 0, 0);
        }
        return (true, k.roleId, k.expiresAt);
    }

    /**
     * @notice Returns the full key struct for a user (for off-chain query).
     */
    function getKey(address user)
        external
        view
        returns (IssuedKey memory)
    {
        return userKeys[user];
    }

    /**
     * @notice Checks if a user's key has a specific permission bit set.
     */
    function hasPermission(address user, uint8 permBit)
        external
        view
        returns (bool)
    {
        IssuedKey storage k = userKeys[user];
        if (!k.active || block.timestamp >= k.expiresAt) return false;
        return (k.permissions & (1 << permBit)) != 0;
    }
}
