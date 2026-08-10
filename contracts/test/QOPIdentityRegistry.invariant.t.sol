// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {QOPIdentityRegistry} from "../src/QOPIdentityRegistry.sol";

contract IdentityRegistryHandler is Test {
    QOPIdentityRegistry public immutable registry;
    uint256 public immutable registrationSignerKey;

    uint256 public successfulRegistrations;
    uint256 public successfulRevocations;
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
            deviceCommitment: keccak256(abi.encode("device", registrationNonce)),
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

    function revoke(uint256 qidSeed, bytes32 digestSeed) external {
        if (_qids.length == 0) return;
        uint256 qid = _qids[qidSeed % _qids.length];
        bytes32 certificateDigest = keccak256(abi.encode(qid, digestSeed, successfulRevocations));

        QOPIdentityRegistry.RevokeDeviceIntent memory intent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: qid, certificateDigest: certificateDigest, nonce: expectedNonces[qid], deadline: type(uint64).max
        });
        registry.revokeDevice(intent, _sign(_ownerKeys[qid], registry.hashRevokeDeviceIntent(intent)));

        expectedNonces[qid] += 1;
        successfulRevocations += 1;
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

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = IdentityRegistryHandler.register.selector;
        selectors[1] = IdentityRegistryHandler.rotate.selector;
        selectors[2] = IdentityRegistryHandler.revoke.selector;
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
            totalAccountActions += stored.nonce;
        }

        assertEq(totalAccountActions, handler.successfulRotations() + handler.successfulRevocations());
    }
}
