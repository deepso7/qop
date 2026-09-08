# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

Set `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_RPC_URL`, `EXPO_PUBLIC_REGISTRY_ADDRESS`, `EXPO_PUBLIC_REGISTRY_CHAIN_ID`, and `EXPO_PUBLIC_RELAY_ADDRS` before running the app. `EXPO_PUBLIC_RELAY_ADDRS` is a comma-separated list of minip2p relay multiaddresses. The registry values pin the EIP-712 domain the local owner key may authorize, and the RPC URL lets the app read registrations directly from the chain. The API is used only during registration. Native devices and emulators must use API and RPC addresses that can reach the development machine; `127.0.0.1` only works when those services are available inside that device's network namespace.

Chat authorization is checked against the registry on first use of each transport connection, in both directions. Further messages on that verified connection need no RPC or API call. Disconnecting clears verification; reconnecting requires a fresh registry check before sending or accepting chat messages. Device-key rotation therefore takes effect on the next connection, while an existing verified connection can continue through an RPC outage. New connections fail verification if the registry cannot be read. Offline delivery is deferred.

Use Node.js 22.19 or later in the 22.x line, or Node.js 24 or newer. The SQLite tests use Node’s built-in SQLite module, and pnpm enforces the supported Node versions.

## Get started

1. Install dependencies

   ```bash
   pnpm install
   ```

2. Start the app

   ```bash
   pnpm --filter mobile ios
   pnpm --filter mobile android
   ```

Run these from the repository root. Both commands build the native development client and connect it to Metro. After native dependency changes, regenerate the native projects and reinstall iOS pods before reusing an existing Xcode workspace. Expo Go cannot load minip2p's native module.

Expo also documents the available development environments:

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

## Native verification before merging

These checks require two development builds connected to the configured registry and relay. Automated tests cover the SQL, wire validation, session authorization, and store lifecycle; they do not exercise the native transport.

- Register two distinct accounts and exchange messages in both directions. Confirm acknowledgements, persistence after restart, and matching arrival order and bubble times.
- Interrupt a send by closing the app, then reopen it. The message should be retryable with its original ID; retry should not duplicate it on the recipient.
- Disconnect and reconnect a peer, then exchange messages again. A new connection must verify against the registry.
- After establishing a verified connection, make RPC unavailable. Messages on that connection should continue; a new connection should fail verification.
- Rotate a device key. The old live connection may continue, but the old key must fail verification after reconnecting. The replacement device must connect successfully.
- Trigger dropped native events or queue overflow in a debug build. Check that invalidated connections cannot deliver chat messages and that relay reservation and messaging recover after restarting the endpoint.

EAS profiles pin Node.js 24.20.0 to match the local validation runtime.

### minip2p regression coverage

minip2p 0.5.3 includes the native connection ID and buffered stream closure fixes previously carried as local patches. `test/minip2p-adapter.test.ts` exercises these behaviors against the installed SDK through a substitute native FFI boundary.
