// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./OrganRegistry.sol";
contract LifecycleManager is Ownable {
    OrganRegistry public immutable registry;
    PFEKeyIssuer public immutable issuer;
    mapping(bytes32 => uint8) public status;
    struct Schedule { bytes32 id; uint256 due; bool executed; }
    Schedule[] public scheduled;
    uint256 public cursor;
    event RevocationRequested(bytes32 indexed id);
    event RevocationExecuted(bytes32 indexed id);
    event RevocationScheduled(bytes32 indexed id, uint256 due);
    constructor(address recordRegistry, address sessionIssuer) Ownable(msg.sender) {
        registry = OrganRegistry(recordRegistry); issuer = PFEKeyIssuer(sessionIssuer);
    }
    modifier canRevoke() { require(issuer.hasPermission(msg.sender, 3), "Revocation forbidden"); _; }
    function requestRevocation(bytes32 id) external canRevoke {
        require(registry.isActive(id) && status[id] == 0, "Not requestable");
        status[id] = 1; emit RevocationRequested(id);
    }
    function executeRevocation(bytes32 id) external canRevoke {
        require(status[id] == 1, "Not requested"); _execute(id);
    }
    function _execute(bytes32 id) internal {
        status[id] = 2; registry.deactivate(id); emit RevocationExecuted(id);
    }
    function scheduleAutoRevocation(bytes32 id, uint256 due) external onlyOwner {
        require(registry.isActive(id) && due >= block.timestamp, "Invalid schedule");
        scheduled.push(Schedule(id, due, false)); emit RevocationScheduled(id, due);
    }
    // Bounds inspected entries and revisits not-yet-due entries.
    function processScheduled(uint256 limit) external {
        require(limit > 0 && limit <= 50, "Limit 1..50");
        uint256 n = scheduled.length;
        if (n == 0) return;
        uint256 count = limit < n ? limit : n;
        for (uint256 i; i < count; i++) {
            Schedule storage s = scheduled[cursor]; cursor = (cursor + 1) % n;
            if (!s.executed && s.due <= block.timestamp) {
                s.executed = true;
                if (registry.isActive(s.id)) _execute(s.id);
            }
        }
    }
    function scheduledCount() external view returns (uint256) { return scheduled.length; }
}
