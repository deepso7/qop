# Desktop device linking E2E, 2026-11-08

Milestone 2 of `docs/research/desktop-app-plan.md` on `feat/desktop-rune`. Adapted from `cli-device-linking-e2e.md`, but fully local: Anvil, a throwaway Postgres, the API from source, `qop-desktop --headless`, and a scripted phone (`cli/scripts/desktop-phone.ts`) in place of the app.

## Result

Passed on macOS 27 (Apple silicon): link, restart mid-enrollment, restart once linked (same peer ID), lost-reply recovery through Stop waiting (same device key, same record replayed), single-instance lock, and a relay reservation on the public relay.

- Transport: real QUIC between the desktop's Rust `minip2p-rs` 0.11.6 node and `@minip2p/node` 0.11.6 in the phone script, over the LAN addresses the desktop advertised (wildcard listeners expanded per interface). Relay *traversal* was not exercised; only the reservation and the circuit address in the offer.
- The phone is a script, not the app: it reuses the app's `handshakePairing` / `sendPairingApproval` (`mobile/src/lib/pairing-client-core.ts`) and API client (`device-action-client-core.ts`), and signs with the owner key the app would hold. A real phone run (QR scan from the app) is still to do; the app already has the scanner.
- Device keys used the default file store (`device.key`, 0600). See `desktop/src/keys.rs` for why the Keychain is opt-in.

## Stack

Anvil test accounts: #0 deploys and is the registration admin, #1 is the registration signer (`REGISTRATION_PRIVATE_KEY`), #2 is the API relayer, #3 pays for the script's registrations.

```sh
mkdir -p /tmp/qop-e2e && cd /tmp/qop-e2e
anvil --port 18545 --silent > anvil.log 2>&1 & echo $! > anvil.pid

# from the repo root
REGISTRATION_ADMIN=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
REGISTRATION_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
forge script --root contracts contracts/script/DeployQOPIdentityRegistry.s.sol:DeployQOPIdentityRegistry \
  --broadcast --rpc-url http://127.0.0.1:18545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# registry: contract QOPIdentityRegistry 0x5FbDB2315678afecb367f032d93F642f64180aa3

# Postgres needs a real locale on macOS ("postmaster became multithreaded during startup").
initdb -D /tmp/qop-e2e/pg -U qop --auth=trust
LC_ALL=en_US.UTF-8 pg_ctl -D /tmp/qop-e2e/pg -o "-p 54329 -k /tmp/qop-e2e" -l /tmp/qop-e2e/pg.log start
createdb -h 127.0.0.1 -p 54329 -U qop qop
```

`/tmp/qop-e2e/api.env`:

```sh
DATABASE_URL=postgresql://qop@127.0.0.1:54329/qop
PORT=13000
REGISTRATION_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
RELAYER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
RPC_URL=http://127.0.0.1:18545
CHAIN_ID=31337
REGISTRY_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
REGISTRY_CONFIRMATIONS=0
```

```sh
(cd api && DATABASE_URL=postgresql://qop@127.0.0.1:54329/qop pnpm exec drizzle-kit push)
(cd api && node --env-file=/tmp/qop-e2e/api.env src/main.ts > /tmp/qop-e2e/api.log 2>&1 & echo $! > /tmp/qop-e2e/api.pid)
```

`/tmp/qop-e2e/env.sh`, sourced by every desktop and phone command below:

```sh
export QOP_RPC_URL=http://127.0.0.1:18545
export QOP_REGISTRY_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
export QOP_REGISTRY_CHAIN_ID=31337
export QOP_API_URL=http://127.0.0.1:13000
export QOP_E2E_REGISTRATION_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export QOP_E2E_FUNDER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
```

Build once with `cd desktop && cargo build`. Below, `phone` is `node --no-warnings cli/scripts/desktop-phone.ts` and `desktop` is `desktop/target/debug/qop-desktop`, both run from the repo root.

## Cases

### 1. Link, restart mid-enrollment, restart linked (@alice)

```sh
. /tmp/qop-e2e/env.sh; export QOP_DATA_DIR=/tmp/qop-e2e/desktop
phone register alice
# registered @alice qid=1 phone=0xafd283ad…
desktop --headless --link alice > /tmp/qop-e2e/desktop.log 2>&1 & echo $! > /tmp/qop-e2e/desktop.pid
# phase=EnterHandle lookup=Resolving { handle: "alice" }
# phase=Pairing handle=alice relay=LocalOnly offer=qop-pair1.eyJhZGRycyI6WyIvaXA0LzE5Mi4xNjguMTAuMTMz… fingerprint=B02158FC
phone approve "$(grep -o 'qop-pair1\.[A-Za-z0-9_-]*' /tmp/qop-e2e/desktop.log | tail -1)" --no-submit
# hello acknowledged by B02158FC (12D3KooWMfuR728mXJupoQyTQtUQUsGZVQT6Y8BmGtnjYjcm1vjC)
# approvalSaved 0xbf6380a4…
# desktop: phase=AwaitingEnrollment handle=alice progress=Approved relay=LocalOnly recovery=none

kill "$(cat /tmp/qop-e2e/desktop.pid)"
desktop --headless > /tmp/qop-e2e/desktop2.log 2>&1 & echo $! > /tmp/qop-e2e/desktop.pid
# phase=AwaitingEnrollment handle=alice progress=Approved relay=LocalOnly recovery=none

phone submit
# submitted 0xbf6380a4… status=submitted
# api status=confirmed tx=0xfc7f1263…
# desktop, on its own chain read: phase=Linked handle=alice peer=12D3KooWMfuR728mXJupoQyTQtUQUsGZVQT6Y8BmGtnjYjcm1vjC fingerprint=B02158FC

kill "$(cat /tmp/qop-e2e/desktop.pid)"
desktop --headless
# phase=Linked handle=alice peer=12D3KooWMfuR728mXJupoQyTQtUQUsGZVQT6Y8BmGtnjYjcm1vjC fingerprint=B02158FC
cast call 0x5FbDB2315678afecb367f032d93F642f64180aa3 "qidByDeviceKey(bytes32)(uint256)" \
  0xb02158fc0b4b536b04814a75f0c7b4154970377f7f2528c3301af1809dd9e1a3 --rpc-url http://127.0.0.1:18545
# 1
```

A second instance on the same data directory exits 1 with `qop: another qop Desktop is using this data directory`.

### 2. Lost reply: Stop waiting and replay (@bob)

Headless mode reads button presses from stdin (`regenerate`, `stop-waiting`, `unlink`, `start-over`, `link HANDLE`); a FIFO fed by `tail -f` keeps it open.

```sh
cd /tmp/qop-e2e && mkfifo b.in && touch b.cmds
tail -f b.cmds > b.in & echo $! > tail.pid
QOP_DATA_DIR=/tmp/qop-e2e/desktop-bob desktop --headless --link bob < b.in > b.log 2>&1 & echo $! > b.pid
export QOP_E2E_PHONE=/tmp/qop-e2e/phone-bob.json
phone register bob
phone approve "$(grep -o 'qop-pair1\.[A-Za-z0-9_-]*' b.log | tail -1)" --no-submit
# approvalSaved 0x4c5b4046…   (the phone keeps it pending; pretend the reply was lost)
echo stop-waiting >> b.cmds
# phase=AwaitingEnrollment handle=bob progress=Approved relay=LocalOnly recovery=qop-pair1.…
phone approve "$(grep -o 'recovery=qop-pair1\.[A-Za-z0-9_-]*' b.log | tail -1 | sed 's/recovery=//')"
# hello acknowledged by 60ACC541 (…)          same device key as the first offer
# approvalSaved 0x4c5b4046…                   same record, replayed without the nonce/deadline checks
# api status=confirmed
# phase=Linked handle=bob peer=12D3KooWGKk79yKT2UnWpMc7LJsaahrxFkfoa7DNa1TZXJFBNLUp fingerprint=60ACC541
```

### 3. Relay reservation

```sh
QOP_RELAY_ADDRS=/dns/relay.minip2p.com/udp/19876/quic-v1/p2p/12D3KooWNAHhp6rp11SvCDA84zua3hhEYTLNjgKmEDmt1BddtLdf \
QOP_DATA_DIR=/tmp/qop-e2e/desktop-relay desktop --headless --link alice < /dev/null
# phase=Pairing handle=alice relay=Connecting offer=none
# phase=Pairing handle=alice relay=Connected offer=qop-pair1.…
# offer addrs: [".../p2p/12D3KooWNAHhp…/p2p-circuit/p2p/12D3KooWMxGH…", "/ip4/192.168.10.133/udp/62560/quic-v1/p2p/12D3KooWMxGH…"]
```

## Teardown

```sh
kill "$(cat /tmp/qop-e2e/api.pid)" "$(cat /tmp/qop-e2e/anvil.pid)"
pg_ctl -D /tmp/qop-e2e/pg stop
rm -rf /tmp/qop-e2e
```

## Automated coverage

`cd desktop && cargo test` runs the same flows in-process (`src/engine/tests.rs`: a real loopback node, a scripted phone node, fake chain and API, restarts over one data directory), every row of the pending-approval table (`src/engine/enrollment.rs`), and the CLI's pairing-session, pending-approval, enrollment-poll and pairing-address tests (`src/engine/pairing.rs`, `enrollment.rs`).

## Not covered

- The phone app itself (QR scan and approval from a dev build), and relay traversal.
- Revocation: a linked desktop re-reads its membership every minute and wipes on the registry's removal marker, but no removal was performed here (milestone 6).
- The Keychain backend (`QOP_KEY_STORE=keychain`) in an end-to-end run.
