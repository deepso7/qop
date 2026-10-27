import { Effect, Result } from "effect";
import { create } from "zustand";

import type {
  createIdentityVault,
  IdentityBackupState,
  IdentityVaultError,
  LocalIdentity,
} from "@/lib/identity-vault-core";
import type {
  createLocalEnrollment,
  LocalEnrollment,
} from "@/lib/local-enrollment-core";
import type {
  createLocalRegistration,
  LocalRegistration,
} from "@/lib/local-registration-core";

export type IdentityStatus =
  | "absent"
  | "backup"
  | "creating"
  // A restored identity whose device isn't confirmed on its account yet.
  | "enrolling"
  | "error"
  | "loading"
  | "ready"
  | "resetting"
  | "unregistered";

type IdentityResult<A> = Result.Result<A, IdentityVaultError>;

interface IdentityState {
  enrollment: LocalEnrollment | null;
  error: IdentityVaultError | null;
  identity: LocalIdentity | null;
  isHydrating: boolean;
  // The account's qid once this phone belongs to it, by registration or enrollment.
  qid: string | null;
  registration: LocalRegistration | null;
  status: IdentityStatus;
}

interface IdentityActions {
  createIdentity: (handle: string) => Promise<IdentityResult<LocalIdentity>>;
  // Imports an existing account's recovery key with a new device key; the
  // caller then enrolls the device (local-enrollment).
  restoreIdentity: (
    recoveryKey: string,
    handle: string
  ) => Promise<IdentityResult<LocalIdentity>>;
  setBackupState: (
    backupState: Exclude<IdentityBackupState, "pending">
  ) => Promise<IdentityResult<void>>;
  hydrate: () => Promise<void>;
  revealRecoveryKey: () => Promise<IdentityResult<string>>;
  resetIdentity: () => Promise<IdentityResult<void>>;
  retryLoad: () => void;
}

type IdentityStore = IdentityActions & IdentityState;

const empty = {
  enrollment: null,
  identity: null,
  qid: null,
  registration: null,
} as const;

const initialState: IdentityState = {
  ...empty,
  error: null,
  isHydrating: true,
  status: "loading",
};

// Create order: register the handle first, then back up the recovery key, so a
// key is only ever shown for a handle that is actually registered. A restored
// identity starts backed up (the user brought the key), which is also how an
// identity without any record is told apart from an unfinished create.
const stateForIdentity = (
  identity: LocalIdentity | null,
  registration: LocalRegistration | null = null,
  enrollment: LocalEnrollment | null = null
): IdentityState => {
  let qid: string | null = null;

  if (registration?.status === "confirmed") {
    ({ qid } = registration);
  } else if (enrollment?.status === "confirmed") {
    ({ qid } = enrollment);
  }

  let status: IdentityStatus = "ready";

  if (identity === null) {
    status = "absent";
  } else if (qid === null) {
    status =
      enrollment || identity.backupState !== "pending"
        ? "enrolling"
        : "unregistered";
  } else if (identity.backupState === "pending") {
    status = "backup";
  }

  return {
    enrollment,
    error: null,
    identity,
    isHydrating: false,
    qid,
    registration,
    status,
  };
};

const failedState = (error: IdentityVaultError): IdentityState => ({
  ...empty,
  error,
  isHydrating: false,
  status: "error",
});

export interface IdentityStoreDependencies {
  readonly deleteAllData: () => Promise<void>;
  readonly enrollment: Pick<
    ReturnType<typeof createLocalEnrollment>,
    "deleteLocalEnrollment" | "loadLocalEnrollment"
  >;
  readonly identityVault: Pick<
    ReturnType<typeof createIdentityVault>,
    | "createLocalIdentity"
    | "deleteLocalIdentity"
    | "importLocalIdentity"
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
  enrollment: enrollmentStore,
  identityVault,
  makeIdentityVaultError,
  registration,
  stopP2p,
}: IdentityStoreDependencies) => {
  const {
    createLocalIdentity,
    deleteLocalIdentity,
    importLocalIdentity,
    loadLocalIdentity,
    revealLocalIdentityRecoveryKey,
    updateLocalIdentityBackupState,
  } = identityVault;

  const { deleteLocalRegistration, loadLocalRegistration } = registration;
  const { deleteLocalEnrollment, loadLocalEnrollment } = enrollmentStore;
  let loadGeneration = 0;
  let createOperation: Promise<IdentityResult<LocalIdentity>> | null = null;
  let backupStateOperation: Promise<IdentityResult<void>> | null = null;
  let resetOperation: Promise<IdentityResult<void>> | null = null;

  return create<IdentityStore>((set, get) => {
    // Shared by create and restore: one vault write at a time, and the store
    // shows "creating" until it lands (or the vault error screen if it fails).
    const writeIdentity = (
      write: () => Effect.Effect<LocalIdentity, IdentityVaultError>
    ) => {
      if (resetOperation || get().status === "resetting") {
        return Promise.resolve(Result.fail(makeIdentityVaultError("create")));
      }

      if (createOperation) {
        return createOperation;
      }

      loadGeneration += 1;
      set({ ...empty, error: null, isHydrating: false, status: "creating" });

      const operation = runOperation(
        write().pipe(
          Effect.tap((identity) =>
            Effect.sync(() => {
              if (!resetOperation) {
                set(stateForIdentity(identity));
              }
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (!resetOperation) {
                set(failedState(error));
              }
            })
          ),
          Effect.result
        ),
        () => {
          createOperation = null;
        }
      );

      createOperation = operation;

      return operation;
    };

    return {
      ...initialState,

      createIdentity: (handle) =>
        writeIdentity(() => createLocalIdentity(handle)),

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

        const current = () => loadGeneration === generation;

        return Effect.runPromise(
          loadLocalIdentity().pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.sync(() => {
                  if (current()) {
                    set(failedState(error));
                  }
                }),
              onSuccess: (identity) =>
                identity === null
                  ? Effect.sync(() => {
                      if (current()) {
                        set(stateForIdentity(null));
                      }
                    })
                  : Effect.all([
                      loadLocalRegistration(),
                      loadLocalEnrollment(),
                    ]).pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          Effect.sync(() => {
                            if (current()) {
                              set({
                                ...failedState(
                                  makeIdentityVaultError(
                                    error.operation === "decode" ||
                                      error.operation === "verify"
                                      ? "decode"
                                      : "read"
                                  )
                                ),
                                identity,
                              });
                            }
                          }),
                        onSuccess: ([loadedRegistration, loadedEnrollment]) =>
                          Effect.sync(() => {
                            if (current()) {
                              set(
                                stateForIdentity(
                                  identity,
                                  loadedRegistration,
                                  loadedEnrollment
                                )
                              );
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
          Effect.andThen(deleteLocalEnrollment()),
          Effect.mapError(() => makeIdentityVaultError("delete")),
          Effect.andThen(deleteLocalIdentity()),
          Effect.tap(() =>
            Effect.sync(() => {
              set(stateForIdentity(null));
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              set(failedState(error));
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

      restoreIdentity: (recoveryKey, handle) =>
        writeIdentity(() => importLocalIdentity(recoveryKey, handle)),

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
          return Promise.resolve(
            Result.fail(makeIdentityVaultError("missing-identity"))
          );
        }

        const effect = updateLocalIdentityBackupState(backupState).pipe(
          Effect.tap((updatedIdentity) =>
            Effect.sync(() => {
              if (!resetOperation) {
                const state = get();

                set(
                  stateForIdentity(
                    updatedIdentity,
                    state.registration,
                    state.enrollment
                  )
                );
              }
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
    };
  });
};
