// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {QOPIdentityRegistry} from "../src/QOPIdentityRegistry.sol";

contract QOPIdentityRegistryTest is Test {
    uint256 private constant REGISTRATION_SIGNER_KEY = 0xA11CE;
    address private constant REGISTRATION_ADMIN = address(0xAD01);
    uint256 private constant OWNER_KEY = 0xB0B;
    uint256 private constant SECOND_OWNER_KEY = 0xCAFE;
    uint256 private constant SECOND_REGISTRATION_SIGNER_KEY = 0xD00D;
    address private constant RELAYER = address(0xBEEF);

    QOPIdentityRegistry private registry;
    address private registrationSigner;
    address private owner;
    uint64 private deadline;

    function setUp() public {
        vm.warp(1_700_000_000);
        registrationSigner = vm.addr(REGISTRATION_SIGNER_KEY);
        owner = vm.addr(OWNER_KEY);
        deadline = uint64(block.timestamp + 1 days);
        registry = new QOPIdentityRegistry(REGISTRATION_ADMIN, registrationSigner);
    }

    function test_registersThroughAnArbitraryRelayer() public {
        bytes32 registrationNonce = keccak256("registration-1");
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, registrationNonce);
        (bytes memory ownerSignature, bytes memory registrationSignature) = _registrationSignatures(intent, OWNER_KEY);

        vm.prank(RELAYER);
        uint256 qid = registry.register(intent, ownerSignature, registrationSignature);

        assertEq(qid, 1);
        assertEq(registry.nextQid(), 2);
        assertEq(registry.qidByOwner(owner), qid);
        assertEq(registry.qidByHandleHash(keccak256("alice")), qid);
        assertTrue(registry.registrationNonceUsed(registrationNonce));

        QOPIdentityRegistry.Account memory stored = registry.account(qid);
        assertEq(stored.owner, owner);
        assertEq(stored.ownerVersion, 0);
        assertEq(stored.registeredAt, block.timestamp);
        assertEq(stored.nonce, 0);
        assertEq(stored.handle, "alice");
        bytes32 deviceKey = keccak256(abi.encode("device", registrationNonce));
        assertEq(registry.qidByDeviceKey(deviceKey), qid);
        assertEq(registry.activeDeviceCount(qid), 1);
        assertTrue(registry.isActiveDevice(qid, deviceKey));
        bytes32[] memory devices = registry.listActiveDevices(qid);
        assertEq(devices.length, 1);
        assertEq(devices[0], deviceKey);
    }

    function test_deviceKeyOwnershipIsUniqueAndReleasedOnRemove() public {
        uint256 alice = _register("alice", OWNER_KEY, keccak256("alice"));
        bytes32 oldKey = registry.listActiveDevices(alice)[0];
        assertEq(registry.qidByDeviceKey(oldKey), alice);
        QOPIdentityRegistry.RegisterIntent memory bobIntent =
            _registerIntent("bob", vm.addr(SECOND_OWNER_KEY), keccak256("bob"));
        bobIntent.deviceKey = oldKey;
        (bytes memory bobSignature, bytes memory registrationSignature) =
            _registrationSignatures(bobIntent, SECOND_OWNER_KEY);
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.DeviceKeyAlreadyRegistered.selector, oldKey, alice));
        registry.register(bobIntent, bobSignature, registrationSignature);

        bytes32 newKey = keccak256("new-device");
        QOPIdentityRegistry.AddDeviceIntent memory addIntent =
            QOPIdentityRegistry.AddDeviceIntent({qid: alice, deviceKey: newKey, nonce: 0, deadline: deadline});
        registry.addDevice(addIntent, _sign(OWNER_KEY, registry.hashAddDeviceIntent(addIntent)));
        assertEq(registry.activeDeviceCount(alice), 2);

        QOPIdentityRegistry.RemoveDeviceIntent memory removeIntent =
            QOPIdentityRegistry.RemoveDeviceIntent({qid: alice, deviceKey: oldKey, nonce: 1, deadline: deadline});
        registry.removeDevice(removeIntent, _sign(OWNER_KEY, registry.hashRemoveDeviceIntent(removeIntent)));
        assertEq(registry.qidByDeviceKey(oldKey), 0);
        assertTrue(registry.deviceKeyRemoved(oldKey));
        assertEq(registry.qidByDeviceKey(newKey), alice);
        assertTrue(registry.isActiveDevice(alice, newKey));
        assertFalse(registry.isActiveDevice(alice, oldKey));

        // Removed keys cannot be reused by anyone, including Alice.
        bobIntent.deviceKey = oldKey;
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.DeviceKeyRemoved.selector, oldKey));
        registry.register(bobIntent, bobSignature, registrationSignature);

        QOPIdentityRegistry.AddDeviceIntent memory readd =
            QOPIdentityRegistry.AddDeviceIntent({qid: alice, deviceKey: oldKey, nonce: 2, deadline: deadline});
        bytes memory readdSignature = _sign(OWNER_KEY, registry.hashAddDeviceIntent(readd));
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.DeviceKeyRemoved.selector, oldKey));
        registry.addDevice(readd, readdSignature);
    }

    function test_addsAndRemovesDevicesConcurrentlyUnderCap() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 first = registry.listActiveDevices(qid)[0];

        bytes32 second = keccak256("device-2");
        bytes32 third = keccak256("device-3");
        bytes32 fourth = keccak256("device-4");
        bytes32 fifth = keccak256("device-5");

        _addDevice(qid, OWNER_KEY, second, 0);
        _addDevice(qid, OWNER_KEY, third, 1);
        _addDevice(qid, OWNER_KEY, fourth, 2);
        assertEq(registry.activeDeviceCount(qid), 4);

        QOPIdentityRegistry.AddDeviceIntent memory overCap =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: fifth, nonce: 3, deadline: deadline});
        bytes memory overCapSignature = _sign(OWNER_KEY, registry.hashAddDeviceIntent(overCap));
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.MaxDevicesReached.selector, qid, 4));
        registry.addDevice(overCap, overCapSignature);

        QOPIdentityRegistry.RemoveDeviceIntent memory removeSecond =
            QOPIdentityRegistry.RemoveDeviceIntent({qid: qid, deviceKey: second, nonce: 3, deadline: deadline});
        registry.removeDevice(removeSecond, _sign(OWNER_KEY, registry.hashRemoveDeviceIntent(removeSecond)));
        assertEq(registry.activeDeviceCount(qid), 3);
        assertTrue(registry.isActiveDevice(qid, first));
        assertTrue(registry.isActiveDevice(qid, third));
        assertTrue(registry.isActiveDevice(qid, fourth));
        assertFalse(registry.isActiveDevice(qid, second));

        _addDevice(qid, OWNER_KEY, fifth, 4);
        assertEq(registry.activeDeviceCount(qid), 4);
        assertTrue(registry.isActiveDevice(qid, fifth));
    }

    function test_allowsZeroActiveDevicesAfterRemove() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 only = registry.listActiveDevices(qid)[0];
        QOPIdentityRegistry.RemoveDeviceIntent memory removeIntent =
            QOPIdentityRegistry.RemoveDeviceIntent({qid: qid, deviceKey: only, nonce: 0, deadline: deadline});
        registry.removeDevice(removeIntent, _sign(OWNER_KEY, registry.hashRemoveDeviceIntent(removeIntent)));
        assertEq(registry.activeDeviceCount(qid), 0);
        assertEq(registry.account(qid).handle, "alice");
        assertEq(registry.qidByOwner(owner), qid);
    }

    function test_wipeDevicesClearsEveryActiveKey() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 first = registry.listActiveDevices(qid)[0];
        bytes32 second = keccak256("cli-device");
        _addDevice(qid, OWNER_KEY, second, 0);

        QOPIdentityRegistry.WipeDevicesIntent memory wipe =
            QOPIdentityRegistry.WipeDevicesIntent({qid: qid, nonce: 1, deadline: deadline});
        vm.expectEmit(true, false, false, true, address(registry));
        emit QOPIdentityRegistry.DevicesWiped(qid, 2, 1);
        registry.wipeDevices(wipe, _sign(OWNER_KEY, registry.hashWipeDevicesIntent(wipe)));

        assertEq(registry.activeDeviceCount(qid), 0);
        assertEq(registry.qidByDeviceKey(first), 0);
        assertEq(registry.qidByDeviceKey(second), 0);
        assertTrue(registry.deviceKeyRemoved(first));
        assertTrue(registry.deviceKeyRemoved(second));
        assertEq(registry.account(qid).nonce, 2);
        assertEq(registry.account(qid).owner, owner);
    }

    function test_recoverOwnerRotatesOwnerAndWipesDevices() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 first = registry.listActiveDevices(qid)[0];
        bytes32 second = keccak256("cli-device");
        _addDevice(qid, OWNER_KEY, second, 0);

        address newOwner = vm.addr(SECOND_OWNER_KEY);
        QOPIdentityRegistry.RecoverOwnerIntent memory intent = QOPIdentityRegistry.RecoverOwnerIntent({
            qid: qid, newOwner: newOwner, nonce: 1, deadline: deadline
        });
        bytes32 digest = registry.hashRecoverOwnerIntent(intent);

        vm.expectEmit(true, true, true, true, address(registry));
        emit QOPIdentityRegistry.OwnerRecovered(qid, owner, newOwner, 1, 2, 1);
        registry.recoverOwner(intent, _sign(OWNER_KEY, digest), _sign(SECOND_OWNER_KEY, digest));

        QOPIdentityRegistry.Account memory stored = registry.account(qid);
        assertEq(stored.owner, newOwner);
        assertEq(stored.ownerVersion, 1);
        assertEq(stored.nonce, 2);
        assertEq(registry.activeDeviceCount(qid), 0);
        assertEq(registry.qidByDeviceKey(first), 0);
        assertEq(registry.qidByDeviceKey(second), 0);
        assertTrue(registry.deviceKeyRemoved(first));
        assertTrue(registry.deviceKeyRemoved(second));
        assertEq(registry.qidByOwner(owner), 0);
        assertEq(registry.qidByOwner(newOwner), qid);

        // Compromised previous owner cannot add devices anymore.
        QOPIdentityRegistry.AddDeviceIntent memory addIntent = QOPIdentityRegistry.AddDeviceIntent({
            qid: qid, deviceKey: keccak256("attacker-device"), nonce: 2, deadline: deadline
        });
        bytes memory compromisedSig = _sign(OWNER_KEY, registry.hashAddDeviceIntent(addIntent));
        vm.expectRevert(
            abi.encodeWithSelector(
                QOPIdentityRegistry.InvalidOwnerSignature.selector, owner, newOwner
            )
        );
        registry.addDevice(addIntent, compromisedSig);

        // New owner can add a fresh device.
        _addDevice(qid, SECOND_OWNER_KEY, keccak256("recovery-phone"), 2);
        assertEq(registry.activeDeviceCount(qid), 1);
    }

    function test_recoverOwnerRequiresTheNewOwnerToProveControl() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        address newOwner = vm.addr(SECOND_OWNER_KEY);
        QOPIdentityRegistry.RecoverOwnerIntent memory intent = QOPIdentityRegistry.RecoverOwnerIntent({
            qid: qid, newOwner: newOwner, nonce: 0, deadline: deadline
        });
        bytes32 digest = registry.hashRecoverOwnerIntent(intent);

        vm.expectRevert(
            abi.encodeWithSelector(
                QOPIdentityRegistry.InvalidNewOwnerSignature.selector, vm.addr(REGISTRATION_SIGNER_KEY), newOwner
            )
        );
        registry.recoverOwner(intent, _sign(OWNER_KEY, digest), _sign(REGISTRATION_SIGNER_KEY, digest));

        QOPIdentityRegistry.Account memory stored = registry.account(qid);
        assertEq(stored.owner, owner);
        assertEq(stored.ownerVersion, 0);
        assertEq(stored.nonce, 0);
        assertEq(registry.activeDeviceCount(qid), 1);
    }

    function test_assignsSequentialQidsAndPermanentHandles() public {
        uint256 firstQid = _register("alice", OWNER_KEY, keccak256("first"));
        uint256 secondQid = _register("bob", SECOND_OWNER_KEY, keccak256("second"));

        assertEq(firstQid, 1);
        assertEq(secondQid, 2);

        QOPIdentityRegistry.RegisterIntent memory duplicate =
            _registerIntent("alice", vm.addr(0xD00D), keccak256("third"));
        (bytes memory ownerSignature, bytes memory registrationSignature) = _registrationSignatures(duplicate, 0xD00D);
        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.HandleAlreadyRegistered.selector, keccak256("alice"), firstQid)
        );
        registry.register(duplicate, ownerSignature, registrationSignature);
    }

    function test_registrationRejectsAnAlreadyRegisteredOwner() public {
        uint256 firstQid = _register("alice", OWNER_KEY, keccak256("first"));
        QOPIdentityRegistry.RegisterIntent memory duplicateOwner = _registerIntent("bob", owner, keccak256("second"));
        (bytes memory ownerSignature, bytes memory registrationSignature) =
            _registrationSignatures(duplicateOwner, OWNER_KEY);

        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.OwnerAlreadyRegistered.selector, owner, firstQid));
        registry.register(duplicateOwner, ownerSignature, registrationSignature);
    }

    function test_rejectsNonCanonicalHandles() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("", owner, keccak256("empty"));
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleLength.selector, 0));
        registry.register(intent, "", "");

        intent.handle = "Alice";
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleCharacter.selector, 0, bytes1("A")));
        registry.register(intent, "", "");

        intent.handle = "_alice";
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleCharacter.selector, 0, bytes1("_")));
        registry.register(intent, "", "");

        intent.handle = "alice-bob";
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleCharacter.selector, 5, bytes1("-")));
        registry.register(intent, "", "");

        intent.handle = "abcdefghijklmnopqrstuvwxyzabcdefg";
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleLength.selector, 33));
        registry.register(intent, "", "");
    }

    function test_requiresBothSignaturesOverTheExactRegistrationIntent() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        (, bytes memory registrationSignature) = _registrationSignatures(intent, OWNER_KEY);
        bytes memory wrongOwnerSignature = _sign(SECOND_OWNER_KEY, registry.hashRegisterIntent(intent));

        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.InvalidOwnerSignature.selector, vm.addr(SECOND_OWNER_KEY), owner)
        );
        registry.register(intent, wrongOwnerSignature, registrationSignature);

        bytes memory ownerSignature = _sign(OWNER_KEY, registry.hashRegisterIntent(intent));
        bytes memory wrongRegistrationSignature = _sign(SECOND_OWNER_KEY, registry.hashRegisterIntent(intent));
        vm.expectRevert(
            abi.encodeWithSelector(
                QOPIdentityRegistry.InvalidRegistrationSignature.selector, vm.addr(SECOND_OWNER_KEY), registrationSigner
            )
        );
        registry.register(intent, ownerSignature, wrongRegistrationSignature);

        QOPIdentityRegistry.RegisterIntent memory altered = intent;
        altered.deviceKey = keccak256("another-device");
        vm.expectRevert();
        registry.register(altered, ownerSignature, registrationSignature);
    }

    function test_rejectsAnEmptyDeviceKey() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        intent.deviceKey = bytes32(0);
        vm.expectRevert(QOPIdentityRegistry.EmptyDeviceKey.selector);
        registry.register(intent, "", "");
    }

    function test_registrationSignerCanRotateBeforeOpening() public {
        address nextSigner = vm.addr(SECOND_REGISTRATION_SIGNER_KEY);
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.UnauthorizedRegistrationAdmin.selector, RELAYER));
        vm.prank(RELAYER);
        registry.setRegistrationSigner(nextSigner);

        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.UnauthorizedRegistrationAdmin.selector, registrationSigner)
        );
        vm.prank(registrationSigner);
        registry.setRegistrationSigner(nextSigner);

        vm.prank(REGISTRATION_ADMIN);
        registry.setRegistrationSigner(nextSigner);
        assertEq(registry.registrationSigner(), nextSigner);

        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        bytes32 digest = registry.hashRegisterIntent(intent);
        registry.register(intent, _sign(OWNER_KEY, digest), _sign(SECOND_REGISTRATION_SIGNER_KEY, digest));
        assertEq(registry.qidByOwner(owner), 1);
    }

    function test_registrationCanOpenIrreversibly() public {
        vm.prank(REGISTRATION_ADMIN);
        registry.openRegistration();
        assertTrue(registry.registrationOpen());
        assertEq(registry.registrationSigner(), address(0));

        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        registry.register(intent, _sign(OWNER_KEY, registry.hashRegisterIntent(intent)), "");
        assertEq(registry.qidByOwner(owner), 1);

        vm.expectRevert(QOPIdentityRegistry.RegistrationAlreadyOpen.selector);
        registry.openRegistration();
        vm.expectRevert(QOPIdentityRegistry.RegistrationAlreadyOpen.selector);
        registry.setRegistrationSigner(vm.addr(SECOND_REGISTRATION_SIGNER_KEY));
    }

    function test_acceptsWireYParityAndWalletV() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        bytes32 digest = registry.hashRegisterIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes memory walletSignature = abi.encodePacked(r, s, v);
        bytes memory registrationSignature = _sign(REGISTRATION_SIGNER_KEY, digest);

        registry.register(intent, walletSignature, registrationSignature);
        assertEq(registry.qidByOwner(owner), 1);
    }

    function test_rejectsInvalidSignatureV() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        bytes32 digest = registry.hashRegisterIntent(intent);
        (, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes memory invalidSignature = abi.encodePacked(r, s, uint8(2));

        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidYParity.selector, 2));
        registry.register(intent, invalidSignature, _sign(REGISTRATION_SIGNER_KEY, digest));
    }

    function test_registrationIntentExpiresAndNonceIsSingleUse() public {
        bytes32 registrationNonce = keccak256("registration");
        QOPIdentityRegistry.RegisterIntent memory expired = QOPIdentityRegistry.RegisterIntent({
            handle: "alice",
            owner: owner,
            deviceKey: keccak256("device"),
            nonce: registrationNonce,
            deadline: uint64(block.timestamp - 1)
        });
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.ExpiredIntent.selector, expired.deadline));
        registry.register(expired, "", "");

        _register("alice", OWNER_KEY, registrationNonce);
        QOPIdentityRegistry.RegisterIntent memory replay =
            _registerIntent("bob", vm.addr(SECOND_OWNER_KEY), registrationNonce);
        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.RegistrationNonceAlreadyUsed.selector, registrationNonce)
        );
        registry.register(replay, "", "");
    }

    function test_rejectsAZeroRegistrationNonce() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, bytes32(0));
        vm.expectRevert(QOPIdentityRegistry.ZeroRegistrationNonce.selector);
        registry.register(intent, "", "");
    }

    function test_addDeviceConsumesTheAccountNonce() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 newDeviceKey = keccak256("new-device");
        QOPIdentityRegistry.AddDeviceIntent memory intent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: newDeviceKey, nonce: 0, deadline: deadline});

        vm.prank(RELAYER);
        vm.expectEmit(true, true, false, true, address(registry));
        emit QOPIdentityRegistry.DeviceAdded(qid, newDeviceKey, 0);
        registry.addDevice(intent, _sign(OWNER_KEY, registry.hashAddDeviceIntent(intent)));

        assertTrue(registry.isActiveDevice(qid, newDeviceKey));
        assertEq(registry.account(qid).nonce, 1);
    }

    function test_addDeviceRejectsAZeroKey() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        QOPIdentityRegistry.AddDeviceIntent memory intent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: bytes32(0), nonce: 0, deadline: deadline});
        vm.expectRevert(QOPIdentityRegistry.EmptyDeviceKey.selector);
        registry.addDevice(intent, "");
    }

    function test_addDeviceRejectsAnAlreadyActiveKey() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 deviceKey = registry.listActiveDevices(qid)[0];
        QOPIdentityRegistry.AddDeviceIntent memory intent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: deviceKey, nonce: 0, deadline: deadline});
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.DeviceAlreadyActive.selector, qid, deviceKey));
        registry.addDevice(intent, "");
    }

    function test_addDeviceRequiresTheCurrentOwnerSignature() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        QOPIdentityRegistry.AddDeviceIntent memory intent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: keccak256("new-device"), nonce: 0, deadline: deadline});
        bytes32 digest = registry.hashAddDeviceIntent(intent);
        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.InvalidOwnerSignature.selector, vm.addr(SECOND_OWNER_KEY), owner)
        );
        registry.addDevice(intent, _sign(SECOND_OWNER_KEY, digest));
    }

    function test_removeDeviceRejectsInactiveKey() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 missing = keccak256("missing");
        QOPIdentityRegistry.RemoveDeviceIntent memory intent =
            QOPIdentityRegistry.RemoveDeviceIntent({qid: qid, deviceKey: missing, nonce: 0, deadline: deadline});
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.DeviceNotActive.selector, qid, missing));
        registry.removeDevice(intent, "");
    }

    function test_removeDeviceRejectsANonceConflict() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 deviceKey = registry.listActiveDevices(qid)[0];
        QOPIdentityRegistry.RemoveDeviceIntent memory intent =
            QOPIdentityRegistry.RemoveDeviceIntent({qid: qid, deviceKey: deviceKey, nonce: 1, deadline: deadline});
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.NonceConflict.selector, 0, 1));
        registry.removeDevice(intent, "");
    }

    function test_removeDeviceRejectsAnExpiredDeadline() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 deviceKey = registry.listActiveDevices(qid)[0];
        QOPIdentityRegistry.RemoveDeviceIntent memory intent = QOPIdentityRegistry.RemoveDeviceIntent({
            qid: qid, deviceKey: deviceKey, nonce: 0, deadline: uint64(block.timestamp - 1)
        });
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.ExpiredIntent.selector, intent.deadline));
        registry.removeDevice(intent, "");
    }

    function test_rotatesOwnerWithoutChangingDevices() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 deviceKey = registry.listActiveDevices(qid)[0];
        address newOwner = vm.addr(SECOND_OWNER_KEY);
        QOPIdentityRegistry.RotateOwnerIntent memory intent =
            QOPIdentityRegistry.RotateOwnerIntent({qid: qid, newOwner: newOwner, nonce: 0, deadline: deadline});
        bytes32 digest = registry.hashRotateOwnerIntent(intent);

        vm.prank(RELAYER);
        registry.rotateOwner(intent, _sign(OWNER_KEY, digest), _sign(SECOND_OWNER_KEY, digest));

        QOPIdentityRegistry.Account memory stored = registry.account(qid);
        assertEq(stored.owner, newOwner);
        assertEq(stored.ownerVersion, 1);
        assertEq(stored.nonce, 1);
        assertEq(stored.handle, "alice");
        assertEq(registry.qidByOwner(owner), 0);
        assertEq(registry.qidByOwner(newOwner), qid);
        assertTrue(registry.isActiveDevice(qid, deviceKey));
        assertEq(registry.qidByDeviceKey(deviceKey), qid);
    }

    function test_rotationRequiresTheNewOwnerToProveControl() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        address newOwner = vm.addr(SECOND_OWNER_KEY);
        QOPIdentityRegistry.RotateOwnerIntent memory intent =
            QOPIdentityRegistry.RotateOwnerIntent({qid: qid, newOwner: newOwner, nonce: 0, deadline: deadline});
        bytes32 digest = registry.hashRotateOwnerIntent(intent);

        vm.expectRevert(
            abi.encodeWithSelector(
                QOPIdentityRegistry.InvalidNewOwnerSignature.selector, vm.addr(REGISTRATION_SIGNER_KEY), newOwner
            )
        );
        registry.rotateOwner(intent, _sign(OWNER_KEY, digest), _sign(REGISTRATION_SIGNER_KEY, digest));

        QOPIdentityRegistry.Account memory stored = registry.account(qid);
        assertEq(stored.owner, owner);
        assertEq(stored.ownerVersion, 0);
        assertEq(stored.nonce, 0);
    }

    function test_rotationRejectsTheCurrentOrAnotherRegisteredOwner() public {
        uint256 firstQid = _register("alice", OWNER_KEY, keccak256("first"));
        uint256 secondQid = _register("bob", SECOND_OWNER_KEY, keccak256("second"));

        QOPIdentityRegistry.RotateOwnerIntent memory selfRotation =
            QOPIdentityRegistry.RotateOwnerIntent({qid: firstQid, newOwner: owner, nonce: 0, deadline: deadline});
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.OwnerAlreadyRegistered.selector, owner, firstQid));
        registry.rotateOwner(selfRotation, "", "");

        address secondOwner = vm.addr(SECOND_OWNER_KEY);
        QOPIdentityRegistry.RotateOwnerIntent memory occupiedRotation =
            QOPIdentityRegistry.RotateOwnerIntent({qid: firstQid, newOwner: secondOwner, nonce: 0, deadline: deadline});
        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.OwnerAlreadyRegistered.selector, secondOwner, secondQid)
        );
        registry.rotateOwner(occupiedRotation, "", "");
    }

    function test_concurrentOwnerActionsRaceOnOneNonce() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        QOPIdentityRegistry.AddDeviceIntent memory deviceIntent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: keccak256("new-device"), nonce: 0, deadline: deadline});
        QOPIdentityRegistry.RotateOwnerIntent memory rotateIntent = QOPIdentityRegistry.RotateOwnerIntent({
            qid: qid, newOwner: vm.addr(SECOND_OWNER_KEY), nonce: 0, deadline: deadline
        });

        bytes memory deviceSignature = _sign(OWNER_KEY, registry.hashAddDeviceIntent(deviceIntent));
        bytes32 rotateDigest = registry.hashRotateOwnerIntent(rotateIntent);
        bytes memory rotateSignature = _sign(OWNER_KEY, rotateDigest);
        bytes memory newOwnerSignature = _sign(SECOND_OWNER_KEY, rotateDigest);

        registry.addDevice(deviceIntent, deviceSignature);
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.NonceConflict.selector, 1, 0));
        registry.rotateOwner(rotateIntent, rotateSignature, newOwnerSignature);
    }

    function test_registryIntentDigestsMatchTheTypescriptGoldenVectors() public {
        vm.chainId(11_155_111);
        address fixedRegistryAddress = address(0x1111111111111111111111111111111111111111);
        vm.etch(fixedRegistryAddress, address(registry).code);
        QOPIdentityRegistry fixedRegistry = QOPIdentityRegistry(fixedRegistryAddress);

        QOPIdentityRegistry.RegisterIntent memory registerIntent = QOPIdentityRegistry.RegisterIntent({
            handle: "alice",
            owner: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf,
            deviceKey: 0x0202020202020202020202020202020202020202020202020202020202020202,
            nonce: 0x0101010101010101010101010101010101010101010101010101010101010101,
            deadline: 1_700_003_600
        });
        QOPIdentityRegistry.RotateOwnerIntent memory rotateIntent = QOPIdentityRegistry.RotateOwnerIntent({
            qid: 42, newOwner: 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF, nonce: 7, deadline: 1_700_003_600
        });
        QOPIdentityRegistry.AddDeviceIntent memory addDeviceIntent = QOPIdentityRegistry.AddDeviceIntent({
            qid: 42,
            deviceKey: 0x0909090909090909090909090909090909090909090909090909090909090909,
            nonce: 9,
            deadline: 1_700_003_600
        });
        QOPIdentityRegistry.RemoveDeviceIntent memory removeDeviceIntent = QOPIdentityRegistry.RemoveDeviceIntent({
            qid: 42,
            deviceKey: 0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a,
            nonce: 11,
            deadline: 1_700_003_600
        });
        QOPIdentityRegistry.WipeDevicesIntent memory wipeDevicesIntent =
            QOPIdentityRegistry.WipeDevicesIntent({qid: 42, nonce: 13, deadline: 1_700_003_600});
        QOPIdentityRegistry.RecoverOwnerIntent memory recoverOwnerIntent = QOPIdentityRegistry.RecoverOwnerIntent({
            qid: 42, newOwner: 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF, nonce: 7, deadline: 1_700_003_600
        });

        assertEq(
            fixedRegistry.hashRegisterIntent(registerIntent),
            0x53dc6c862551e88c6021e67e163d162b1491a6a6b5e92a85196d2f9cea4aca9a
        );
        assertEq(
            fixedRegistry.hashRotateOwnerIntent(rotateIntent),
            0xcfd2c2208d584d29013cb01bbcd1f1ae5cef6c3546b82c682c52a66633e24c6c
        );
        assertEq(
            fixedRegistry.hashAddDeviceIntent(addDeviceIntent),
            0xc9a7d7b29736e26c6932c8047d84122012260032485952f2df658ccc3b251ca0
        );
        assertEq(
            fixedRegistry.hashRemoveDeviceIntent(removeDeviceIntent),
            0x93d4098944b4086859554efbee5bd6c129c7649ee03b3de63145372fb4717603
        );
        assertEq(
            fixedRegistry.hashWipeDevicesIntent(wipeDevicesIntent),
            0xd21c9fb8cf5859d38503d7428b8c9becf50a46245e1b68e65395c88cd4c98e7b
        );
        assertEq(
            fixedRegistry.hashRecoverOwnerIntent(recoverOwnerIntent),
            0x85177ecb06c719680cffda8b05c8c484a6c9bed3d0aa178aa8e1741170666b34
        );

        registerIntent = QOPIdentityRegistry.RegisterIntent({
            handle: "0xdeepso",
            owner: address(uint160(0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF)),
            deviceKey: bytes32(uint256(0x0303030303030303030303030303030303030303030303030303030303030303)),
            nonce: bytes32(uint256(0x0404040404040404040404040404040404040404040404040404040404040404)),
            deadline: 1_700_000_001
        });
        assertEq(
            fixedRegistry.hashRegisterIntent(registerIntent),
            0x5588faff7c3f5d0f7184f36937cca34a11f0d6293d76570d1d96831d3c9cb3ef
        );

        registerIntent = QOPIdentityRegistry.RegisterIntent({
            handle: "123kate",
            owner: address(uint160(0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69)),
            deviceKey: bytes32(uint256(0x0505050505050505050505050505050505050505050505050505050505050505)),
            nonce: bytes32(uint256(0x0606060606060606060606060606060606060606060606060606060606060606)),
            deadline: type(uint64).max
        });
        assertEq(
            fixedRegistry.hashRegisterIntent(registerIntent),
            0x8c73b10b7da9d84c1c0b382ecfe2b7a289b4b94b11e9c5fd792519f0966e92cb
        );

        registerIntent = QOPIdentityRegistry.RegisterIntent({
            handle: "a_b9",
            owner: address(uint160(0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718)),
            deviceKey: bytes32(uint256(0x0707070707070707070707070707070707070707070707070707070707070707)),
            nonce: bytes32(uint256(0x0808080808080808080808080808080808080808080808080808080808080808)),
            deadline: 42
        });
        assertEq(
            fixedRegistry.hashRegisterIntent(registerIntent),
            0x7bbdd775ad87bf649cc9245b381c601b893609d70606565253c8c5f9f4ae3ad8
        );
    }

    function test_allowsCryptoNativeHandles() public {
        uint256 qid = _register("0xdeepso", OWNER_KEY, keccak256("0xdeepso"));
        assertEq(registry.qidByHandleHash(keccak256("0xdeepso")), qid);
    }

    function testFuzz_validCanonicalHandlesRegister(string memory handle) public {
        bytes memory value = bytes(handle);
        vm.assume(value.length >= registry.MIN_HANDLE_LENGTH());
        vm.assume(value.length <= registry.MAX_HANDLE_LENGTH());
        for (uint256 index; index < value.length; ++index) {
            bool lowercaseLetter = value[index] >= 0x61 && value[index] <= 0x7a;
            bool digit = value[index] >= 0x30 && value[index] <= 0x39;
            bool underscore = index > 0 && value[index] == 0x5f;
            vm.assume(lowercaseLetter || digit || underscore);
        }

        _register(handle, OWNER_KEY, keccak256(abi.encode(handle)));
        assertEq(registry.qidByHandleHash(keccak256(bytes(handle))), 1);
    }

    function _register(string memory handle, uint256 ownerKey, bytes32 registrationNonce) private returns (uint256) {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent(handle, vm.addr(ownerKey), registrationNonce);
        (bytes memory ownerSignature, bytes memory registrationSignature) = _registrationSignatures(intent, ownerKey);
        return registry.register(intent, ownerSignature, registrationSignature);
    }

    function _addDevice(uint256 qid, uint256 ownerKey, bytes32 deviceKey, uint256 nonce) private {
        QOPIdentityRegistry.AddDeviceIntent memory intent =
            QOPIdentityRegistry.AddDeviceIntent({qid: qid, deviceKey: deviceKey, nonce: nonce, deadline: deadline});
        registry.addDevice(intent, _sign(ownerKey, registry.hashAddDeviceIntent(intent)));
    }

    function _registerIntent(string memory handle, address intentOwner, bytes32 registrationNonce)
        private
        view
        returns (QOPIdentityRegistry.RegisterIntent memory)
    {
        return QOPIdentityRegistry.RegisterIntent({
            handle: handle,
            owner: intentOwner,
            deviceKey: keccak256(abi.encode("device", registrationNonce)),
            nonce: registrationNonce,
            deadline: deadline
        });
    }

    function _registrationSignatures(QOPIdentityRegistry.RegisterIntent memory intent, uint256 ownerKey)
        private
        view
        returns (bytes memory, bytes memory)
    {
        bytes32 digest = registry.hashRegisterIntent(intent);
        return (_sign(ownerKey, digest), _sign(REGISTRATION_SIGNER_KEY, digest));
    }

    function _sign(uint256 privateKey, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v - 27);
    }
}
