#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Sequence


CONTACT_COLUMNS = [
    "id",
    "external_ref",
    "client_name",
    "first_name",
    "last_name",
    "name",
    "category",
    "record_status",
    "phone_raw",
    "phone_e164",
    "phone_hash",
    "email",
    "attributes_json",
    "is_valid",
    "validation_error",
    "is_opted_out",
    "opted_out_at",
    "opt_out_source",
    "imported_at",
    "created_at",
    "updated_at",
]

LIST_COLUMNS = [
    "id",
    "name",
    "description",
    "source_type",
    "source_file_path",
    "created_at",
    "updated_at",
]

LIST_MEMBER_COLUMNS = [
    "id",
    "list_id",
    "contact_id",
    "created_at",
]

IMPORT_COLUMNS = [
    "id",
    "list_id",
    "file_name",
    "file_sha256",
    "total_rows",
    "valid_rows",
    "invalid_rows",
    "duplicate_rows",
    "field_mapping_json",
    "defaults_json",
    "status",
    "created_at",
]


def sql_literal(value: object, *, force_boolean: bool = False) -> str:
    if value is None:
        return "NULL"
    if force_boolean:
        return "TRUE" if bool(value) else "FALSE"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace("'", "''")
    return f"'{text}'"


def chunked(rows: Sequence[sqlite3.Row], size: int) -> Iterable[Sequence[sqlite3.Row]]:
    for index in range(0, len(rows), size):
        yield rows[index : index + size]


def build_insert_sql(
    table: str,
    columns: Sequence[str],
    rows: Sequence[sqlite3.Row],
    *,
    chunk_size: int = 250,
    boolean_columns: set[str] | None = None,
) -> list[str]:
    statements: list[str] = []
    if not rows:
        return statements

    column_sql = ", ".join(columns)
    boolean_columns = boolean_columns or set()
    for group in chunked(rows, chunk_size):
        values_sql = []
        for row in group:
            values = ", ".join(
                sql_literal(row[column], force_boolean=column in boolean_columns)
                for column in columns
            )
            values_sql.append(f"({values})")
        statements.append(f"INSERT INTO {table} ({column_sql}) VALUES\n  " + ",\n  ".join(values_sql) + ";")
    return statements


def load_rows(connection: sqlite3.Connection, query: str) -> list[sqlite3.Row]:
    cursor = connection.execute(query)
    return cursor.fetchall()


def build_sql(connection: sqlite3.Connection) -> tuple[str, dict[str, int]]:
    contacts = load_rows(
        connection,
        """
        SELECT
          id, external_ref, client_name, first_name, last_name, name, category, record_status,
          phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
          is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
        FROM contacts
        ORDER BY updated_at DESC
        """,
    )
    lists = load_rows(
        connection,
        """
        SELECT
          id, name, description, source_type, source_file_path, created_at, updated_at
        FROM lists
        ORDER BY created_at DESC
        """,
    )
    list_members = load_rows(
        connection,
        """
        SELECT
          id, list_id, contact_id, created_at
        FROM list_members
        """,
    )
    imports = load_rows(
        connection,
        """
        SELECT
          id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
          field_mapping_json, defaults_json, status, created_at
        FROM imports
        ORDER BY created_at DESC
        """,
    )

    statements = [
        "BEGIN;",
        """
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          external_ref TEXT,
          client_name TEXT,
          first_name TEXT NOT NULL,
          last_name TEXT,
          name TEXT NOT NULL,
          category TEXT,
          record_status TEXT NOT NULL,
          phone_raw TEXT NOT NULL,
          phone_e164 TEXT NOT NULL,
          phone_hash TEXT NOT NULL UNIQUE,
          email TEXT,
          attributes_json TEXT NOT NULL,
          is_valid BOOLEAN NOT NULL,
          validation_error TEXT,
          is_opted_out BOOLEAN NOT NULL,
          opted_out_at TEXT,
          opt_out_source TEXT,
          imported_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """.strip(),
        """
        CREATE TABLE IF NOT EXISTS lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          source_type TEXT NOT NULL,
          source_file_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """.strip(),
        """
        CREATE TABLE IF NOT EXISTS list_members (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(list_id, contact_id)
        );
        """.strip(),
        """
        CREATE TABLE IF NOT EXISTS imports (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_sha256 TEXT NOT NULL,
          total_rows INTEGER NOT NULL,
          valid_rows INTEGER NOT NULL,
          invalid_rows INTEGER NOT NULL,
          duplicate_rows INTEGER NOT NULL,
          field_mapping_json TEXT,
          defaults_json TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """.strip(),
        "CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_contacts_phone_hash ON contacts(phone_hash);",
        "CREATE INDEX IF NOT EXISTS idx_list_members_list_id ON list_members(list_id);",
        "CREATE INDEX IF NOT EXISTS idx_list_members_contact_id ON list_members(contact_id);",
        "TRUNCATE TABLE imports, list_members, lists, contacts;",
    ]
    statements += build_insert_sql(
        "contacts",
        CONTACT_COLUMNS,
        contacts,
        boolean_columns={"is_valid", "is_opted_out"},
    )
    statements += build_insert_sql("lists", LIST_COLUMNS, lists)
    statements += build_insert_sql("list_members", LIST_MEMBER_COLUMNS, list_members)
    statements += build_insert_sql("imports", IMPORT_COLUMNS, imports)
    statements += [
        "COMMIT;",
        "SELECT 'contacts' AS table_name, COUNT(*) AS count FROM contacts;",
        "SELECT 'lists' AS table_name, COUNT(*) AS count FROM lists;",
        "SELECT 'list_members' AS table_name, COUNT(*) AS count FROM list_members;",
        "SELECT 'imports' AS table_name, COUNT(*) AS count FROM imports;",
    ]

    counts = {
        "contacts": len(contacts),
        "lists": len(lists),
        "list_members": len(list_members),
        "imports": len(imports),
    }
    return "\n".join(statements) + "\n", counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync relational tables from SQLite to Postgres.")
    parser.add_argument("--sqlite-path", required=True, help="Path to the SQLite database file.")
    parser.add_argument("--postgres-url", required=True, help="Postgres connection URL understood by psql.")
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite_path).expanduser()
    if not sqlite_path.exists():
        print(f"SQLite database not found: {sqlite_path}", file=sys.stderr)
        return 1

    connection = sqlite3.connect(str(sqlite_path))
    connection.row_factory = sqlite3.Row
    try:
        sql, counts = build_sql(connection)
    finally:
        connection.close()

    print(
        "Preparing sync:",
        ", ".join(f"{table}={count}" for table, count in counts.items()),
        file=sys.stderr,
    )

    result = subprocess.run(
        ["psql", args.postgres_url, "-v", "ON_ERROR_STOP=1", "-q"],
        input=sql,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return result.returncode

    sys.stdout.write(result.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
