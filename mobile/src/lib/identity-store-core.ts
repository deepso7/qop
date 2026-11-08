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

// Each status carries exactly the data that exists in it, so screens never
// guard against a missing identity or qid.
export type IdentityState =
  | { readonly status: "absent" | "creating" | "loading" | "resetting" }
  | {
      readonly error: IdentityVaultError;
      // A retry is reloading behind the error screen.
      readonly retrying: boolean;
      readonly status: "error";
    }
  | {
      readonly identity: LocalIdentity;
      readonly registration: LocalRegistration | null;
      readonly status: "unregistered";
    }
  | {
      // A restored identity whose device isn't confirmed on its account yet.
      readonly enrollment: LocalEnrollment | null;
      readonly identity: LocalIdentity;
      readonly status: "enrolling";
    }
  | {
      readonly identity: LocalIdentity;
      // The account's qid, by registration or enrollment.
      readonly qid: string;
      // "backup" until a new account's recovery key is saved or skipped.
      readonly status: "backup" | "ready";
    };

export type IdentityStatus = IdentityState["status"];

// An identity that belongs to its account.
export type Account = Extract<IdentityState, { readonly qid: string }>;

type IdentityResult<A> = Result.Result<A, IdentityVaultError>;

interface IdentityActions {
  createIdentity: (handle: string) => Promise<IdentityResult<LocalIdentity>>;
  // Imports an existing account's recovery key with a new device key; the
  // caller then enrolls the device (local-enrollment).
  restoreIdentity: (
    recoveryKey: string,
    handle: string
  ) => Promise<IdentityResult<LocalIdentity>>;
  // Only for an identity that belongs to its account.
  setBackupState: (
    backupState: Exclude<IdentityBackupState, "pending">
  ) => Promise<IdentityResult<void>>;
  hydrate: () => Promise<void>;
  revealRecoveryKey: () => Promise<IdentityResult<string>>;
  resetIdentity: () => Promise<IdentityResult<void>>;
  retryLoad: () => void;
}

type IdentityStore = IdentityActions & IdentityState;

// Selectors for statuses that share data. They return a field or the state
// itself, so zustand sees no change between unrelated updates.
export const selectIdentity = (state: IdentityState) =>
  "identity" in state ? state.identity : null;

export const selectAccount = (state: IdentityState): Account | null =>
  "qid" in state ? state : null;

const accountState = (identity: LocalIdentity, qid: string): Account => ({
  identity,
  qid,
  status: identity.backupState === "pending" ? "backup" : "ready",
});

// Create order: register the handle first, then back up the recovery key, so a
// key is only ever shown for a handle that is actually registered. A restored
// identity starts backed up (the user brought the key), which is also how an
// identity without any record is told apart from an unfinished create.
const stateForIdentity = (
  identity: LocalIdentity | null,
  registration: LocalRegistration | null = null,
  enrollment: LocalEnrollment | null = null
): IdentityState => {
  if (identity === null) {
    return { status: "absent" };
  }

  if (registration?.status === "confirmed") {
    return accountState(identity, registration.qid);
  }

  if (enrollment?.status === "confirmed") {
    return accountState(identity, enrollment.qid);
  }

  return enrollment || identity.backupState !== "pending"
    ? { enrollment, identity, status: "enrolling" }
    : { identity, registration, status: "unregistered" };
};

const failedState = (error: IdentityVaultError): IdentityState => ({
  error,
  retrying: false,
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

  return create<IdentityStore>((set, get, store) => {
    // Replaces the whole state so no field outlives the status it belongs to
    // (zustand's set otherwise merges). The actions come from the initial
    // state, which has no other data.
    const transition = (next: IdentityState) => {
      set({ ...store.getInitialState(), ...next }, true);
    };

    // Shared by create and restore: one vault write at a time, and the store
    // shows "creating" until it lands (or the vault error screen if it fails).
    const writeIdentity = (
      write: () => Effect.Effect<LocalIdentity, IdentityVaultError>
    ) => {
      if (resetOperation) {
        return Promise.resolve(Result.fail(makeIdentityVaultError("create")));
      }

      if (createOperation) {
        return createOperation;
      }

      loadGeneration += 1;
      transition({ status: "creating" });

      const operation = runOperation(
        write().pipe(
          Effect.tap((identity) =>
            Effect.sync(() => {
              if (!resetOperation) {
                transition(stateForIdentity(identity));
              }
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (!resetOperation) {
                transition(failedState(error));
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
      status: "loading",

      createIdentity: (handle) =>
        writeIdentity(() => createLocalIdentity(handle)),

      hydrate: () => {
        if (resetOperation) {
          return Promise.resolve();
        }

        const generation = loadGeneration + 1;
        loadGeneration = generation;
        const state = get();

        // Other statuses stay on screen until the load lands.
        if (state.status === "error") {
          transition({ error: state.error, retrying: true, status: "error" });
        }

        const current = () => loadGeneration === generation;

        return Effect.runPromise(
          loadLocalIdentity().pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.sync(() => {
                  if (current()) {
                    transition(failedState(error));
                  }
                }),
              onSuccess: (identity) =>
                identity === null
                  ? Effect.sync(() => {
                      if (current()) {
                        transition(stateForIdentity(null));
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
                              transition(
                                failedState(
                                  makeIdentityVaultError(
                                    error.operation === "decode" ||
                                      error.operation === "verify"
                                      ? "decode"
                                      : "read"
                                  )
                                )
                              );
                            }
                          }),
                        onSuccess: ([loadedRegistration, loadedEnrollment]) =>
                          Effect.sync(() => {
                            if (current()) {
                              transition(
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
        transition({ status: "resetting" });

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
              transition(stateForIdentity(null));
            })
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              transition(failedState(error));
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

        // Also false while resetting, which has no account.
        if (!selectAccount(get())) {
          return Promise.resolve(
            Result.fail(makeIdentityVaultError("missing-identity"))
          );
        }

        const effect = updateLocalIdentityBackupState(backupState).pipe(
          Effect.tap((updatedIdentity) =>
            Effect.sync(() => {
              const account = selectAccount(get());

              if (account) {
                transition(accountState(updatedIdentity, account.qid));
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
