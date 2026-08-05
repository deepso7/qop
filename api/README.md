# @qop/api

QOP's general-purpose API service.

Its initial surface covers identity enrollment, discovery, pairing capabilities, device observation, and sessions. Future non-identity API routes belong here as the product expands.

The API depends on `@qop/identity` for portable protocol models; transport and persistence implementations remain service-local.
