// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./PFEKeyIssuer.sol";
contract OrganRegistry is Ownable {
    struct Record { bytes32 anchor; uint8 entityType; bool active; address registeredBy; uint256 timestamp; }
    mapping(bytes32 => Record) public records;
    address public lifecycleManager;
    PFEKeyIssuer public immutable issuer;
    event RecordRegistered(bytes32 indexed id, bytes32 anchor, uint8 entityType, address registeredBy);
    event RecordDeactivated(bytes32 indexed id);
    constructor(address sessionIssuer) Ownable(msg.sender) { issuer = PFEKeyIssuer(sessionIssuer); }
    function setLifecycleManager(address manager) external onlyOwner {
        require(manager != address(0) && lifecycleManager == address(0), "Manager already set");
        lifecycleManager = manager;
    }
    function registerRecord(bytes32 id, bytes32 anchor, uint8 entityType) external {
        require(entityType < 2 && id != bytes32(0) && anchor != bytes32(0), "Invalid record");
        require(records[id].timestamp == 0, "Record exists");
        require(issuer.hasPermission(msg.sender, entityType == 0 ? 1 : 2), "Registration forbidden");
        records[id] = Record(anchor, entityType, true, msg.sender, block.timestamp);
        emit RecordRegistered(id, anchor, entityType, msg.sender);
    }
    function deactivate(bytes32 id) external {
        require(msg.sender == lifecycleManager, "Lifecycle only");
        require(records[id].active, "Record inactive or missing");
        records[id].active = false; emit RecordDeactivated(id);
    }
    function isActive(bytes32 id) external view returns (bool) { return records[id].active; }
}
