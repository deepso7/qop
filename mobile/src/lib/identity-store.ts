import { Effect } from "effect";
import type { Result } from "effect";
import { create } from "zustand";

import {
  createLocalIdentity,
  deleteLocalIdentity,
  finishLocalIdentityOnboarding,
  IdentityVaultError,
  loadLocalIdentity,
} from "@/lib/identity-vault";
import type { IdentityBackupState, LocalIdentity } from "@/lib/identity-vault";

type IdentityStatus =
  | "absent"
  | "backup"
  | "creating"
  | "error"
  | "loading"
  | "ready";

type IdentityResult<A> = Result.Result<A, IdentityVaultError>;

interface IdentityState {
  error: IdentityVaultError | null;
  identity: LocalIdentity | null;
  isHydrating: boolean;
  status: IdentityStatus;
}

interface IdentityActions {
  createIdentity: (handle: string) => Promise<IdentityResult<LocalIdentity>>;
  finishOnboarding: (
    backupState: Exclude<IdentityBackupState, "pending">
  ) => Promise<IdentityResult<void>>;
  hydrate: () => Promise<void>;
  resetIdentity: () => Promise<IdentityResult<void>>;
  retryLoad: () => void;
}

type IdentityStore = IdentityActions & IdentityState;

const initialState: IdentityState = {
  error: null,
  identity: null,
  isHydrating: true,
  status: "loading",
};

const stateForIdentity = (identity: LocalIdentity | null): IdentityState => {
  let status: IdentityStatus = "ready";
  if (identity === null) {
    status = "absent";
  } else if (identity.backupState === "pending") {
    status = "backup";
  }
  return { error: null, identity, isHydrating: false, status };
};

let loadGeneration = 0;
let createOperation: Promise<IdentityResult<LocalIdentity>> | null = null;
let finishOperation: Promise<IdentityResult<void>> | null = null;
let resetOperation: Promise<IdentityResult<void>> | null = null;

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

export const useIdentityStore = create<IdentityStore>((set, get) => ({
  ...initialState,

  createIdentity: (handle) => {
    if (createOperation) {
      return createOperation;
    }

    loadGeneration += 1;
    set({
      error: null,
      identity: null,
      isHydrating: false,
      status: "creating",
    });
    const effect = createLocalIdentity(handle).pipe(
      Effect.tap((identity) =>
        Effect.sync(() => {
          set({
            error: null,
            identity,
            isHydrating: false,
            status: "backup",
          });
        })
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          set({ error, identity: null, isHydrating: false, status: "error" });
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

  finishOnboarding: (backupState) => {
    if (finishOperation) {
      return finishOperation;
    }

    const { identity } = get();
    if (!identity) {
      return Effect.runPromise(
        Effect.fail(
          new IdentityVaultError({ operation: "missing-identity" })
        ).pipe(Effect.result)
      );
    }

    const effect = finishLocalIdentityOnboarding(identity, backupState).pipe(
      Effect.tap((updatedIdentity) =>
        Effect.sync(() => {
          set({ error: null, identity: updatedIdentity, status: "ready" });
        })
      )
    );
    const operation = runOperation(
      effect.pipe(Effect.asVoid, Effect.result),
      () => {
        finishOperation = null;
      }
    );
    finishOperation = operation;
    return operation;
  },

  hydrate: () => {
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
                  status: "error",
                });
              }
            }),
          onSuccess: (identity) =>
            Effect.sync(() => {
              if (loadGeneration === generation) {
                set(stateForIdentity(identity));
              }
            }),
        })
      )
    );
  },

  resetIdentity: () => {
    if (resetOperation) {
      return resetOperation;
    }

    loadGeneration += 1;
    const effect = deleteLocalIdentity().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          set(stateForIdentity(null));
        })
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          set({ error, identity: null, isHydrating: false, status: "error" });
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
}));
