// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./IZKPVerifier.sol";
/// Test-only. Never selected by deployment script.
contract MockZKPVerifier is IZKPVerifier {
    bool public accepted;
    constructor(bool value) { accepted = value; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata,
        uint256[2] calldata, uint256[7] calldata) external view returns (bool) { return accepted; }
}
