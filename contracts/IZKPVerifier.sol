// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IZKPVerifier
 * @notice Interface for Groth16 ZKP verifier contracts.
 *         Implemented by both the real snarkjs-generated Groth16Verifier
 *         and MockZKPVerifier used in unit tests.
 *
 * Public inputs layout for roleProof circuit (4 signals):
 *   pubSignals[0] = merkleRoot
 *   pubSignals[1] = roleId
 *   pubSignals[2] = nullifier
 *   pubSignals[3] = commitment
 */
interface IZKPVerifier {
    function verifyProof(
        uint256[2]    calldata a,
        uint256[2][2] calldata b,
        uint256[2]    calldata c,
        uint256[4]    calldata pubSignals
    ) external returns (bool);
}
