// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./IZKPVerifier.sol";
import "./Groth16Verifier.sol";
contract ZKPVerifier is IZKPVerifier {
    Groth16Verifier public immutable innerVerifier;
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    constructor(address inner) { require(inner.code.length > 0, "Verifier missing"); innerVerifier = Groth16Verifier(inner); }
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b,
        uint256[2] calldata c, uint256[7] calldata s) external view returns (bool) {
        for (uint256 i; i < 7; i++) require(s[i] < FIELD, "Input outside field");
        return innerVerifier.verifyProof(a,b,c,s);
    }
}
