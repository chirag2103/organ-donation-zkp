// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./RoleRegistry.sol";
import "./IZKPVerifier.sol";
/// Historical name retained: issues authorization sessions, never FE keys.
contract PFEKeyIssuer is Ownable {
    uint256 public constant KEY_TTL = 4 hours;
    RoleRegistry public immutable roleRegistry;
    IZKPVerifier public immutable zkpVerifier;
    struct Session { uint8 roleId; uint256 expiresAt; uint256 rootVersion; bool active; }
    mapping(address => Session) public sessions;
    mapping(uint256 => bool) public usedNullifiers;
    event SessionIssued(address indexed user, uint8 roleId, uint256 expiresAt, uint256 rootVersion);
    event SessionRevoked(address indexed user);
    constructor(address verifier, address registry) Ownable(msg.sender) {
        require(verifier != address(0) && registry != address(0), "Zero dependency");
        zkpVerifier = IZKPVerifier(verifier); roleRegistry = RoleRegistry(registry);
    }
    // [root, role, nullifier, recipient, chainId, issuer, rootVersion]
    function verifyAndIssueKey(uint8 roleId, uint256[2] calldata a, uint256[2][2] calldata b,
        uint256[2] calldata c, uint256[7] calldata s) external {
        require(roleId < 6 && s[1] == roleId, "Role mismatch");
        require(s[0] != 0 && s[0] == roleRegistry.roots(roleId), "Root mismatch");
        require(s[3] == uint256(uint160(msg.sender)), "Recipient mismatch");
        require(s[4] == block.chainid && s[5] == uint256(uint160(address(this))), "Domain mismatch");
        require(s[6] == roleRegistry.versions(roleId), "Version mismatch");
        require(!usedNullifiers[s[2]], "Nullifier used");
        require(zkpVerifier.verifyProof(a,b,c,s), "Invalid proof");
        usedNullifiers[s[2]] = true;
        sessions[msg.sender] = Session(roleId, block.timestamp + KEY_TTL, s[6], true);
        emit SessionIssued(msg.sender, roleId, block.timestamp + KEY_TTL, s[6]);
    }
    function isKeyValid(address user) public view returns (bool valid, uint8 roleId, uint256 expiresAt) {
        Session memory s = sessions[user];
        valid = s.active && block.timestamp < s.expiresAt && s.rootVersion == roleRegistry.versions(s.roleId);
        return (valid, s.roleId, s.expiresAt);
    }
    function hasPermission(address user, uint8 bit) external view returns (bool) {
        (bool valid, uint8 role,) = isKeyValid(user);
        return valid && (roleRegistry.getPermissions(role) & (uint256(1) << bit)) != 0;
    }
    function revokeSession(address user) external {
        require(msg.sender == owner() || msg.sender == user, "Not authorized");
        sessions[user].active = false; emit SessionRevoked(user);
    }
}
