import { startMockServer } from './server.js';

/** `pnpm mock`: the mock gateway and authorize page, with the variables that point the CLI at it. */
const port = Number(process.env.PORT || 0) || undefined;
const mock = await startMockServer({ port });
process.stdout.write(`Yomi mock gateway listening on ${mock.origin}

In another terminal:
  export YOMI_API_ORIGIN=${mock.origin} YOMI_WEB_ORIGIN=${mock.origin} YOMI_CONFIG_DIR=$(mktemp -d) YOMI_CREDENTIAL_STORE=file
  node dist/cli.js login
  node dist/cli.js whoami
  node dist/cli.js create -f examples/character.yaml
  node dist/cli.js preview -f examples/character.yaml

Ctrl+C stops it.
`);
process.on('SIGINT', () => {
  void mock.close().then(() => process.exit(0));
});
