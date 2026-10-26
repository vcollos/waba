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

// Manual list inclusion: confirmation must never overwrite an existing profile.
const actor = { id: 'operator', role: 'operator', clientIds: ['tenant', 'second'] };
function manualSetup({ contacts = [base], lists = [{ id: 'list', client_id: 'tenant' }] } = {}) {
  const writes = [], audits = [], memberships = new Set(['old-list:contact']);
  const queries = [];
  const database = { postgresTransaction: async callback => callback({ query: async (sql, args) => {
    queries.push({ sql, args });
    if (sql.includes('FROM contacts') && sql.includes('phone_hash = $1')) {
      assert.match(sql, /COALESCE\(client_id, ''\) = COALESCE\(\$2, ''\)/);
      return { rows: contacts.filter(c => (c.client_id ?? null) === args[1]) };
    }
    if (sql.includes('FROM lists')) {
      const matched = lists.filter(l => args[0].includes(l.id) &&
        (sql.includes('COALESCE') ? (l.client_id ?? null) === args[1] : args[1] === null || l.client_id === args[1]));
      return { rows: sql.includes('COUNT(*)') ? [{ count: matched.length }] : matched };
    }
    writes.push({ sql, args });
    if (sql.includes('INSERT INTO list_members')) {
      assert.match(sql, /ON CONFLICT \(list_id, contact_id\) DO NOTHING/);
      memberships.add(`${args[1]}:${args[2]}`);
    }
    return { rows: [] };
  } }) };
  return { service: new ContactsService(database, { log: async event => audits.push(event) }), writes, audits, memberships, queries };
}
const manual = { ...contact, listIds: ['list'], clientId: 'tenant' };
test('manual duplicate offers same-tenant contact with no writes before confirmation', async () => {
  const { service, writes, audits } = manualSetup();
  await assert.rejects(service.createContact(manual, actor), error => {
    assert.equal(error.getResponse().code, 'CONTACT_ALREADY_EXISTS');
    assert.deepEqual(error.getResponse().existingContact, { id: base.id, name: base.name, phoneE164: base.phone_e164 });
    return true;
  });
  assert.equal(writes.length, 0); assert.equal(audits.length, 0);
});
test('confirmation adds membership idempotently without changing profile, opt-out or prior lists', async () => {
  const { service, writes, audits, memberships } = manualSetup();
  for (let i = 0; i < 2; i++) {
    const result = await service.createContact({ ...manual, firstName: 'Overwrite', email: 'different@example.com', existingContactId: base.id }, actor);
    assert.equal(result.firstName, base.first_name); assert.equal(result.email, base.email);
    assert.equal(result.isOptedOut, true); assert.equal(result.attributes.jobTitle, 'Gestora');
  }
  assert.deepEqual([...memberships].sort(), ['list:contact', 'old-list:contact']);
  assert.ok(writes.every(w => w.sql.includes('INSERT INTO list_members')));
  assert.ok(audits.every(a => a.action === 'contact.assigned_to_lists'));
});
test('new number in this tenant is created normally even if another tenant has it', async () => {
  const { service, writes } = manualSetup({ contacts: [{ ...base, client_id: 'other' }] });
  const result = await service.createContact(manual, actor);
  assert.notEqual(result.id, base.id); assert.equal(result.clientId, 'tenant');
  assert.equal(writes.filter(w => w.sql.includes('INSERT INTO contacts')).length, 1);
  assert.equal(writes.filter(w => w.sql.includes('INSERT INTO list_members')).length, 1);
});
test('manual inclusion honors second active tenant', async () => {
  const { service } = manualSetup({ contacts: [{ ...base, client_id: 'second' }], lists: [{ id: 'list', client_id: 'second' }] });
  const result = await service.createContact({ ...manual, clientId: 'second', existingContactId: base.id }, actor);
  assert.equal(result.clientId, 'second');
});
for (const role of ['operator', 'admin']) {
  test(`${role} cannot reuse contact into a list belonging to another tenant`, async () => {
    const { service, writes } = manualSetup({ lists: [{ id: 'list', client_id: 'other' }] });
    await assert.rejects(service.createContact({ ...manual, existingContactId: base.id }, { ...actor, role }), /não foram encontradas/);
    assert.equal(writes.length, 0);
  });
}
test('admin without a tenant cannot discover tenant-owned contact', async () => {
  const { service, writes } = manualSetup({ lists: [{ id: 'list', client_id: null }] });
  const result = await service.createContact({ ...manual, clientId: null }, { ...actor, role: 'admin' });
  assert.notEqual(result.id, base.id); assert.equal(result.clientId, null);
  assert.ok(writes.some(w => w.sql.includes('INSERT INTO contacts')));
});
test('stale confirmation never creates a replacement contact', async () => {
  const { service, writes } = manualSetup({ contacts: [] });
  await assert.rejects(service.createContact({ ...manual, existingContactId: base.id }, actor), /contato mudou/);
  assert.equal(writes.length, 0);
});
test('incorrect confirmation id must request confirmation again', async () => {
  const { service, writes } = manualSetup();
  await assert.rejects(service.createContact({ ...manual, existingContactId: 'wrong' }, actor), error => error.getResponse().code === 'CONTACT_ALREADY_EXISTS');
  assert.equal(writes.length, 0);
});
test('duplicate outside list flow keeps the existing rejection behavior', async () => {
  const { service, writes } = manualSetup();
  await assert.rejects(service.createContact({ ...manual, listIds: [] }, actor), /Já existe um contato/);
  assert.equal(writes.length, 0);
});
