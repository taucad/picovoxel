import { dotnet } from './_framework/dotnet.js'

const args = globalThis.process ? process.argv.slice(2) : [];
const runtime = await dotnet.withApplicationArguments(...args).create();
await runtime.runMainAndExit();
