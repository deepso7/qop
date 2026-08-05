# @qop/api

QOP's general-purpose API service.

The current scaffold exports a schema-validated `Env` service and an API version marker. HTTP routes and persistence will be added as the service is implemented.

The API depends on `@qop/identity`; transport and persistence implementations remain service-local.
