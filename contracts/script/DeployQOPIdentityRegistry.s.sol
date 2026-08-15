// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

import {QOPIdentityRegistry} from "../src/QOPIdentityRegistry.sol";

contract DeployQOPIdentityRegistry is Script {
    function run() external returns (QOPIdentityRegistry registry) {
        address registrationAdmin = vm.envAddress("REGISTRATION_ADMIN");
        address registrationSigner = vm.envAddress("REGISTRATION_SIGNER");

        vm.startBroadcast();
        registry = new QOPIdentityRegistry(registrationAdmin, registrationSigner);
        vm.stopBroadcast();
    }
}
