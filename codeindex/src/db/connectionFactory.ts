// the pg pool/connection implementation is the shared one from @peritze/vectorstore;
// re-exported here so wiring keeps a stable import path after the dedupe
export { PgConnectionFactory } from '@peritze/vectorstore';
