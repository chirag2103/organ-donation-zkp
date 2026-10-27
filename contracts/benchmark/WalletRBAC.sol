// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/// @dev Isolated evaluation baseline, never deployed by the application deploy script.
contract WalletRBAC {
    address public immutable administrator = msg.sender;
    mapping(address=>bool) public approved;
    function enroll(address wallet) external {require(msg.sender==administrator);approved[wallet]=true;}
}
