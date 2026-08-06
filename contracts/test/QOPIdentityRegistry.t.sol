// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {QOPIdentityRegistry} from "../src/QOPIdentityRegistry.sol";

contract QOPIdentityRegistryTest is Test {
    uint256 private constant REGISTRATION_SIGNER_KEY = 0xA11CE;
    uint256 private constant OWNER_KEY = 0xB0B;
    uint256 private constant SECOND_OWNER_KEY = 0xCAFE;
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
        registry = new QOPIdentityRegistry(registrationSigner);
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
        // The literal is exactly one byte, so this bytes1 cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleCharacter.selector, 0, bytes1("A")));
        registry.register(intent, "", "");

        intent.handle = "alice1";
        // The literal is exactly one byte, so this bytes1 cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidHandleCharacter.selector, 5, bytes1("1")));
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
    }

    function test_requiresWireYParityInsteadOfWalletV() public {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent("alice", owner, keccak256("registration"));
        bytes32 digest = registry.hashRegisterIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        bytes memory walletSignature = abi.encodePacked(r, s, v);
        bytes memory registrationSignature = _sign(REGISTRATION_SIGNER_KEY, digest);

        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.InvalidYParity.selector, v));
        registry.register(intent, walletSignature, registrationSignature);
    }

    function test_registrationIntentExpiresAndNonceIsSingleUse() public {
        bytes32 registrationNonce = keccak256("registration");
        QOPIdentityRegistry.RegisterIntent memory expired = QOPIdentityRegistry.RegisterIntent({
            handle: "alice", owner: owner, nonce: registrationNonce, deadline: uint64(block.timestamp - 1)
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

    function test_revokesDeviceAndConsumesTheAccountNonce() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 certificateDigest = keccak256("certificate");
        QOPIdentityRegistry.RevokeDeviceIntent memory intent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: qid, certificateDigest: certificateDigest, nonce: 0, deadline: deadline
        });

        vm.prank(RELAYER);
        registry.revokeDevice(intent, _sign(OWNER_KEY, registry.hashRevokeDeviceIntent(intent)));

        assertTrue(registry.isDeviceRevoked(qid, certificateDigest));
        assertEq(registry.account(qid).nonce, 1);

        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.NonceConflict.selector, 1, 0));
        registry.revokeDevice(intent, "");
    }

    function test_rejectsRevokingTheSameCertificateTwice() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
        bytes32 certificateDigest = keccak256("certificate");
        QOPIdentityRegistry.RevokeDeviceIntent memory firstIntent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: qid, certificateDigest: certificateDigest, nonce: 0, deadline: deadline
        });
        registry.revokeDevice(firstIntent, _sign(OWNER_KEY, registry.hashRevokeDeviceIntent(firstIntent)));

        QOPIdentityRegistry.RevokeDeviceIntent memory secondIntent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: qid, certificateDigest: certificateDigest, nonce: 1, deadline: deadline
        });
        bytes memory secondSignature = _sign(OWNER_KEY, registry.hashRevokeDeviceIntent(secondIntent));
        vm.expectRevert(
            abi.encodeWithSelector(QOPIdentityRegistry.CertificateAlreadyRevoked.selector, qid, certificateDigest)
        );
        registry.revokeDevice(secondIntent, secondSignature);
    }

    function test_rotatesOwnerWithoutChangingTheQidOrHandle() public {
        uint256 qid = _register("alice", OWNER_KEY, keccak256("registration"));
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
        QOPIdentityRegistry.RevokeDeviceIntent memory revokeIntent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: qid, certificateDigest: keccak256("certificate"), nonce: 0, deadline: deadline
        });
        QOPIdentityRegistry.RotateOwnerIntent memory rotateIntent = QOPIdentityRegistry.RotateOwnerIntent({
            qid: qid, newOwner: vm.addr(SECOND_OWNER_KEY), nonce: 0, deadline: deadline
        });

        bytes memory revokeSignature = _sign(OWNER_KEY, registry.hashRevokeDeviceIntent(revokeIntent));
        bytes32 rotateDigest = registry.hashRotateOwnerIntent(rotateIntent);
        bytes memory rotateSignature = _sign(OWNER_KEY, rotateDigest);
        bytes memory newOwnerSignature = _sign(SECOND_OWNER_KEY, rotateDigest);

        registry.revokeDevice(revokeIntent, revokeSignature);
        vm.expectRevert(abi.encodeWithSelector(QOPIdentityRegistry.NonceConflict.selector, 1, 0));
        registry.rotateOwner(rotateIntent, rotateSignature, newOwnerSignature);
    }

    function test_deviceCertificateDigestMatchesTheTypescriptGoldenVector() public pure {
        bytes32 domainTypeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 certificateTypeHash = keccak256(
            "DeviceCertificateV1(uint8 version,uint256 qid,uint32 ownerVersion,bytes peerId,bytes32 encryptionPublicKey,uint64 issuedAt,bytes32 salt)"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                domainTypeHash,
                keccak256("QOP Identity"),
                keccak256("1"),
                uint256(11_155_111),
                address(0x1111111111111111111111111111111111111111)
            )
        );
        bytes memory peerId = hex"002408011220cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc";
        bytes32 structHash = keccak256(
            abi.encode(
                certificateTypeHash,
                uint8(1),
                uint256(42),
                uint32(3),
                keccak256(peerId),
                bytes32(0),
                uint64(1_700_000_000),
                bytes32(uint256(0x0101010101010101010101010101010101010101010101010101010101010101))
            )
        );

        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        assertEq(digest, 0x0fe41d712ec3ec99c4f62ed1b97c04ec30bd56985f9cf698d3c554db062119bd);
    }

    function test_registryIntentDigestsMatchTheTypescriptGoldenVectors() public {
        vm.chainId(11_155_111);
        address fixedRegistryAddress = address(0x1111111111111111111111111111111111111111);
        vm.etch(fixedRegistryAddress, address(registry).code);
        QOPIdentityRegistry fixedRegistry = QOPIdentityRegistry(fixedRegistryAddress);

        QOPIdentityRegistry.RegisterIntent memory registerIntent = QOPIdentityRegistry.RegisterIntent({
            handle: "alice",
            owner: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf,
            nonce: 0x0101010101010101010101010101010101010101010101010101010101010101,
            deadline: 1_700_003_600
        });
        QOPIdentityRegistry.RotateOwnerIntent memory rotateIntent = QOPIdentityRegistry.RotateOwnerIntent({
            qid: 42, newOwner: 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF, nonce: 7, deadline: 1_700_003_600
        });
        QOPIdentityRegistry.RevokeDeviceIntent memory revokeIntent = QOPIdentityRegistry.RevokeDeviceIntent({
            qid: 42,
            certificateDigest: 0x0fe41d712ec3ec99c4f62ed1b97c04ec30bd56985f9cf698d3c554db062119bd,
            nonce: 8,
            deadline: 1_700_003_600
        });

        assertEq(
            fixedRegistry.hashRegisterIntent(registerIntent),
            0x0b6c4ce4fce567f3d0487b1e17ddf9b20adc742fdf8c12c6bccdd8f83464ef39
        );
        assertEq(
            fixedRegistry.hashRotateOwnerIntent(rotateIntent),
            0xcfd2c2208d584d29013cb01bbcd1f1ae5cef6c3546b82c682c52a66633e24c6c
        );
        assertEq(
            fixedRegistry.hashRevokeDeviceIntent(revokeIntent),
            0xb1c5b8ecf82d6fab75d309bc820a474a36dbe795cc42f891d569379dc5435a6b
        );
    }

    function testFuzz_validLowercaseHandlesRegister(string memory handle) public {
        bytes memory value = bytes(handle);
        vm.assume(value.length >= registry.MIN_HANDLE_LENGTH());
        vm.assume(value.length <= registry.MAX_HANDLE_LENGTH());
        for (uint256 index; index < value.length; ++index) {
            vm.assume(value[index] >= 0x61 && value[index] <= 0x7a);
        }

        _register(handle, OWNER_KEY, keccak256(abi.encode(handle)));
        assertEq(registry.qidByHandleHash(keccak256(bytes(handle))), 1);
    }

    function _register(string memory handle, uint256 ownerKey, bytes32 registrationNonce) private returns (uint256) {
        QOPIdentityRegistry.RegisterIntent memory intent = _registerIntent(handle, vm.addr(ownerKey), registrationNonce);
        (bytes memory ownerSignature, bytes memory registrationSignature) = _registrationSignatures(intent, ownerKey);
        return registry.register(intent, ownerSignature, registrationSignature);
    }

    function _registerIntent(string memory handle, address intentOwner, bytes32 registrationNonce)
        private
        view
        returns (QOPIdentityRegistry.RegisterIntent memory)
    {
        return QOPIdentityRegistry.RegisterIntent({
            handle: handle, owner: intentOwner, nonce: registrationNonce, deadline: deadline
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
