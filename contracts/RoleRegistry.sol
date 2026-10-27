// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
/// Institution-approved public membership commitments, never credentials.
contract RoleRegistry is Ownable {
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    mapping(uint8 => uint256) public roots;
    mapping(uint8 => uint256) public versions;
    event CredentialRootUpdated(uint8 indexed roleId, uint256 root, uint256 version);
    constructor() Ownable(msg.sender) {}
    function registerCredentialRoot(uint8 roleId, uint256 root) external onlyOwner {
        require(roleId < 6 && root > 0 && root < FIELD, "Invalid membership root");
        require(root != roots[roleId], "Unchanged root");
        roots[roleId] = root; versions[roleId]++;
        emit CredentialRootUpdated(roleId, root, versions[roleId]);
    }
    // bit0 match, bit1 register donor, bit2 register recipient, bit3 revoke.
    function getPermissions(uint8 roleId) public pure returns (uint256) {
        require(roleId < 6, "Invalid role");
        uint256[6] memory masks = [uint256(7), 7, 3, 1, 0, 9];
        return masks[roleId];
    }
}
