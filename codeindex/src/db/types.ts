// the SQL connection abstraction now lives once in @peritze/vectorstore;
// codeindex re-exports it so its own modules (FileConnection, migrate, repos) keep one import path
export type { DbConnection, DbConnectionFactory, QueryResult } from '@peritze/vectorstore';
