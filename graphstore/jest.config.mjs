/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/tests"],
  moduleNameMapper: {
    // resolve workspace packages to TS source so tests need no prebuild
    "^@peritze/graphstore$": "<rootDir>/src/index.ts",
    "^@peritze/vectorstore$": "<rootDir>/../vectorstore/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
