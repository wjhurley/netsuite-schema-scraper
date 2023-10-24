import type { Config } from '@jest/types';

// Sync object
const config: Config.InitialOptions = {
    coverageThreshold: {
        global: {
            branches: 100,
            functions: 100,
            lines: 100,
            statements: 0,
        },
    },
    moduleNameMapper: {
        '^src/(.*)$': '<rootDir>/src/$1',
        '^test/(.*)$': '<rootDir>/test/$1',
    },
    verbose: true,
};

export { config };

// Or async function
export default async (): Promise<Config.InitialOptions> => ({
    ...config,
});
