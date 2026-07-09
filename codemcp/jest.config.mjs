/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    // resolve shared workspace packages to TS source so tests need no prebuild
    "^@peritze/mcp-tool-server$": "<rootDir>/../mcp-tool-server/src/index.ts",
    "^@peritze/mcp-tool-server/(.*)$": "<rootDir>/../mcp-tool-server/src/$1.ts",
    "^@peritze/vectorstore$": "<rootDir>/../vectorstore/src/index.ts",
    "^@peritze/vectorizer$": "<rootDir>/../vectorizer/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
