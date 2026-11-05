import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'release/', 'node_modules/', 'scripts/'] },
  ...tseslint.configs.recommended,
  {
    // Data flows one way: signals -> state -> (integrations | mcp | timeline).
    files: ['src/state/**', 'src/integrations/**', 'src/mcp/**', 'src/timeline/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/signals/**', '@smartspectra/*'] }],
    },
  },
);
