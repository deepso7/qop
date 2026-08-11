import { Effect } from "effect";
import type { Result } from "effect";
import { create } from "zustand";

import {
  createLocalIdentity,
  finishLocalIdentityOnboarding,
  loadLocalIdentity,
} from "@/lib/identity-vault";
import type {
  IdentityBackupState,
  IdentityVaultError,
  LocalIdentity,
} from "@/lib/identity-vault";

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
  status: IdentityStatus;
}

interface IdentityActions {
  createIdentity: (handle: string) => Promise<IdentityResult<LocalIdentity>>;
  finishOnboarding: (
    backupState: Exclude<IdentityBackupState, "pending">
  ) => Promise<IdentityResult<void>>;
  hydrate: () => Promise<void>;
  retryLoad: () => void;
}

type IdentityStore = IdentityActions & IdentityState;

const initialState: IdentityState = {
  error: null,
  identity: null,
  status: "loading",
};

const stateForIdentity = (identity: LocalIdentity | null): IdentityState => {
  let status: IdentityStatus = "ready";
  if (identity === null) {
    status = "absent";
  } else if (identity.backupState === "pending") {
    status = "backup";
  }
  return { error: null, identity, status };
};

let loadGeneration = 0;
let createOperation: Promise<IdentityResult<LocalIdentity>> | null = null;
let finishOperation: Promise<IdentityResult<void>> | null = null;

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
    set({ error: null, identity: null, status: "creating" });
    const effect = createLocalIdentity(handle).pipe(
      Effect.tap((identity) =>
        Effect.sync(() => {
          set({ error: null, identity, status: "backup" });
        })
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          set({ error, identity: null, status: "error" });
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
      return Effect.runPromise(Effect.void.pipe(Effect.result));
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
    set(initialState);
    return Effect.runPromise(
      loadLocalIdentity().pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              if (loadGeneration === generation) {
                set({ error, identity: null, status: "error" });
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

  retryLoad: () => {
    void get().hydrate();
  },
}));
