// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockZKPVerifier
 * @notice Test-only mock that returns a configurable boolean from verifyProof().
 *         Used in unit tests to isolate PFEKeyIssuer and downstream contracts
 *         from Groth16 cryptographic operations.
 */
contract MockZKPVerifier {
    bool private _shouldVerify;

    event VerificationResult(address indexed caller, bool verified, bytes32 roleHash);

    constructor(bool shouldVerify) {
        _shouldVerify = shouldVerify;
    }

    function verifyProof(
        uint256[2]    memory, /* a */
        uint256[2][2] memory, /* b */
        uint256[2]    memory, /* c */
        uint256[4]    memory input
    ) external returns (bool) {
        bytes32 roleHash = keccak256(abi.encodePacked(input[0], input[1]));
        emit VerificationResult(msg.sender, _shouldVerify, roleHash);
        return _shouldVerify;
    }

    function setShouldVerify(bool val) external {
        _shouldVerify = val;
    }
}
