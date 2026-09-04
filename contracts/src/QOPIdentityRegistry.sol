// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Immutable identity trust root for QOP accounts.
/// @dev The registry stores account ownership, device keys, handles, owner
/// versions, and action nonces.
contract QOPIdentityRegistry is EIP712 {
    struct Account {
        address owner;
        bytes32 deviceKey;
        uint32 ownerVersion;
        uint64 registeredAt;
        uint256 nonce;
        string handle;
    }

    struct RegisterIntent {
        string handle;
        address owner;
        bytes32 deviceKey;
        bytes32 nonce;
        uint64 deadline;
    }

    struct RotateOwnerIntent {
        uint256 qid;
        address newOwner;
        uint256 nonce;
        uint64 deadline;
    }

    struct RotateDeviceIntent {
        uint256 qid;
        bytes32 newDeviceKey;
        uint256 nonce;
        uint64 deadline;
    }

    uint256 public constant MIN_HANDLE_LENGTH = 1;
    uint256 public constant MAX_HANDLE_LENGTH = 32;

    bytes32 public constant REGISTER_TYPEHASH =
        keccak256("RegisterV1(string handle,address owner,bytes32 deviceKey,bytes32 nonce,uint64 deadline)");
    bytes32 public constant ROTATE_OWNER_TYPEHASH =
        keccak256("RotateOwnerV1(uint256 qid,address newOwner,uint256 nonce,uint64 deadline)");
    bytes32 public constant ROTATE_DEVICE_TYPEHASH =
        keccak256("RotateDeviceV1(uint256 qid,bytes32 newDeviceKey,uint256 nonce,uint64 deadline)");

    address public immutable registrationAdmin;
    address public registrationSigner;
    bool public registrationOpen;
    uint256 public nextQid = 1;

    mapping(uint256 qid => Account) private _accounts;
    mapping(bytes32 handleHash => uint256 qid) public qidByHandleHash;
    mapping(address owner => uint256 qid) public qidByOwner;
    mapping(bytes32 deviceKey => uint256 qid) public qidByDeviceKey;
    mapping(bytes32 registrationNonce => bool used) public registrationNonceUsed;

    event AccountRegistered(
        uint256 indexed qid,
        bytes32 indexed handleHash,
        address indexed owner,
        string handle,
        bytes32 deviceKey,
        bytes32 registrationNonce,
        uint64 registeredAt
    );
    event OwnerRotated(
        uint256 indexed qid, address indexed previousOwner, address indexed newOwner, uint32 ownerVersion, uint256 nonce
    );
    event DeviceRotated(
        uint256 indexed qid, bytes32 indexed previousDeviceKey, bytes32 indexed newDeviceKey, uint256 nonce
    );
    event RegistrationOpened(address indexed previousSigner);
    event RegistrationSignerUpdated(address indexed previousSigner, address indexed newSigner);

    error AccountNotFound(uint256 qid);
    error DeviceKeyUnchanged(uint256 qid, bytes32 deviceKey);
    error EmptyDeviceKey();
    error DeviceKeyAlreadyRegistered(bytes32 deviceKey, uint256 qid);
    error ExpiredIntent(uint64 deadline);
    error HandleAlreadyRegistered(bytes32 handleHash, uint256 qid);
    error InvalidHandleCharacter(uint256 index, bytes1 character);
    error InvalidHandleLength(uint256 length);
    error InvalidNewOwnerSignature(address recovered, address expected);
    error InvalidOwnerSignature(address recovered, address expected);
    error InvalidRegistrationSignature(address recovered, address expected);
    error InvalidSignatureLength(uint256 length);
    error InvalidYParity(uint8 yParity);
    error NonceConflict(uint256 expected, uint256 received);
    error OwnerAlreadyRegistered(address owner, uint256 qid);
    error OwnerVersionOverflow(uint256 qid);
    error RegistrationNonceAlreadyUsed(bytes32 nonce);
    error RegistrationAlreadyOpen();
    error UnauthorizedRegistrationAdmin(address caller);
    error ZeroRegistrationNonce();
    error ZeroAddress();

    constructor(address registrationAdmin_, address registrationSigner_) EIP712("QOP Identity", "1") {
        if (registrationAdmin_ == address(0)) revert ZeroAddress();
        if (registrationSigner_ == address(0)) revert ZeroAddress();
        registrationAdmin = registrationAdmin_;
        registrationSigner = registrationSigner_;
    }

    function setRegistrationSigner(address newSigner) external {
        if (registrationOpen) revert RegistrationAlreadyOpen();
        _requireRegistrationAdmin();
        if (newSigner == address(0)) revert ZeroAddress();
        address previousSigner = registrationSigner;
        registrationSigner = newSigner;
        emit RegistrationSignerUpdated(previousSigner, newSigner);
    }

    function openRegistration() external {
        if (registrationOpen) revert RegistrationAlreadyOpen();
        _requireRegistrationAdmin();
        address previousSigner = registrationSigner;
        registrationOpen = true;
        registrationSigner = address(0);
        emit RegistrationOpened(previousSigner);
    }

    function register(
        RegisterIntent calldata intent,
        bytes calldata ownerSignature,
        bytes calldata registrationSignature
    ) external returns (uint256 qid) {
        _validateHandle(intent.handle);
        _validateDeadline(intent.deadline);
        if (intent.owner == address(0)) revert ZeroAddress();
        if (intent.deviceKey == bytes32(0)) revert EmptyDeviceKey();
        if (intent.nonce == bytes32(0)) revert ZeroRegistrationNonce();
        if (registrationNonceUsed[intent.nonce]) {
            revert RegistrationNonceAlreadyUsed(intent.nonce);
        }

        uint256 existingOwnerQid = qidByOwner[intent.owner];
        if (existingOwnerQid != 0) {
            revert OwnerAlreadyRegistered(intent.owner, existingOwnerQid);
        }

        bytes32 canonicalHandleHash = keccak256(bytes(intent.handle));
        uint256 existingHandleQid = qidByHandleHash[canonicalHandleHash];
        if (existingHandleQid != 0) {
            revert HandleAlreadyRegistered(canonicalHandleHash, existingHandleQid);
        }

        uint256 existingDeviceQid = qidByDeviceKey[intent.deviceKey];
        if (existingDeviceQid != 0) revert DeviceKeyAlreadyRegistered(intent.deviceKey, existingDeviceQid);

        bytes32 digest = hashRegisterIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != intent.owner) {
            revert InvalidOwnerSignature(recoveredOwner, intent.owner);
        }
        if (!registrationOpen) {
            address recoveredRegistrationSigner = _recoverSigner(digest, registrationSignature);
            if (recoveredRegistrationSigner != registrationSigner) {
                revert InvalidRegistrationSignature(recoveredRegistrationSigner, registrationSigner);
            }
        }

        qid = nextQid;
        nextQid = qid + 1;
        registrationNonceUsed[intent.nonce] = true;
        qidByHandleHash[canonicalHandleHash] = qid;
        qidByOwner[intent.owner] = qid;
        qidByDeviceKey[intent.deviceKey] = qid;
        _accounts[qid] = Account({
            owner: intent.owner,
            deviceKey: intent.deviceKey,
            ownerVersion: 0,
            registeredAt: uint64(block.timestamp),
            nonce: 0,
            handle: intent.handle
        });

        emit AccountRegistered(
            qid,
            canonicalHandleHash,
            intent.owner,
            intent.handle,
            intent.deviceKey,
            intent.nonce,
            uint64(block.timestamp)
        );
    }

    function rotateOwner(
        RotateOwnerIntent calldata intent,
        bytes calldata ownerSignature,
        bytes calldata newOwnerSignature
    ) external {
        Account storage current = _account(intent.qid);
        _validateDeadline(intent.deadline);
        _validateNonce(current.nonce, intent.nonce);
        if (intent.newOwner == address(0)) revert ZeroAddress();

        uint256 existingQid = qidByOwner[intent.newOwner];
        if (existingQid != 0) {
            revert OwnerAlreadyRegistered(intent.newOwner, existingQid);
        }
        if (current.ownerVersion == type(uint32).max) {
            revert OwnerVersionOverflow(intent.qid);
        }

        bytes32 digest = hashRotateOwnerIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != current.owner) {
            revert InvalidOwnerSignature(recoveredOwner, current.owner);
        }
        address recoveredNewOwner = _recoverSigner(digest, newOwnerSignature);
        if (recoveredNewOwner != intent.newOwner) {
            revert InvalidNewOwnerSignature(recoveredNewOwner, intent.newOwner);
        }

        address previousOwner = current.owner;
        uint32 nextOwnerVersion = current.ownerVersion + 1;
        current.owner = intent.newOwner;
        current.ownerVersion = nextOwnerVersion;
        current.nonce = intent.nonce + 1;
        delete qidByOwner[previousOwner];
        qidByOwner[intent.newOwner] = intent.qid;

        emit OwnerRotated(intent.qid, previousOwner, intent.newOwner, nextOwnerVersion, intent.nonce);
    }

    function rotateDevice(RotateDeviceIntent calldata intent, bytes calldata ownerSignature) external {
        Account storage current = _account(intent.qid);
        _validateDeadline(intent.deadline);
        _validateNonce(current.nonce, intent.nonce);
        if (intent.newDeviceKey == bytes32(0)) revert EmptyDeviceKey();
        if (intent.newDeviceKey == current.deviceKey) revert DeviceKeyUnchanged(intent.qid, intent.newDeviceKey);

        uint256 existingDeviceQid = qidByDeviceKey[intent.newDeviceKey];
        if (existingDeviceQid != 0) revert DeviceKeyAlreadyRegistered(intent.newDeviceKey, existingDeviceQid);

        bytes32 digest = hashRotateDeviceIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != current.owner) {
            revert InvalidOwnerSignature(recoveredOwner, current.owner);
        }

        bytes32 previousDeviceKey = current.deviceKey;
        delete qidByDeviceKey[previousDeviceKey];
        qidByDeviceKey[intent.newDeviceKey] = intent.qid;
        current.deviceKey = intent.newDeviceKey;
        current.nonce = intent.nonce + 1;
        emit DeviceRotated(intent.qid, previousDeviceKey, intent.newDeviceKey, intent.nonce);
    }

    function account(uint256 qid) external view returns (Account memory) {
        Account storage current = _account(qid);
        return current;
    }

    function handleHash(string calldata handle) external pure returns (bytes32) {
        return keccak256(bytes(handle));
    }

    function hashRegisterIntent(RegisterIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                REGISTER_TYPEHASH,
                keccak256(bytes(intent.handle)),
                intent.owner,
                intent.deviceKey,
                intent.nonce,
                intent.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function hashRotateOwnerIntent(RotateOwnerIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(ROTATE_OWNER_TYPEHASH, intent.qid, intent.newOwner, intent.nonce, intent.deadline));
        return _hashTypedDataV4(structHash);
    }

    function hashRotateDeviceIntent(RotateDeviceIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ROTATE_DEVICE_TYPEHASH, intent.qid, intent.newDeviceKey, intent.nonce, intent.deadline)
        );
        return _hashTypedDataV4(structHash);
    }

    function _account(uint256 qid) private view returns (Account storage current) {
        current = _accounts[qid];
        if (current.owner == address(0)) revert AccountNotFound(qid);
    }

    function _requireRegistrationAdmin() private view {
        if (msg.sender != registrationAdmin) revert UnauthorizedRegistrationAdmin(msg.sender);
    }

    function _validateDeadline(uint64 deadline) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert ExpiredIntent(deadline);
    }

    function _validateHandle(string calldata handle) private pure {
        bytes calldata value = bytes(handle);
        uint256 length = value.length;
        if (length < MIN_HANDLE_LENGTH || length > MAX_HANDLE_LENGTH) {
            revert InvalidHandleLength(length);
        }
        for (uint256 index; index < length; ++index) {
            bytes1 character = value[index];
            bool lowercaseLetter = character >= 0x61 && character <= 0x7a;
            bool digit = character >= 0x30 && character <= 0x39;
            if (!lowercaseLetter && !digit && (index == 0 || character != 0x5f)) {
                revert InvalidHandleCharacter(index, character);
            }
        }
    }

    function _validateNonce(uint256 expected, uint256 received) private pure {
        if (received != expected) revert NonceConflict(expected, received);
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) {
            revert InvalidSignatureLength(signature.length);
        }

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) {
            if (v > 1) revert InvalidYParity(v);
            v += 27;
        } else if (v > 28) {
            revert InvalidYParity(v);
        }
        return ECDSA.recover(digest, v, r, s);
    }
}
