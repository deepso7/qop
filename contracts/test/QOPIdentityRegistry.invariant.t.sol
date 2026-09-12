// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {QOPIdentityRegistry} from "../src/QOPIdentityRegistry.sol";

contract IdentityRegistryHandler is Test {
    QOPIdentityRegistry public immutable registry;
    uint256 public immutable registrationSignerKey;

    uint256 public successfulRegistrations;
    uint256 public successfulDeviceAdds;
    uint256 public successfulDeviceRemoves;
    uint256 public successfulDeviceWipes;
    uint256 public successfulRotations;

    uint256[] private _qids;
    mapping(uint256 qid => uint256 privateKey) private _ownerKeys;
    mapping(uint256 qid => uint256 nonce) public expectedNonces;
    mapping(uint256 qid => uint32 ownerVersion) public expectedOwnerVersions;

    constructor(QOPIdentityRegistry registry_, uint256 registrationSignerKey_) {
        registry = registry_;
        registrationSignerKey = registrationSignerKey_;
    }

    function register(uint256 ownerKeySeed) external {
        uint256 ownerKey = bound(ownerKeySeed, 1, SECP256K1_ORDER - 1);
        address owner = vm.addr(ownerKey);
        if (registry.qidByOwner(owner) != 0) return;

        string memory handle = _handle(successfulRegistrations);
        bytes32 registrationNonce = keccak256(abi.encode(successfulRegistrations, owner));
        QOPIdentityRegistry.RegisterIntent memory intent = QOPIdentityRegistry.RegisterIntent({
            handle: handle,
            owner: owner,
            deviceKey: keccak256(abi.encode("device", registrationNonce)),
            nonce: registrationNonce,
            deadline: type(uint64).max
        });
        bytes32 digest = registry.hashRegisterIntent(intent);

        uint256 qid = registry.register(intent, _sign(ownerKey, digest), _sign(registrationSignerKey, digest));
        _qids.push(qid);
        _ownerKeys[qid] = ownerKey;
        successfulRegistrations += 1;
    }

    function rotate(uint256 qidSeed, uint256 newOwnerKeySeed) external {
        if (_qids.length == 0) return;
        uint256 qid = _qids[qidSeed % _qids.length];
        uint256 newOwnerKey =
            bound(uint256(keccak256(abi.encode(newOwnerKeySeed, successfulRotations))), 1, SECP256K1_ORDER - 1);
        address newOwner = vm.addr(newOwnerKey);
        if (registry.qidByOwner(newOwner) != 0) return;

        QOPIdentityRegistry.RotateOwnerIntent memory intent = QOPIdentityRegistry.RotateOwnerIntent({
            qid: qid, newOwner: newOwner, nonce: expectedNonces[qid], deadline: type(uint64).max
        });
        bytes32 digest = registry.hashRotateOwnerIntent(intent);
        registry.rotateOwner(intent, _sign(_ownerKeys[qid], digest), _sign(newOwnerKey, digest));

        _ownerKeys[qid] = newOwnerKey;
        expectedNonces[qid] += 1;
        expectedOwnerVersions[qid] += 1;
        successfulRotations += 1;
    }

    function addDevice(uint256 qidSeed, bytes32 deviceKeySeed) external {
        if (_qids.length == 0) return;
        uint256 qid = _qids[qidSeed % _qids.length];
        if (registry.activeDeviceCount(qid) >= registry.MAX_ACTIVE_DEVICES()) return;
        bytes32 deviceKey = keccak256(abi.encode(qid, deviceKeySeed, successfulDeviceAdds));
        if (deviceKey == bytes32(0) || registry.qidByDeviceKey(deviceKey) != 0 || registry.deviceKeyRemoved(deviceKey)) {
            return;
        }

        QOPIdentityRegistry.AddDeviceIntent memory intent = QOPIdentityRegistry.AddDeviceIntent({
            qid: qid, deviceKey: deviceKey, nonce: expectedNonces[qid], deadline: type(uint64).max
        });
        registry.addDevice(intent, _sign(_ownerKeys[qid], registry.hashAddDeviceIntent(intent)));

        expectedNonces[qid] += 1;
        successfulDeviceAdds += 1;
    }

    function removeDevice(uint256 qidSeed, uint256 deviceIndexSeed) external {
        if (_qids.length == 0) return;
        uint256 qid = _qids[qidSeed % _qids.length];
        bytes32[] memory devices = registry.listActiveDevices(qid);
        if (devices.length == 0) return;
        bytes32 deviceKey = devices[deviceIndexSeed % devices.length];

        QOPIdentityRegistry.RemoveDeviceIntent memory intent = QOPIdentityRegistry.RemoveDeviceIntent({
            qid: qid, deviceKey: deviceKey, nonce: expectedNonces[qid], deadline: type(uint64).max
        });
        registry.removeDevice(intent, _sign(_ownerKeys[qid], registry.hashRemoveDeviceIntent(intent)));

        expectedNonces[qid] += 1;
        successfulDeviceRemoves += 1;
    }

    function wipeDevices(uint256 qidSeed) external {
        if (_qids.length == 0) return;
        uint256 qid = _qids[qidSeed % _qids.length];
        if (registry.activeDeviceCount(qid) == 0) return;

        QOPIdentityRegistry.WipeDevicesIntent memory intent =
            QOPIdentityRegistry.WipeDevicesIntent({qid: qid, nonce: expectedNonces[qid], deadline: type(uint64).max});
        registry.wipeDevices(intent, _sign(_ownerKeys[qid], registry.hashWipeDevicesIntent(intent)));

        expectedNonces[qid] += 1;
        successfulDeviceWipes += 1;
    }

    function qidAt(uint256 index) external view returns (uint256) {
        return _qids[index];
    }

    function qidsLength() external view returns (uint256) {
        return _qids.length;
    }

    function _handle(uint256 value) private pure returns (string memory) {
        bytes memory result = new bytes(13);
        result[0] = "q";
        for (uint256 index = 1; index < result.length; ++index) {
            result[index] = bytes1(uint8(0x61 + (value % 26)));
            value /= 26;
        }
        return string(result);
    }

    function _sign(uint256 privateKey, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v - 27);
    }
}

contract QOPIdentityRegistryInvariantTest is StdInvariant, Test {
    uint256 private constant REGISTRATION_SIGNER_KEY = 0xA11CE;

    QOPIdentityRegistry private registry;
    IdentityRegistryHandler private handler;

    function setUp() public {
        registry = new QOPIdentityRegistry(address(this), vm.addr(REGISTRATION_SIGNER_KEY));
        handler = new IdentityRegistryHandler(registry, REGISTRATION_SIGNER_KEY);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = IdentityRegistryHandler.register.selector;
        selectors[1] = IdentityRegistryHandler.rotate.selector;
        selectors[2] = IdentityRegistryHandler.addDevice.selector;
        selectors[3] = IdentityRegistryHandler.removeDevice.selector;
        selectors[4] = IdentityRegistryHandler.wipeDevices.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_qidsStaySequentialAndAccountStateStaysConsistent() public view {
        uint256 registrations = handler.successfulRegistrations();
        assertEq(registry.nextQid(), registrations + 1);
        assertEq(handler.qidsLength(), registrations);

        uint256 totalAccountActions;
        for (uint256 index; index < registrations; ++index) {
            uint256 qid = handler.qidAt(index);
            QOPIdentityRegistry.Account memory stored = registry.account(qid);

            assertEq(qid, index + 1);
            assertTrue(stored.owner != address(0));
            assertEq(registry.qidByOwner(stored.owner), qid);
            assertEq(registry.qidByHandleHash(keccak256(bytes(stored.handle))), qid);
            assertEq(stored.nonce, handler.expectedNonces(qid));
            assertEq(stored.ownerVersion, handler.expectedOwnerVersions(qid));
            assertTrue(registry.activeDeviceCount(qid) <= registry.MAX_ACTIVE_DEVICES());

            bytes32[] memory devices = registry.listActiveDevices(qid);
            for (uint256 deviceIndex; deviceIndex < devices.length; ++deviceIndex) {
                bytes32 deviceKey = devices[deviceIndex];
                assertTrue(deviceKey != bytes32(0));
                assertEq(registry.qidByDeviceKey(deviceKey), qid);
                assertTrue(registry.isActiveDevice(qid, deviceKey));
                assertFalse(registry.deviceKeyRemoved(deviceKey));
            }
            totalAccountActions += stored.nonce;
        }

        assertEq(
            totalAccountActions,
            handler.successfulRotations() + handler.successfulDeviceAdds() + handler.successfulDeviceRemoves()
                + handler.successfulDeviceWipes()
        );
    }
}
