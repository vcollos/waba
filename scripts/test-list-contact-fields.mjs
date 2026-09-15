// Run after `npm run build --workspace @campaign-sender/api`.
// All database calls are isolated fakes; never connects to production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ContactsService } from '../apps/api/dist/contacts/contacts.service.js';

const base = { id: 'contact', client_id: 'tenant', first_name: 'Maria', last_name: 'Silva', name: 'Maria Silva', phone_raw: '+5511999998888', phone_e164: '+5511999998888', email: 'maria@example.com', record_status: 'active', is_valid: true, is_opted_out: true, attributes_json: { preserved: 'value', institutionRepresented: 'Anterior', jobTitle: 'Gestora' } };
function setup(existing = null, tenant = 'tenant') {
  const writes = [];
  const database = {
    postgresQuery: async () => [{ id: 'list', client_id: tenant }],
    postgresTransaction: async (callback) => callback({ query: async (sql, args) => {
      if (sql.includes('FROM contacts WHERE phone_hash')) { assert.equal(args[1], 'tenant'); return { rows: existing ? [existing] : [] }; }
      writes.push({ sql, args }); return { rows: [] };
    } }),
  };
  return { service: new ContactsService(database, { log: async () => {} }), writes };
}
const contact = { firstName: 'Maria', lastName: 'Silva', phone: '+5511999998888', email: 'maria@example.com', category: 'Titular' };
test('new API contact persists all seven fields', async () => {
  const { service, writes } = setup();
  assert.equal((await service.apiIngestContacts('list', [{ ...contact, institutionRepresented: ' Uniodonto Campinas ', jobTitle: ' Presidente ' }], 'tenant')).inserted, 1);
  const args = writes.find(w => w.sql.includes('INSERT INTO contacts')).args;
  assert.deepEqual(args.slice(4, 8), ['Maria', 'Silva', 'Maria Silva', 'Titular']);
  assert.equal(args[10], contact.phone); assert.equal(args[12], contact.email);
  assert.deepEqual(JSON.parse(args[13]), { institutionRepresented: 'Uniodonto Campinas', jobTitle: 'Presidente' });
});
test('upsert merges profile without clearing other attributes or opt-out', async () => {
  const { service, writes } = setup(base);
  await service.apiIngestContacts('list', [{ ...contact, institutionRepresented: 'Nova' }], 'tenant');
  const args = writes.find(w => w.sql.includes('UPDATE contacts')).args;
  assert.deepEqual(JSON.parse(args[11]), { preserved: 'value', institutionRepresented: 'Nova', jobTitle: 'Gestora' });
  assert.equal(args[14], true);
});
for (const fields of [{}, { institutionRepresented: null, jobTitle: null }, { institutionRepresented: ' ', jobTitle: '' }]) {
  test(`old or empty payload preserves profile: ${JSON.stringify(fields)}`, async () => {
    const { service, writes } = setup(base);
    await service.apiIngestContacts('list', [{ ...contact, ...fields }], 'tenant');
    assert.deepEqual(JSON.parse(writes.find(w => w.sql.includes('UPDATE contacts')).args[11]), base.attributes_json);
  });
}
for (const value of [{}, 'x'.repeat(201)]) {
  test(`reject invalid profile ${typeof value}`, async () => {
    const { service, writes } = setup();
    await assert.rejects(service.apiIngestContacts('list', [{ ...contact, jobTitle: value }], 'tenant'), /200 caracteres/);
    assert.equal(writes.length, 0);
  });
}
test('foreign tenant list is rejected before any write', async () => {
  const { service, writes } = setup(null, 'other');
  await assert.rejects(service.apiIngestContacts('list', [{ ...contact, institutionRepresented: 'Empresa' }], 'tenant'), /não encontrada/);
  assert.equal(writes.length, 0);
});

test('legacy JSON text remains readable', async () => {
  const { service, writes } = setup({ ...base, attributes_json: JSON.stringify(base.attributes_json) });
  await service.apiIngestContacts('list', [contact], 'tenant');
  assert.deepEqual(JSON.parse(writes.find(w => w.sql.includes('UPDATE contacts')).args[11]), base.attributes_json);
});
