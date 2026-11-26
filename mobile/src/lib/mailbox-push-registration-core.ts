const REFRESH_MS = 24 * 60 * 60 * 1000;
const INITIAL_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;

export const createMailboxPushRegistration = ({
  isActive,
  register,
}: {
  readonly isActive: () => boolean;
  readonly register: (canRegister: () => boolean) => Promise<boolean>;
}) => {
  let stopped = false;
  let running = false;
  let tokenVersion = 0;
  let nextRefresh = 0;
  let retryMs = INITIAL_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const canRegister = () => !stopped && isActive();

  const refresh = () => {
    clearTimeout(timer);

    if (running || !canRegister()) {
      return;
    }

    const waitMs = nextRefresh - Date.now();

    if (waitMs > 0) {
      timer = setTimeout(refresh, waitMs);

      return;
    }

    const version = tokenVersion;
    running = true;

    const run = async () => {
      const registered = await register(canRegister).catch(() => false);

      if (version === tokenVersion) {
        nextRefresh = Date.now() + (registered ? REFRESH_MS : retryMs);
        retryMs = registered
          ? INITIAL_RETRY_MS
          : Math.min(retryMs * 2, MAX_RETRY_MS);
      }

      running = false;
      refresh();
    };

    void run();
  };

  return {
    refresh,
    reset: () => {
      tokenVersion += 1;
      nextRefresh = 0;
      retryMs = INITIAL_RETRY_MS;
      refresh();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
