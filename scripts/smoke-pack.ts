// Packs the three packages, installs the tarballs into scratch projects with plain npm and checks
// they work the way a consumer would use them. Run with `pnpm smoke`.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["wallet-login", "oidc", "server"] as const;
const work = mkdtempSync(join(tmpdir(), "op-oidc-smoke-"));
const tarDir = join(work, "tarballs");
mkdirSync(tarDir);

// A typed consumer of each package's main function; tsc must accept it without skipLibCheck.
const CONSUMER = `
import { createWalletLogin, memoryStore, type WalletLoginConfig } from "@open-payments-oidc/wallet-login";
import { createOidcHandler, type OidcHandlerConfig } from "@open-payments-oidc/oidc";
import { startServer, type ServerConfig } from "@open-payments-oidc/server";

const walletConfig: WalletLoginConfig = {
  wallet: { address: "https://wallet.example/op", keyId: "k1", privateKey: "pem" },
  authServerAllowlist: ["https://auth.example"],
  store: memoryStore(),
};
const oidcConfig: OidcHandlerConfig = {
  issuer: "https://op.example",
  clients: [],
  jwks: { keys: [] },
  cookieKeys: ["secret"],
  database: "postgres://localhost/db",
  wallet: walletConfig.wallet,
  authServerAllowlist: walletConfig.authServerAllowlist,
};
const serverConfig: ServerConfig = { ...oidcConfig, port: 0 };

export async function main(): Promise<void> {
  const login = await createWalletLogin(walletConfig);
  await login.close();
  const oidc = await createOidcHandler(oidcConfig);
  await oidc.close();
  const server = await startServer(serverConfig);
  await server.close();
}
`;

const failures: string[] = [];

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    const e = error as { message?: string; stdout?: string; stderr?: string };
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.log(e.stderr);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function project(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  return dir;
}

function install(dir: string, specs: string[]): void {
  sh("npm", ["install", "--no-audit", "--no-fund", ...specs], dir);
}

function run(dir: string, code: string): string {
  return sh("node", ["--input-type=module", "-e", code], dir);
}

const tarballs: Record<string, string> = {};
await check("build and pack the three packages", () => {
  sh("pnpm", ["-r", "build"], root);
  for (const name of names) {
    sh("pnpm", ["pack", "--pack-destination", tarDir], join(root, "packages", name));
  }
  for (const file of readdirSync(tarDir)) {
    const name = names.find((n) => file.startsWith(`open-payments-oidc-${n}-`));
    assert(name, `unexpected tarball ${file}`);
    tarballs[name] = join(tarDir, file);
  }
  for (const name of names) assert(tarballs[name], `no tarball for ${name}`);
});

try {
  if (failures.length > 0) throw new Error("no tarballs to check");
  const tar = (n: (typeof names)[number]): string => tarballs[n] as string;

  await check("wallet-only: imports, no oidc-provider installed", () => {
    const dir = project("wallet-only");
    install(dir, [tar("wallet-login")]);
    const out = run(
      dir,
      `const m = await import("@open-payments-oidc/wallet-login"); console.log(typeof m.createWalletLogin);`,
    );
    assert(out.trim() === "function", `createWalletLogin is ${out.trim()}`);
    assert(
      !existsSync(join(dir, "node_modules", "oidc-provider")),
      "oidc-provider was installed for a wallet-login only consumer",
    );
  });

  const full = project("full");
  let fullInstalled = false;
  await check("full: install all three tarballs", () => {
    install(full, [tar("wallet-login"), tar("oidc"), tar("server")]);
    fullInstalled = true;
  });

  if (fullInstalled) {
    await check("full: each package imports", () => {
      const out = run(
        full,
        `const w = await import("@open-payments-oidc/wallet-login");
         const o = await import("@open-payments-oidc/oidc");
         const s = await import("@open-payments-oidc/server");
         console.log(typeof w.createWalletLogin, typeof o.createOidcHandler, typeof s.startServer);`,
      );
      assert(out.trim() === "function function function", `got: ${out.trim()}`);
    });

    await check("full: a consumer passing --conditions=source still resolves dist", () => {
      const out = sh(
        "node",
        [
          "--conditions=source",
          "--input-type=module",
          "-e",
          `const w = await import("@open-payments-oidc/wallet-login");
           const o = await import("@open-payments-oidc/oidc");
           const s = await import("@open-payments-oidc/server");
           console.log(typeof w.createWalletLogin, typeof o.createOidcHandler, typeof s.startServer);`,
        ],
        full,
      );
      assert(out.trim() === "function function function", `got: ${out.trim()}`);
    });

    await check("full: bin files start with a shebang", () => {
      for (const f of ["bin.js", "generate-jwks.js"]) {
        const text = readFileSync(
          join(full, "node_modules", "@open-payments-oidc", "server", "dist", f),
          "utf8",
        );
        assert(text.startsWith("#!/usr/bin/env node\n"), `${f} lost its shebang`);
      }
    });

    await check("full: open-payments-oidc with empty env exits 1 (ISSUER is required)", () => {
      const bin = join(full, "node_modules", ".bin", "open-payments-oidc");
      const result = spawnSync(bin, [], {
        cwd: full,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      });
      const output = `${result.stdout}${result.stderr}`;
      assert(result.status === 1, `exit status ${result.status}, output: ${output}`);
      assert(output.includes("ISSUER is required"), `output was: ${output}`);
    });

    await check("full: open-payments-oidc-generate-jwks prints one RSA key", () => {
      const bin = join(full, "node_modules", ".bin", "open-payments-oidc-generate-jwks");
      const out = sh(bin, [], full);
      const parsed = JSON.parse(out) as { keys?: { kty?: string }[] };
      assert(Array.isArray(parsed.keys), "no keys array");
      assert(parsed.keys.length === 1, `expected 1 key, got ${parsed.keys.length}`);
      assert(parsed.keys[0]?.kty === "RSA", `kty was ${parsed.keys[0]?.kty}`);
    });
  }

  await check("typecheck: consumer tsc with skipLibCheck false", () => {
    const dir = project("typecheck");
    install(dir, [tar("wallet-login"), tar("oidc"), tar("server")]);
    sh(
      "npm",
      ["install", "--no-audit", "--no-fund", "--save-dev", "typescript", "@types/node@24"],
      dir,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ["node"],
        },
        include: ["index.ts"],
      }),
    );
    writeFileSync(join(dir, "index.ts"), CONSUMER);
    sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], dir);
    // A consumer that sets the generic "source" condition must still land on the published types.
    const withCondition = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
    withCondition.compilerOptions.customConditions = ["source"];
    writeFileSync(join(dir, "tsconfig.cond.json"), JSON.stringify(withCondition));
    sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.cond.json"], dir);
  });
} catch (error) {
  if (failures.length === 0) failures.push(`unexpected: ${(error as Error).message}`);
} finally {
  if (failures.length === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`scratch dir kept at ${work}`);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} smoke check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
