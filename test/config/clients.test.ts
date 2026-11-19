import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadClients } from "../../src/config/clients.ts";

function write(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "clients-"));
  const path = join(dir, "clients.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadClients", () => {
  test("reads public and confidential clients", () => {
    const path = write([
      {
        client_id: "web",
        client_secret: "s3cret",
        redirect_uris: ["https://app.example.com/cb"],
        post_logout_redirect_uris: ["https://app.example.com/"],
      },
      {
        client_id: "spa",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost:5173/cb", "http://127.0.0.1:5173/cb"],
      },
    ]);
    const clients = loadClients(path);
    assert.equal(clients.length, 2);
    assert.equal(clients[0]?.client_id, "web");
    assert.equal(clients[0]?.client_secret, "s3cret");
    assert.deepEqual(clients[0]?.post_logout_redirect_uris, ["https://app.example.com/"]);
    assert.equal(clients[1]?.token_endpoint_auth_method, "none");
    assert.equal(clients[1]?.client_secret, undefined);
  });

  test("reads an optional client_name", () => {
    const clients = loadClients(
      write([
        {
          client_id: "a",
          client_secret: "x",
          redirect_uris: ["https://a.example/cb"],
          client_name: "App A",
        },
        { client_id: "b", client_secret: "x", redirect_uris: ["https://b.example/cb"] },
      ]),
    );
    assert.equal(clients[0]?.client_name, "App A");
    assert.equal("client_name" in (clients[1] ?? {}), false);
  });

  test("rejects an empty or non-string client_name", () => {
    for (const client_name of ["", 42]) {
      assert.throws(
        () =>
          loadClients(
            write([
              {
                client_id: "a",
                client_secret: "x",
                redirect_uris: ["https://a.example/cb"],
                client_name,
              },
            ]),
          ),
        /Client "a" client_name must be a non-empty string/,
      );
    }
  });

  test("rejects missing redirect_uris", () => {
    assert.throws(
      () => loadClients(write([{ client_id: "a", client_secret: "x" }])),
      /redirect_uris/,
    );
    assert.throws(
      () => loadClients(write([{ client_id: "a", client_secret: "x", redirect_uris: [] }])),
      /redirect_uris/,
    );
  });

  test("rejects confidential client without client_secret", () => {
    assert.throws(
      () => loadClients(write([{ client_id: "a", redirect_uris: ["https://a.example/cb"] }])),
      /client_secret/,
    );
    assert.throws(
      () =>
        loadClients(
          write([
            {
              client_id: "a",
              token_endpoint_auth_method: "client_secret_post",
              redirect_uris: ["https://a.example/cb"],
            },
          ]),
        ),
      /client_secret/,
    );
  });

  test("rejects duplicate client_id", () => {
    const client = { client_id: "a", client_secret: "x", redirect_uris: ["https://a.example/cb"] };
    assert.throws(() => loadClients(write([client, client])), /duplicate.*a/i);
  });

  test("rejects insecure or malformed redirect URIs", () => {
    for (const uri of [
      "http://app.example.com/cb",
      "ftp://a.example/cb",
      "not a url",
      "myapp://cb",
    ]) {
      assert.throws(
        () => loadClients(write([{ client_id: "a", client_secret: "x", redirect_uris: [uri] }])),
        /redirect/i,
        uri,
      );
    }
  });

  test("rejects non-array and invalid JSON", () => {
    assert.throws(() => loadClients(write({ client_id: "a" })), /array/i);
    assert.throws(() => loadClients(write("{nope")), /JSON/);
  });
});
