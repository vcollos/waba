'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

type RecordStatus = 'active' | 'inactive';

interface Contact {
  id: string;
  clientName?: string | null;
  name: string;
  category?: string | null;
  recordStatus: RecordStatus;
  phoneE164: string;
  phoneRaw: string;
  email?: string | null;
  externalRef?: string | null;
  importedAt?: string | null;
  createdAt: string;
  isValid: boolean;
  isOptedOut: boolean;
  validationError?: string | null;
  listNames: string[];
}

interface ListItem {
  id: string;
  name: string;
  totalMembers: number;
  eligibleMembers: number;
}

interface ImportPreviewField {
  key: string;
  label: string;
  required: boolean;
}

interface ImportPreview {
  headers: string[];
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
  recommendedMapping: Record<string, string | null>;
  availableFields: ImportPreviewField[];
}

interface ContactFormState {
  clientName: string;
  name: string;
  phone: string;
  category: string;
  recordStatus: RecordStatus;
  email: string;
  externalRef: string;
  listIds: string[];
}

interface BulkActionState {
  action:
    | 'activate'
    | 'deactivate'
    | 'opt_out'
    | 'opt_in'
    | 'delete'
    | 'assign_list'
    | 'set_category'
    | 'set_client';
  listId: string;
  category: string;
  clientName: string;
}

const emptyForm = (): ContactFormState => ({
  clientName: '',
  name: '',
  phone: '',
  category: '',
  recordStatus: 'active',
  email: '',
  externalRef: '',
  listIds: [],
});

const emptyBulkAction = (): BulkActionState => ({
  action: 'activate',
  listId: '',
  category: '',
  clientName: '',
});

export default function ContactsPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lists, setLists] = useState<ListItem[]>([]);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<ContactFormState>(emptyForm);
  const [bulkAction, setBulkAction] = useState<BulkActionState>(emptyBulkAction);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [listName, setListName] = useState('importacao-whatsapp-2026');
  const [importDefaults, setImportDefaults] = useState({
    clientName: '',
    category: '',
    status: 'active' as RecordStatus,
  });
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string | null>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const [contactsPayload, listsPayload] = await Promise.all([
      apiRequest<Contact[]>('/contacts'),
      apiRequest<ListItem[]>('/lists'),
    ]);
    setContacts(contactsPayload);
    setLists(listsPayload);
    setSelectedContactIds((current) =>
      current.filter((contactId) => contactsPayload.some((contact) => contact.id === contactId)),
    );
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar'));
  }, []);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);

    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na operação');
    } finally {
      setBusy(null);
    }
  };

  const resetContactForm = () => {
    setEditingContactId(null);
    setContactForm(emptyForm());
  };

  const submitContact = async (event: FormEvent) => {
    event.preventDefault();

    await runAction(editingContactId ? 'Atualizando contato' : 'Criando contato', async () => {
      const payload = {
        clientName: emptyToNull(contactForm.clientName),
        name: contactForm.name,
        phone: contactForm.phone,
        category: emptyToNull(contactForm.category),
        recordStatus: contactForm.recordStatus,
        email: emptyToNull(contactForm.email),
        externalRef: emptyToNull(contactForm.externalRef),
        listIds: contactForm.listIds,
      };

      await apiRequest(editingContactId ? `/contacts/${editingContactId}` : '/contacts', {
        method: editingContactId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });

      resetContactForm();
      await load();
      setMessage(editingContactId ? 'Contato atualizado.' : 'Contato criado.');
    });
  };

  const editContact = (contact: Contact) => {
    setEditingContactId(contact.id);
    setContactForm({
      clientName: contact.clientName ?? '',
      name: contact.name,
      phone: contact.phoneE164 || contact.phoneRaw,
      category: contact.category ?? '',
      recordStatus: contact.recordStatus ?? 'active',
      email: contact.email ?? '',
      externalRef: contact.externalRef ?? '',
      listIds: lists
        .filter((list) => contact.listNames.includes(list.name))
        .map((list) => list.id),
    });
  };

  const deleteContact = async (contactId: string) => {
    await runAction('Excluindo contato', async () => {
      await apiRequest(`/contacts/${contactId}`, { method: 'DELETE' });
      if (editingContactId === contactId) {
        resetContactForm();
      }
      await load();
      setMessage('Contato removido.');
    });
  };

  const previewImport = async (event: FormEvent) => {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um CSV para ler as colunas.');
      return;
    }

    await runAction('Lendo CSV', async () => {
      const formData = new FormData();
      formData.append('file', file);
      const preview = await apiRequest<ImportPreview>('/contacts/imports/csv/preview', {
        method: 'POST',
        body: formData,
      });
      setImportPreview(preview);
      setFieldMapping(preview.recommendedMapping);
      setMessage(`CSV lido: ${preview.totalRows} linhas detectadas.`);
    });
  };

  const submitImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um CSV para importar.');
      return;
    }
    if (!importPreview) {
      setError('Leia o CSV antes de importar.');
      return;
    }

    await runAction('Importando CSV', async () => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('listName', listName);
      formData.append('mapping', JSON.stringify(fieldMapping));
      formData.append('defaults', JSON.stringify(importDefaults));

      await apiRequest('/contacts/imports/csv', { method: 'POST', body: formData });
      fileRef.current!.value = '';
      setImportPreview(null);
      setFieldMapping({});
      await load();
      setMessage('CSV importado com sucesso.');
    });
  };

  const toggleOpt = async (contactId: string, optOut: boolean) => {
    await runAction(optOut ? 'Bloqueando contato' : 'Liberando contato', async () => {
      await apiRequest(`/contacts/${contactId}/${optOut ? 'opt-out' : 'opt-in'}`, {
        method: 'POST',
      });
      await load();
      setMessage(optOut ? 'Contato marcado como opt-out.' : 'Contato liberado.');
    });
  };

  const executeBulkAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedContactIds.length) {
      setError('Selecione pelo menos um contato.');
      return;
    }

    await runAction('Executando ação em massa', async () => {
      await apiRequest('/contacts/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action: bulkAction.action,
          contactIds: selectedContactIds,
          listId: bulkAction.listId || undefined,
          category: emptyToNull(bulkAction.category),
          clientName: emptyToNull(bulkAction.clientName),
        }),
      });

      setSelectedContactIds([]);
      setBulkAction(emptyBulkAction());
      await load();
      setMessage('Ação em massa concluída.');
    });
  };

  const toggleContactSelection = (contactId: string) => {
    setSelectedContactIds((current) =>
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId],
    );
  };

  const toggleSelectAll = () => {
    setSelectedContactIds((current) =>
      current.length === contacts.length ? [] : contacts.map((contact) => contact.id),
    );
  };

  return (
    <AppShell title="Contatos e listas">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}

      <div className="grid two">
        <SectionCard
          title={editingContactId ? 'Editar contato' : 'Cadastrar contato'}
          description="Cadastro manual com status operacional e vínculo opcional a listas."
        >
          <form className="stack" onSubmit={submitContact}>
            <div className="grid two">
              <div className="field">
                <label>Cliente</label>
                <input
                  value={contactForm.clientName}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, clientName: event.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Categoria</label>
                <input
                  value={contactForm.category}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, category: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid two">
              <div className="field">
                <label>Contato</label>
                <input
                  value={contactForm.name}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="field">
                <label>Telefone</label>
                <input
                  value={contactForm.phone}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, phone: event.target.value }))
                  }
                  placeholder="+5511999999999"
                  required
                />
              </div>
            </div>
            <div className="grid three">
              <div className="field">
                <label>Status</label>
                <select
                  value={contactForm.recordStatus}
                  onChange={(event) =>
                    setContactForm((current) => ({
                      ...current,
                      recordStatus: event.target.value as RecordStatus,
                    }))
                  }
                >
                  <option value="active">Ativo</option>
                  <option value="inactive">Inativo</option>
                </select>
              </div>
              <div className="field">
                <label>E-mail</label>
                <input
                  value={contactForm.email}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Referência externa</label>
                <input
                  value={contactForm.externalRef}
                  onChange={(event) =>
                    setContactForm((current) => ({ ...current, externalRef: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="field">
              <label>Vincular a listas</label>
              <div className="checkbox-grid">
                {lists.length ? (
                  lists.map((list) => {
                    const checked = contactForm.listIds.includes(list.id);
                    return (
                      <label key={list.id} className="checkbox-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setContactForm((current) => ({
                              ...current,
                              listIds: checked
                                ? current.listIds.filter((item) => item !== list.id)
                                : [...current.listIds, list.id],
                            }))
                          }
                        />
                        <span>{list.name}</span>
                      </label>
                    );
                  })
                ) : (
                  <div className="muted">Nenhuma lista criada ainda.</div>
                )}
              </div>
            </div>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={Boolean(busy)}>
                {editingContactId ? 'Salvar alterações' : 'Criar contato'}
              </button>
              {editingContactId ? (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={resetContactForm}
                  disabled={Boolean(busy)}
                >
                  Cancelar edição
                </button>
              ) : null}
            </div>
          </form>
        </SectionCard>

        <SectionCard
          title="Importar CSV com mapeamento"
          description="Leia o arquivo, ajuste as colunas e aplique valores padrão sem mexer na planilha."
        >
          <form className="stack" onSubmit={previewImport}>
            <div className="grid two">
              <div className="field">
                <label>Nome da lista</label>
                <input value={listName} onChange={(event) => setListName(event.target.value)} />
              </div>
              <div className="field">
                <label>Arquivo CSV</label>
                <input ref={fileRef} type="file" accept=".csv,text/csv" />
              </div>
            </div>

            <div className="grid three">
              <div className="field">
                <label>Cliente padrão</label>
                <input
                  value={importDefaults.clientName}
                  onChange={(event) =>
                    setImportDefaults((current) => ({ ...current, clientName: event.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Categoria padrão</label>
                <input
                  value={importDefaults.category}
                  onChange={(event) =>
                    setImportDefaults((current) => ({ ...current, category: event.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Status padrão</label>
                <select
                  value={importDefaults.status}
                  onChange={(event) =>
                    setImportDefaults((current) => ({
                      ...current,
                      status: event.target.value as RecordStatus,
                    }))
                  }
                >
                  <option value="active">Ativo</option>
                  <option value="inactive">Inativo</option>
                </select>
              </div>
            </div>

            <div className="form-actions">
              <button className="ghost-button" type="submit" disabled={Boolean(busy)}>
                Ler colunas
              </button>
              {importPreview ? (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void submitImport()}
                  disabled={Boolean(busy)}
                >
                  Importar com mapeamento
                </button>
              ) : null}
            </div>
          </form>

          {importPreview ? (
            <div className="stack top-gap">
              <div className="notice">
                <strong>{importPreview.totalRows} linhas detectadas.</strong>
                <div className="muted">Mapeie as colunas obrigatórias antes de importar.</div>
              </div>

              <div className="grid two">
                {importPreview.availableFields.map((field) => (
                  <div key={field.key} className="field">
                    <label>
                      {field.label} {field.required ? '*' : null}
                    </label>
                    <select
                      value={fieldMapping[field.key] ?? ''}
                      onChange={(event) =>
                        setFieldMapping((current) => ({
                          ...current,
                          [field.key]: event.target.value || null,
                        }))
                      }
                    >
                      <option value="">Não mapear</option>
                      {importPreview.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {importPreview.headers.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.sampleRows.map((row, rowIndex) => (
                      <tr key={`sample-${rowIndex}`}>
                        {importPreview.headers.map((header) => (
                          <td key={`${rowIndex}-${header}`}>{row[header] || '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </SectionCard>
      </div>

      <div className="grid two">
        <SectionCard
          title="Ações em massa"
          description="Atualize status, opt-in/opt-out, cliente, categoria ou vincule uma lista."
        >
          <form className="stack" onSubmit={executeBulkAction}>
            <div className="notice">
              <strong>{selectedContactIds.length}</strong> contato(s) selecionado(s)
            </div>
            <div className="grid three">
              <div className="field">
                <label>Ação</label>
                <select
                  value={bulkAction.action}
                  onChange={(event) =>
                    setBulkAction((current) => ({
                      ...current,
                      action: event.target.value as BulkActionState['action'],
                    }))
                  }
                >
                  <option value="activate">Ativar</option>
                  <option value="deactivate">Inativar</option>
                  <option value="opt_out">Marcar opt-out</option>
                  <option value="opt_in">Remover opt-out</option>
                  <option value="assign_list">Vincular a lista</option>
                  <option value="set_category">Definir categoria</option>
                  <option value="set_client">Definir cliente</option>
                  <option value="delete">Excluir</option>
                </select>
              </div>

              {bulkAction.action === 'assign_list' ? (
                <div className="field">
                  <label>Lista</label>
                  <select
                    value={bulkAction.listId}
                    onChange={(event) =>
                      setBulkAction((current) => ({ ...current, listId: event.target.value }))
                    }
                  >
                    <option value="">Selecione</option>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {bulkAction.action === 'set_category' ? (
                <div className="field">
                  <label>Categoria</label>
                  <input
                    value={bulkAction.category}
                    onChange={(event) =>
                      setBulkAction((current) => ({ ...current, category: event.target.value }))
                    }
                  />
                </div>
              ) : null}

              {bulkAction.action === 'set_client' ? (
                <div className="field">
                  <label>Cliente</label>
                  <input
                    value={bulkAction.clientName}
                    onChange={(event) =>
                      setBulkAction((current) => ({ ...current, clientName: event.target.value }))
                    }
                  />
                </div>
              ) : null}
            </div>

            <button className="primary-button" type="submit" disabled={Boolean(busy)}>
              Aplicar ação
            </button>
          </form>
        </SectionCard>

        <SectionCard title="Listas" description="Resumo de volume total e elegível por lista.">
          <div className="stack">
            {lists.length ? (
              lists.map((list) => (
                <div key={list.id} className="notice">
                  <strong>{list.name}</strong>
                  <div className="muted">
                    {list.totalMembers} contatos / {list.eligibleMembers} elegíveis
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma lista criada.</div>
            )}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Base de contatos"
        description="Cliente, contato, telefone, categoria, data de importação, status e ações operacionais."
      >
        <div className="toolbar">
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={contacts.length > 0 && selectedContactIds.length === contacts.length}
              onChange={toggleSelectAll}
            />
            <span>Selecionar todos</span>
          </label>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Cliente / contato</th>
                <th>Telefone</th>
                <th>Categoria</th>
                <th>Importação</th>
                <th>Status</th>
                <th>Listas</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length ? (
                contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedContactIds.includes(contact.id)}
                        onChange={() => toggleContactSelection(contact.id)}
                      />
                    </td>
                    <td>
                      <strong>{contact.clientName ?? 'Sem cliente'}</strong>
                      <div>{contact.name}</div>
                      <div className="subtle">{contact.email ?? 'Sem e-mail'}</div>
                    </td>
                    <td>{contact.phoneE164 || contact.phoneRaw || '—'}</td>
                    <td>{contact.category ?? '—'}</td>
                    <td>{formatDate(contact.importedAt ?? contact.createdAt)}</td>
                    <td>
                      <span className={`tag ${contact.recordStatus === 'active' ? 'success' : 'warning'}`}>
                        {contact.recordStatus === 'active' ? 'Ativo' : 'Inativo'}
                      </span>{' '}
                      {contact.isValid ? (
                        <span className="tag success">Válido</span>
                      ) : (
                        <span className="tag danger">{contact.validationError ?? 'Inválido'}</span>
                      )}{' '}
                      {contact.isOptedOut ? <span className="tag warning">Opt-out</span> : null}
                    </td>
                    <td>
                      {contact.listNames.length ? contact.listNames.join(', ') : <span className="muted">—</span>}
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="ghost-button" type="button" onClick={() => editContact(contact)}>
                          Editar
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void toggleOpt(contact.id, !contact.isOptedOut)}
                        >
                          {contact.isOptedOut ? 'Liberar' : 'Bloquear'}
                        </button>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => void deleteContact(contact.id)}
                        >
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="muted">
                    Nenhum contato cadastrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </AppShell>
  );
}

const formatDate = (value?: string | null) => {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
};

const emptyToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
