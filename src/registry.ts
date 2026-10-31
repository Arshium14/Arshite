import type { RepositoryRecord } from "./types.ts";

const DELIVERY_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

interface Lease {
  owner: string;
}

export class Registry {
  constructor(private readonly kv: Deno.Kv) {}

  async upsertRepository(record: RepositoryRecord): Promise<void> {
    const primaryKey = ["repositories", record.id];
    const secondaryKey = [
      "installations",
      record.installationId,
      "repositories",
      record.id,
    ];

    while (true) {
      const previous = await this.kv.get<RepositoryRecord>(primaryKey);
      const operation = this.kv.atomic()
        .check({ key: primaryKey, versionstamp: previous.versionstamp })
        .set(primaryKey, record)
        .set(secondaryKey, record);

      if (
        previous.value !== null &&
        previous.value.installationId !== record.installationId
      ) {
        operation.delete([
          "installations",
          previous.value.installationId,
          "repositories",
          record.id,
        ]);
      }

      const result = await operation.commit();
      if (result.ok) return;
    }
  }

  async removeRepository(repoId: number): Promise<void> {
    const primaryKey = ["repositories", repoId];

    while (true) {
      const existing = await this.kv.get<RepositoryRecord>(primaryKey);
      if (existing.value === null) return;

      const result = await this.kv.atomic()
        .check({ key: primaryKey, versionstamp: existing.versionstamp })
        .delete(primaryKey)
        .delete([
          "installations",
          existing.value.installationId,
          "repositories",
          repoId,
        ])
        .commit();
      if (result.ok) return;
    }
  }

  async getRepository(repoId: number): Promise<RepositoryRecord | null> {
    const entry = await this.kv.get<RepositoryRecord>(["repositories", repoId]);
    return entry.value;
  }

  async listRepositories(installationId?: number): Promise<RepositoryRecord[]> {
    const prefix = installationId === undefined
      ? ["repositories"]
      : ["installations", installationId, "repositories"];
    const repositories: RepositoryRecord[] = [];

    for await (const entry of this.kv.list<RepositoryRecord>({ prefix })) {
      repositories.push(entry.value);
    }

    return repositories;
  }

  async wasDeliveryProcessed(deliveryId: string): Promise<boolean> {
    const entry = await this.kv.get(["deliveries", deliveryId]);
    return entry.value !== null;
  }

  async markDeliveryProcessed(deliveryId: string): Promise<void> {
    await this.kv.atomic()
      .set(["deliveries", deliveryId], true, {
        expireIn: DELIVERY_EXPIRATION_MS,
      })
      .commit();
  }

  async acquireLease(
    repoId: number,
    owner: string,
    expireIn: number,
  ): Promise<boolean> {
    const key = ["leases", repoId];
    const result = await this.kv.atomic()
      .check({ key, versionstamp: null })
      .set(key, { owner }, { expireIn })
      .commit();
    return result.ok;
  }

  async releaseLease(repoId: number, owner: string): Promise<void> {
    const key = ["leases", repoId];
    const lease = await this.kv.get<Lease>(key);
    if (lease.value?.owner !== owner) return;

    await this.kv.atomic()
      .check({ key, versionstamp: lease.versionstamp })
      .delete(key)
      .commit();
  }
}
