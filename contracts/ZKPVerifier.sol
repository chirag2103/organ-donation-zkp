// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IZKPVerifier.sol";

// Import the generated verifier — we call it via composition, not inheritance,
// to avoid needing to mark its functions `virtual`.
import "./Groth16Verifier.sol";

/**
 * @title ZKPVerifier
 * @notice Wraps the snarkjs-generated Groth16Verifier to add:
 *   1. BN128 scalar field range check on all public inputs
 *   2. VerificationResult event for off-chain auditability
 *   3. Implements IZKPVerifier for mock-compatible testing
 *
 * Public inputs layout (roleProof circuit):
 *   pubSignals[0] = merkleRoot
 *   pubSignals[1] = roleId
 *   pubSignals[2] = nullifier
 *   pubSignals[3] = commitment
 *
 * Deployment: deploy Groth16Verifier first, then pass its address here.
 * For convenience in tests, ZKPVerifier can also be deployed standalone
 * (it embeds a fresh Groth16Verifier at construction time).
 */
contract ZKPVerifier is IZKPVerifier {

    /// @dev BN128 scalar field prime — all public inputs must be < this.
    uint256 private constant PRIME_R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @dev The real Groth16 pairing verifier (immutable after construction).
    Groth16Verifier private immutable _inner;

    event VerificationResult(
        address indexed caller,
        bool            verified,
        bytes32         roleHash
    );

    /**
     * @param inner Address of the already-deployed Groth16Verifier.
     *              Pass address(0) to auto-deploy a fresh one.
     */
    constructor(address inner) {
        _inner = Groth16Verifier(
            inner == address(0) ? address(new Groth16Verifier()) : inner
        );
    }

    /**
     * @notice Verify a Groth16 proof for the roleProof circuit.
     * @dev    All 4 public signals must be in the BN128 scalar field.
     *         Delegates to the Groth16Verifier for the pairing check.
     */
    function verifyProof(
        uint256[2]    calldata a,
        uint256[2][2] calldata b,
        uint256[2]    calldata c,
        uint256[4]    calldata pubSignals
    ) external override returns (bool) {
        // Range-check all public inputs
        for (uint256 i = 0; i < 4; i++) {
            require(pubSignals[i] < PRIME_R, "ZKPVerifier: input out of field");
        }
        // Delegate pairing check to generated verifier
        bool valid = _inner.verifyProof(
            [a[0], a[1]],
            [[b[0][0], b[0][1]], [b[1][0], b[1][1]]],
            [c[0], c[1]],
            [pubSignals[0], pubSignals[1], pubSignals[2], pubSignals[3]]
        );
        bytes32 roleHash = keccak256(abi.encodePacked(pubSignals[0], pubSignals[1]));
        emit VerificationResult(msg.sender, valid, roleHash);
        return valid;
    }

    /// @notice Returns the address of the inner Groth16Verifier.
    function innerVerifier() external view returns (address) {
        return address(_inner);
    }
}
