// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Immutable identity trust root for QOP accounts.
/// @dev Owner custody authorizes multiple concurrent Ed25519 device keys.
/// Messaging authority is membership in the active device set for a `qid`.
contract QOPIdentityRegistry is EIP712 {
    struct Account {
        address owner;
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

    struct AddDeviceIntent {
        uint256 qid;
        bytes32 deviceKey;
        uint256 nonce;
        uint64 deadline;
    }

    struct RemoveDeviceIntent {
        uint256 qid;
        bytes32 deviceKey;
        uint256 nonce;
        uint64 deadline;
    }

    struct WipeDevicesIntent {
        uint256 qid;
        uint256 nonce;
        uint64 deadline;
    }

    uint256 public constant MIN_HANDLE_LENGTH = 1;
    uint256 public constant MAX_HANDLE_LENGTH = 32;
    uint256 public constant MAX_ACTIVE_DEVICES = 4;

    bytes32 public constant REGISTER_TYPEHASH =
        keccak256("RegisterV1(string handle,address owner,bytes32 deviceKey,bytes32 nonce,uint64 deadline)");
    bytes32 public constant ROTATE_OWNER_TYPEHASH =
        keccak256("RotateOwnerV1(uint256 qid,address newOwner,uint256 nonce,uint64 deadline)");
    bytes32 public constant ADD_DEVICE_TYPEHASH =
        keccak256("AddDeviceV1(uint256 qid,bytes32 deviceKey,uint256 nonce,uint64 deadline)");
    bytes32 public constant REMOVE_DEVICE_TYPEHASH =
        keccak256("RemoveDeviceV1(uint256 qid,bytes32 deviceKey,uint256 nonce,uint64 deadline)");
    bytes32 public constant WIPE_DEVICES_TYPEHASH =
        keccak256("WipeDevicesV1(uint256 qid,uint256 nonce,uint64 deadline)");

    address public immutable registrationAdmin;
    address public registrationSigner;
    bool public registrationOpen;
    uint256 public nextQid = 1;

    mapping(uint256 qid => Account) private _accounts;
    mapping(uint256 qid => bytes32[]) private _activeDevices;
    // 1-based index into `_activeDevices[qid]` for O(1) removal.
    mapping(uint256 qid => mapping(bytes32 deviceKey => uint256 indexPlusOne)) private _activeDeviceIndex;
    mapping(bytes32 handleHash => uint256 qid) public qidByHandleHash;
    mapping(address owner => uint256 qid) public qidByOwner;
    mapping(bytes32 deviceKey => uint256 qid) public qidByDeviceKey;
    // Removed keys cannot be re-added (fresh key required on relink).
    mapping(bytes32 deviceKey => bool) public deviceKeyRemoved;
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
    event DeviceAdded(uint256 indexed qid, bytes32 indexed deviceKey, uint256 nonce);
    event DeviceRemoved(uint256 indexed qid, bytes32 indexed deviceKey, uint256 nonce);
    event DevicesWiped(uint256 indexed qid, uint256 removedCount, uint256 nonce);
    event RegistrationOpened(address indexed previousSigner);
    event RegistrationSignerUpdated(address indexed previousSigner, address indexed newSigner);

    error AccountNotFound(uint256 qid);
    error DeviceAlreadyActive(uint256 qid, bytes32 deviceKey);
    error DeviceKeyAlreadyRegistered(bytes32 deviceKey, uint256 qid);
    error DeviceKeyRemoved(bytes32 deviceKey);
    error DeviceNotActive(uint256 qid, bytes32 deviceKey);
    error EmptyDeviceKey();
    error ExpiredIntent(uint64 deadline);
    error HandleAlreadyRegistered(bytes32 handleHash, uint256 qid);
    error InvalidHandleCharacter(uint256 index, bytes1 character);
    error InvalidHandleLength(uint256 length);
    error InvalidNewOwnerSignature(address recovered, address expected);
    error InvalidOwnerSignature(address recovered, address expected);
    error InvalidRegistrationSignature(address recovered, address expected);
    error InvalidSignatureLength(uint256 length);
    error InvalidYParity(uint8 yParity);
    error MaxDevicesReached(uint256 qid, uint256 maxActiveDevices);
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

        _assertDeviceKeyAvailable(intent.deviceKey);

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
        _accounts[qid] = Account({
            owner: intent.owner,
            ownerVersion: 0,
            registeredAt: uint64(block.timestamp),
            nonce: 0,
            handle: intent.handle
        });
        _addActiveDevice(qid, intent.deviceKey);

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

    function addDevice(AddDeviceIntent calldata intent, bytes calldata ownerSignature) external {
        Account storage current = _account(intent.qid);
        _validateDeadline(intent.deadline);
        _validateNonce(current.nonce, intent.nonce);
        if (intent.deviceKey == bytes32(0)) revert EmptyDeviceKey();
        if (_activeDeviceIndex[intent.qid][intent.deviceKey] != 0) {
            revert DeviceAlreadyActive(intent.qid, intent.deviceKey);
        }
        if (_activeDevices[intent.qid].length >= MAX_ACTIVE_DEVICES) {
            revert MaxDevicesReached(intent.qid, MAX_ACTIVE_DEVICES);
        }
        _assertDeviceKeyAvailable(intent.deviceKey);

        bytes32 digest = hashAddDeviceIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != current.owner) {
            revert InvalidOwnerSignature(recoveredOwner, current.owner);
        }

        _addActiveDevice(intent.qid, intent.deviceKey);
        current.nonce = intent.nonce + 1;
        emit DeviceAdded(intent.qid, intent.deviceKey, intent.nonce);
    }

    function removeDevice(RemoveDeviceIntent calldata intent, bytes calldata ownerSignature) external {
        Account storage current = _account(intent.qid);
        _validateDeadline(intent.deadline);
        _validateNonce(current.nonce, intent.nonce);
        if (intent.deviceKey == bytes32(0)) revert EmptyDeviceKey();
        if (_activeDeviceIndex[intent.qid][intent.deviceKey] == 0) {
            revert DeviceNotActive(intent.qid, intent.deviceKey);
        }

        bytes32 digest = hashRemoveDeviceIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != current.owner) {
            revert InvalidOwnerSignature(recoveredOwner, current.owner);
        }

        _removeActiveDevice(intent.qid, intent.deviceKey);
        current.nonce = intent.nonce + 1;
        emit DeviceRemoved(intent.qid, intent.deviceKey, intent.nonce);
    }

    /// @notice Owner recovery after compromise: clear every active device.
    /// Devices must be re-added with fresh keys.
    function wipeDevices(WipeDevicesIntent calldata intent, bytes calldata ownerSignature) external {
        Account storage current = _account(intent.qid);
        _validateDeadline(intent.deadline);
        _validateNonce(current.nonce, intent.nonce);

        bytes32 digest = hashWipeDevicesIntent(intent);
        address recoveredOwner = _recoverSigner(digest, ownerSignature);
        if (recoveredOwner != current.owner) {
            revert InvalidOwnerSignature(recoveredOwner, current.owner);
        }

        uint256 removedCount = _wipeActiveDevices(intent.qid);
        current.nonce = intent.nonce + 1;
        emit DevicesWiped(intent.qid, removedCount, intent.nonce);
    }

    function account(uint256 qid) external view returns (Account memory) {
        Account storage current = _account(qid);
        return current;
    }

    function listActiveDevices(uint256 qid) external view returns (bytes32[] memory) {
        _account(qid);
        return _activeDevices[qid];
    }

    function activeDeviceCount(uint256 qid) external view returns (uint256) {
        _account(qid);
        return _activeDevices[qid].length;
    }

    function isActiveDevice(uint256 qid, bytes32 deviceKey) external view returns (bool) {
        _account(qid);
        return _activeDeviceIndex[qid][deviceKey] != 0;
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

    function hashAddDeviceIntent(AddDeviceIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(ADD_DEVICE_TYPEHASH, intent.qid, intent.deviceKey, intent.nonce, intent.deadline));
        return _hashTypedDataV4(structHash);
    }

    function hashRemoveDeviceIntent(RemoveDeviceIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(REMOVE_DEVICE_TYPEHASH, intent.qid, intent.deviceKey, intent.nonce, intent.deadline));
        return _hashTypedDataV4(structHash);
    }

    function hashWipeDevicesIntent(WipeDevicesIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(WIPE_DEVICES_TYPEHASH, intent.qid, intent.nonce, intent.deadline));
        return _hashTypedDataV4(structHash);
    }

    function _account(uint256 qid) private view returns (Account storage current) {
        current = _accounts[qid];
        if (current.owner == address(0)) revert AccountNotFound(qid);
    }

    function _assertDeviceKeyAvailable(bytes32 deviceKey) private view {
        if (deviceKeyRemoved[deviceKey]) revert DeviceKeyRemoved(deviceKey);
        uint256 existingDeviceQid = qidByDeviceKey[deviceKey];
        if (existingDeviceQid != 0) revert DeviceKeyAlreadyRegistered(deviceKey, existingDeviceQid);
    }

    function _addActiveDevice(uint256 qid, bytes32 deviceKey) private {
        _activeDevices[qid].push(deviceKey);
        _activeDeviceIndex[qid][deviceKey] = _activeDevices[qid].length;
        qidByDeviceKey[deviceKey] = qid;
    }

    function _removeActiveDevice(uint256 qid, bytes32 deviceKey) private {
        uint256 indexPlusOne = _activeDeviceIndex[qid][deviceKey];
        if (indexPlusOne == 0) revert DeviceNotActive(qid, deviceKey);
        uint256 index = indexPlusOne - 1;
        bytes32[] storage devices = _activeDevices[qid];
        uint256 lastIndex = devices.length - 1;
        if (index != lastIndex) {
            bytes32 moved = devices[lastIndex];
            devices[index] = moved;
            _activeDeviceIndex[qid][moved] = index + 1;
        }
        devices.pop();
        delete _activeDeviceIndex[qid][deviceKey];
        delete qidByDeviceKey[deviceKey];
        deviceKeyRemoved[deviceKey] = true;
    }

    function _wipeActiveDevices(uint256 qid) private returns (uint256 removedCount) {
        bytes32[] storage devices = _activeDevices[qid];
        removedCount = devices.length;
        for (uint256 index; index < removedCount; ++index) {
            bytes32 deviceKey = devices[index];
            delete _activeDeviceIndex[qid][deviceKey];
            delete qidByDeviceKey[deviceKey];
            deviceKeyRemoved[deviceKey] = true;
        }
        delete _activeDevices[qid];
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
