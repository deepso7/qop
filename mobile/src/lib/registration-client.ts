import { fetch } from "expo/fetch";

import { createRegistrationClient } from "./registration-client-core";

export {
  createRegistrationClient,
  RegistrationClientError,
} from "./registration-client-core";
export type {
  AuthorizedRegistration,
  PrepareRegistrationInput,
  PreparedRegistration,
  ReconciledRegistration,
} from "./registration-client-core";

export const {
  authorizeRegistration,
  prepareRegistration,
  reconcileRegistration,
} = createRegistrationClient({ fetch });
