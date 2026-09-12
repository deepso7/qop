# QOP

QOP accounts can authorize several independent devices to exchange messages as the same person.

## Language

**Account**: A messaging identity with a permanent handle and qid. Its identity persists when its authorized devices change.

**Owner**: The authority that approves changes to an account and its devices. Messaging authority alone does not grant ownership.

**Device**: An independently authorized participant that can exchange messages for an account. A phone and a CLI are separate devices even when they belong to the same account.

**Pairing**: The exchange that connects a new device to the owner's approval flow. Pairing alone does not authorize the device to exchange account messages.

**Enrollment**: The addition of a device to an account's authorized devices.

**Revocation**: The removal of a device's authority to exchange future messages for an account. It does not erase conversation history already accepted by other devices.
