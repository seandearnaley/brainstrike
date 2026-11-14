# Decisions

## Listening port

The service moves off port 3000, which the local proxy already holds. After
comparing 8080 (taken by the metrics sidecar) and 9443 (reserved for the admin
console), we settled on **8443**. The constant lives in `src/server.ts`.
