import { Effect, Result } from "effect";
import { create } from "zustand";

import type {
  createIdentityVault,
  IdentityBackupState,
  IdentityVaultError,
  LocalIdentity,
} from "@/lib/identity-vault-core";
import type {
  createLocalRegistration,
  LocalRegistration,
} from "@/lib/local-registration-core";

export type IdentityStatus =
  | "absent"
  | "backup"
  | "creating"
  | "error"
  | "loading"
  | "ready"
  | "resetting"
  | "unregistered";

type IdentityResult<A> = Result.Result<A, IdentityVaultError>;

interface IdentityState {
  error: IdentityVaultError | null;
  identity: LocalIdentity | null;
  isHydrating: boolean;
  registration: LocalRegistration | null;
  status: IdentityStatus;
}

interface IdentityActions {
  createIdentity: (handle: string) => Promise<IdentityResult<LocalIdentity>>;
  setBackupState: (
    backupState: Exclude<IdentityBackupState, "pending">
  ) => Promise<IdentityResult<void>>;
  hydrate: () => Promise<void>;
  revealRecoveryKey: () => Promise<IdentityResult<string>>;
  resetIdentity: () => Promise<IdentityResult<void>>;
  retryLoad: () => void;
}

type IdentityStore = IdentityActions & IdentityState;

const initialState: IdentityState = {
  error: null,
  identity: null,
  isHydrating: true,
  registration: null,
  status: "loading",
};

const stateForIdentity = (
  identity: LocalIdentity | null,
  registration: LocalRegistration | null = null
): IdentityState => {
  let status: IdentityStatus = "ready";
  if (identity === null) {
    status = "absent";
  } else if (identity.backupState === "pending") {
    status = "backup";
  } else if (registration?.status !== "confirmed") {
    status = "unregistered";
  }
  return {
    error: null,
    identity,
    isHydrating: false,
    registration,
    status,
  };
};

export interface IdentityStoreDependencies {
  readonly deleteAllData: () => Promise<void>;
  readonly identityVault: Pick<
    ReturnType<typeof createIdentityVault>,
    | "createLocalIdentity"
    | "deleteLocalIdentity"
    | "loadLocalIdentity"
    | "revealLocalIdentityRecoveryKey"
    | "updateLocalIdentityBackupState"
  >;
  readonly makeIdentityVaultError: (
    operation: IdentityVaultError["operation"]
  ) => IdentityVaultError;
  readonly registration: Pick<
    ReturnType<typeof createLocalRegistration>,
    "deleteLocalRegistration" | "loadLocalRegistration"
  >;
  readonly stopP2p: () => Promise<void>;
}

const runOperation = <A>(
  effect: Effect.Effect<A>,
  onComplete: () => void
): Promise<A> => {
  const run = async () => {
    try {
      return await Effect.runPromise(effect);
    } finally {
      onComplete();
    }
  };
  return run();
};

export const createIdentityStore = ({
  deleteAllData,
  identityVault,
  makeIdentityVaultError,
  registration,
  stopP2p,
}: IdentityStoreDependencies) => {
  const {
    createLocalIdentity,
    deleteLocalIdentity,
    loadLocalIdentity,
    revealLocalIdentityRecoveryKey,
    updateLocalIdentityBackupState,
  } = identityVault;
  const { deleteLocalRegistration, loadLocalRegistration } = registration;
  let loadGeneration = 0;
  let createOperation: Promise<IdentityResult<LocalIdentity>> | null = null;
  let backupStateOperation: Promise<IdentityResult<void>> | null = null;
  let resetOperation: Promise<IdentityResult<void>> | null = null;

  return create<IdentityStore>((set, get) => ({
    ...initialState,

    createIdentity: (handle) => {
      if (resetOperation || get().status === "resetting") {
        return Promise.resolve(Result.fail(makeIdentityVaultError("create")));
      }
      if (createOperation) {
        return createOperation;
      }

      loadGeneration += 1;
      set({
        error: null,
        identity: null,
        isHydrating: false,
        registration: null,
        status: "creating",
      });
      const effect = createLocalIdentity(handle).pipe(
        Effect.tap((identity) =>
          Effect.sync(() => {
            if (resetOperation) {
              return;
            }
            set({
              error: null,
              identity,
              isHydrating: false,
              registration: null,
              status: "backup",
            });
          })
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (resetOperation) {
              return;
            }
            set({
              error,
              identity: null,
              isHydrating: false,
              registration: null,
              status: "error",
            });
          })
        ),
        Effect.result
      );
      const operation = runOperation(effect, () => {
        createOperation = null;
      });
      createOperation = operation;
      return operation;
    },

    hydrate: () => {
      if (resetOperation || get().status === "resetting") {
        return Promise.resolve();
      }
      const generation = loadGeneration + 1;
      loadGeneration = generation;
      if (get().status === "loading") {
        set(initialState);
      } else {
        set({ isHydrating: true });
      }
      return Effect.runPromise(
        loadLocalIdentity().pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                if (loadGeneration === generation) {
                  set({
                    error,
                    identity: null,
                    isHydrating: false,
                    registration: null,
                    status: "error",
                  });
                }
              }),
            onSuccess: (identity) =>
              identity === null
                ? Effect.sync(() => {
                    if (loadGeneration === generation) {
                      set(stateForIdentity(null));
                    }
                  })
                : loadLocalRegistration().pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.sync(() => {
                          if (loadGeneration === generation) {
                            set({
                              error: makeIdentityVaultError(
                                error.operation === "decode" ||
                                  error.operation === "verify"
                                  ? "decode"
                                  : "read"
                              ),
                              identity,
                              isHydrating: false,
                              registration: null,
                              status: "error",
                            });
                          }
                        }),
                      onSuccess: (loadedRegistration) =>
                        Effect.sync(() => {
                          if (loadGeneration === generation) {
                            set(stateForIdentity(identity, loadedRegistration));
                          }
                        }),
                    })
                  ),
          })
        )
      );
    },

    resetIdentity: () => {
      if (resetOperation) {
        return resetOperation;
      }

      loadGeneration += 1;
      set({ error: null, isHydrating: false, status: "resetting" });
      const effect = Effect.tryPromise({
        catch: () => makeIdentityVaultError("delete"),
        try: async () => {
          await createOperation;
          await backupStateOperation;
          await stopP2p();
          await deleteAllData();
        },
      }).pipe(
        Effect.andThen(deleteLocalRegistration()),
        Effect.mapError(() => makeIdentityVaultError("delete")),
        Effect.andThen(deleteLocalIdentity()),
        Effect.tap(() =>
          Effect.sync(() => {
            set(stateForIdentity(null));
          })
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            set({
              error,
              identity: null,
              isHydrating: false,
              registration: null,
              status: "error",
            });
          })
        ),
        Effect.result
      );
      const operation = runOperation(effect, () => {
        resetOperation = null;
      });
      resetOperation = operation;
      return operation;
    },

    retryLoad: () => {
      void get().hydrate();
    },

    revealRecoveryKey: () =>
      Effect.runPromise(revealLocalIdentityRecoveryKey().pipe(Effect.result)),

    setBackupState: (backupState) => {
      if (backupStateOperation) {
        return backupStateOperation;
      }

      const { identity } = get();
      if (!identity || resetOperation || get().status === "resetting") {
        return Effect.runPromise(
          Effect.fail(makeIdentityVaultError("missing-identity")).pipe(
            Effect.result
          )
        );
      }

      const effect = updateLocalIdentityBackupState(backupState).pipe(
        Effect.tap((updatedIdentity) =>
          Effect.sync(() => {
            if (resetOperation) {
              return;
            }
            set({
              error: null,
              identity: updatedIdentity,
              status:
                get().registration?.status === "confirmed"
                  ? "ready"
                  : "unregistered",
            });
          })
        )
      );
      const operation = runOperation(
        effect.pipe(Effect.asVoid, Effect.result),
        () => {
          backupStateOperation = null;
        }
      );
      backupStateOperation = operation;
      return operation;
    },
  }));
};
