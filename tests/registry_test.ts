import { assertEquals, assertExists } from "@std/assert";
import { Registry } from "../src/registry.ts";
import type { RepositoryRecord } from "../src/types.ts";

function pauseNextRepositoryReads(kv: Deno.Kv, readCount: number): void {
  const originalGet = kv.get.bind(kv);
  let reads = 0;
  let releaseReads!: () => void;
  const allRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });

  kv.get = new Proxy(originalGet, {
    async apply(_target, _thisArg, argumentsList) {
      const entry = await Reflect.apply(originalGet, undefined, argumentsList);
      const [key] = argumentsList;
      if (
        reads < readCount &&
        Array.isArray(key) &&
        key.length === 2 &&
        key[0] === "repositories"
      ) {
        reads++;
        if (reads === readCount) releaseReads();
        await allRead;
      }
      return entry;
    },
  });
}

Deno.test("registry upserts, retrieves, and lists plain repository records", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const first: RepositoryRecord = {
      id: 1,
      installationId: 10,
      owner: "octocat",
      repo: "first",
      defaultBranch: "main",
      suspended: false,
    };
    const second: RepositoryRecord = {
      id: 2,
      installationId: 20,
      owner: "octocat",
      repo: "second",
      defaultBranch: "trunk",
      suspended: true,
    };

    assertEquals(await registry.getRepository(1), null);
    await registry.upsertRepository(first);
    await registry.upsertRepository(second);

    assertEquals(await registry.getRepository(1), first);
    assertEquals(await registry.listRepositories(), [first, second]);
  } finally {
    kv.close();
  }
});

Deno.test("registry filters installations and removes stale indexes on update", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const original: RepositoryRecord = {
      id: 42,
      installationId: 10,
      owner: "octocat",
      repo: "example",
      defaultBranch: "main",
      suspended: false,
    };
    const other: RepositoryRecord = {
      id: 43,
      installationId: 10,
      owner: "octocat",
      repo: "other",
      defaultBranch: "main",
      suspended: false,
    };
    const moved: RepositoryRecord = {
      ...original,
      installationId: 20,
      defaultBranch: "trunk",
    };

    await registry.upsertRepository(original);
    await registry.upsertRepository(other);
    assertEquals(await registry.listRepositories(10), [original, other]);

    await registry.upsertRepository(moved);

    assertEquals(await registry.getRepository(42), moved);
    assertEquals(await registry.listRepositories(10), [other]);
    assertEquals(await registry.listRepositories(20), [moved]);
    assertEquals(await registry.listRepositories(), [moved, other]);
  } finally {
    kv.close();
  }
});

Deno.test("concurrent repository updates leave no stale installation indexes", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const original: RepositoryRecord = {
      id: 42,
      installationId: 10,
      owner: "octocat",
      repo: "example",
      defaultBranch: "main",
      suspended: false,
    };
    const firstUpdate = { ...original, installationId: 20 };
    const secondUpdate = { ...original, installationId: 30 };
    await registry.upsertRepository(original);
    pauseNextRepositoryReads(kv, 2);

    await Promise.all([
      registry.upsertRepository(firstUpdate),
      registry.upsertRepository(secondUpdate),
    ]);

    const winner = await registry.getRepository(42);
    assertExists(winner);
    assertEquals(await registry.listRepositories(), [winner]);
    assertEquals(await registry.listRepositories(10), []);
    assertEquals(
      [
        ...await registry.listRepositories(20),
        ...await registry.listRepositories(30),
      ],
      [winner],
    );
  } finally {
    kv.close();
  }
});

Deno.test("concurrent remove and upsert leave no orphaned installation index", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const original: RepositoryRecord = {
      id: 42,
      installationId: 10,
      owner: "octocat",
      repo: "example",
      defaultBranch: "main",
      suspended: false,
    };
    const moved = { ...original, installationId: 20 };
    await registry.upsertRepository(original);

    const originalGet = kv.get.bind(kv);
    let signalRemoveRead!: () => void;
    const removeRead = new Promise<void>((resolve) => {
      signalRemoveRead = resolve;
    });
    let unblockRemove!: () => void;
    const removeCanFinish = new Promise<void>((resolve) => {
      unblockRemove = resolve;
    });
    let repositoryReads = 0;
    kv.get = new Proxy(originalGet, {
      async apply(_target, _thisArg, argumentsList) {
        const entry = await Reflect.apply(
          originalGet,
          undefined,
          argumentsList,
        );
        const [key] = argumentsList;
        if (
          Array.isArray(key) &&
          key.length === 2 &&
          key[0] === "repositories" &&
          ++repositoryReads === 1
        ) {
          signalRemoveRead();
          await removeCanFinish;
        }
        return entry;
      },
    });

    const removal = registry.removeRepository(42);
    await removeRead;
    await registry.upsertRepository(moved);
    unblockRemove();
    await removal;

    assertEquals(await registry.getRepository(42), null);
    assertEquals(await registry.listRepositories(), []);
    assertEquals(await registry.listRepositories(10), []);
    assertEquals(await registry.listRepositories(20), []);
  } finally {
    kv.close();
  }
});

Deno.test("registry removes repository primary and secondary records", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const repository: RepositoryRecord = {
      id: 42,
      installationId: 10,
      owner: "octocat",
      repo: "example",
      defaultBranch: "main",
      suspended: false,
    };
    await registry.upsertRepository(repository);

    await registry.removeRepository(42);

    assertEquals(await registry.getRepository(42), null);
    assertEquals(await registry.listRepositories(), []);
    assertEquals(await registry.listRepositories(10), []);
    await registry.removeRepository(42);
  } finally {
    kv.close();
  }
});

Deno.test("registry deduplicates deliveries for seven days", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let expireIn: number | undefined;
    const originalAtomic = kv.atomic.bind(kv);
    kv.atomic = () => {
      const atomic = originalAtomic();
      const originalSet = atomic.set.bind(atomic);
      atomic.set = (key, value, options) => {
        expireIn = options?.expireIn;
        return originalSet(key, value, options);
      };
      return atomic;
    };
    const registry = new Registry(kv);

    assertEquals(await registry.wasDeliveryProcessed("delivery-123"), false);
    await registry.markDeliveryProcessed("delivery-123");

    assertEquals(await registry.wasDeliveryProcessed("delivery-123"), true);
    assertEquals(expireIn, 7 * 24 * 60 * 60 * 1000);
  } finally {
    kv.close();
  }
});

Deno.test("only one repository lease can be acquired", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    const first = await registry.acquireLease(42, "delivery-a", 60_000);
    const second = await registry.acquireLease(42, "delivery-b", 60_000);
    assertEquals(first, true);
    assertEquals(second, false);
    await registry.releaseLease(42, "delivery-a");
    assertEquals(await registry.acquireLease(42, "delivery-b", 60_000), true);
  } finally {
    kv.close();
  }
});

Deno.test("one owner cannot release another owner's lease", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const registry = new Registry(kv);
    assertEquals(await registry.acquireLease(42, "delivery-a", 60_000), true);

    await registry.releaseLease(42, "delivery-b");

    assertEquals(await registry.acquireLease(42, "delivery-c", 60_000), false);
    await registry.releaseLease(42, "delivery-a");
    assertEquals(await registry.acquireLease(42, "delivery-c", 60_000), true);
  } finally {
    kv.close();
  }
});
