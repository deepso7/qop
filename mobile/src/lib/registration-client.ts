import { fetch } from "expo/fetch";

import { createRegistrationClient } from "./registration-client-core";

export {
  createRegistrationClient,
  RegistrationClientError,
} from "./registration-client-core";
export type {
  RegisterInput,
  RegisteredRegistration,
  Registration,
  RegistrationClientDependencies,
} from "./registration-client-core";

export const { getRegistration, register } = createRegistrationClient({
  fetch,
});
