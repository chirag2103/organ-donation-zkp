// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IZKPVerifier.sol";

/**
 * @title MockZKPVerifier
 * @notice Test-only mock that returns a configurable boolean from verifyProof().
 *         Implements IZKPVerifier so it can be passed anywhere a real verifier
 *         is expected without importing the heavy Groth16Verifier contract.
 */
contract MockZKPVerifier is IZKPVerifier {
    bool private _shouldVerify;

    event VerificationResult(address indexed caller, bool verified, bytes32 roleHash);

    constructor(bool shouldVerify) {
        _shouldVerify = shouldVerify;
    }

    function verifyProof(
        uint256[2]    calldata, /* a */
        uint256[2][2] calldata, /* b */
        uint256[2]    calldata, /* c */
        uint256[4]    calldata input
    ) external override returns (bool) {
        return _shouldVerify;
    }

    function setShouldVerify(bool val) external {
        _shouldVerify = val;
    }
}
