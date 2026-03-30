import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { AppState, ContactRecord, emptyState } from './types';
import { getEnv } from '../common/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly sqlitePath = getEnv().sqlitePath;
  private readonly legacyDataFilePath = getEnv().legacyDataFilePath;
  private database?: DatabaseSync;
  private initPromise?: Promise<void>;
  private queue = Promise.resolve();

  async read(): Promise<AppState> {
    await this.ensureReady();
    const row = this.database!.prepare(
      'SELECT state_json FROM app_state WHERE id = 1',
    ).get() as { state_json: string } | undefined;

    return row ? hydrateState(JSON.parse(row.state_json) as Partial<AppState>) : emptyState();
  }

  async write(mutator: (state: AppState) => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      const state = await this.read();
      await mutator(state);
      this.database!
        .prepare(
          `INSERT INTO app_state (id, state_json, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(state, null, 2), new Date().toISOString());
    });

    return this.queue;
  }

  onModuleDestroy(): void {
    this.database?.close();
    this.database = undefined;
  }

  private async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }

    await this.initPromise;
  }

  private async init(): Promise<void> {
    const directory = dirname(this.sqlitePath);
    await mkdir(directory, { recursive: true });
    this.database = new DatabaseSync(this.sqlitePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const row = this.database
      .prepare('SELECT id FROM app_state WHERE id = 1')
      .get() as { id: number } | undefined;
    if (row) {
      return;
    }

    const initialState = await this.readLegacyState();
    this.database
      .prepare('INSERT INTO app_state (id, state_json, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(initialState, null, 2), new Date().toISOString());
  }

  private async readLegacyState(): Promise<AppState> {
    if (!existsSync(this.legacyDataFilePath)) {
      return emptyState();
    }

    try {
      const content = await readFile(this.legacyDataFilePath, 'utf8');
      return hydrateState(JSON.parse(content) as Partial<AppState>);
    } catch {
      return emptyState();
    }
  }
}

const hydrateState = (state: Partial<AppState>): AppState => ({
  ...emptyState(),
  ...state,
  contacts: (state.contacts ?? []).map(hydrateContact),
});

const hydrateContact = (contact: ContactRecord): ContactRecord => ({
  ...contact,
  clientName: contact.clientName ?? null,
  category: contact.category ?? null,
  recordStatus: contact.recordStatus ?? 'active',
  importedAt: contact.importedAt ?? contact.createdAt ?? null,
});
