'use client';

import {
  type ContractClause,
  type ContractDetailsInput,
  contractLength,
  CURRENCIES,
  DOCUMENT_LANGUAGES,
  formatDuration,
  type GameDto,
  isMinorOn,
  MERGE_FIELDS,
  PAY_FREQUENCIES,
  RECIPIENT_KINDS,
  type TeamDto,
} from '@esports/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { Badge, Button, Checkbox, cx, SelectField, TextArea, TextField } from '@/components/ui';
import { api } from '@/lib/api';
import { useContractLabels, useContractLocale } from '@/lib/contracts';
import { useFinanceLabels } from '@/lib/finance';
import { useCan, useCovers } from '@/lib/session';

export interface Draft {
  teamId: string | null;
  rosterMemberId: string | null;
  details: ContractDetailsInput;
  clauses: ContractClause[];
}

const o = (v: string) => (v.trim() === '' ? null : v);

function Group({
  title,
  children,
  lead,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-line bg-panel">
      <legend className="sr-only">{title}</legend>
      <div className="border-b border-line px-5 py-3">
        <h3 className="font-semibold">{title}</h3>
        {lead && <div className="mt-1 text-sm text-muted">{lead}</div>}
      </div>
      <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

const Full = ({ children }: { children: ReactNode }) => (
  <div className="sm:col-span-2">{children}</div>
);

export function DetailsForm({
  draft,
  setDraft,
  disabled,
  invalid,
}: {
  draft: Draft;
  setDraft: (f: (d: Draft) => Draft) => void;
  disabled: boolean;
  invalid: Set<string>;
}) {
  const t = useTranslations('contracts.details');
  const tc = useTranslations('contracts');
  const L = useContractLabels();
  const F = useFinanceLabels();
  const loc = useContractLocale();
  const can = useCan();
  const covers = useCovers();
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<TeamDto[]>('/teams'),
    enabled: can('teams.view'),
  });
  const games = useQuery({
    queryKey: ['games'],
    queryFn: () => api<GameDto[]>('/games'),
    enabled: can('games.view'),
  });
  const d = draft.details;
  const set = (patch: Partial<ContractDetailsInput>) =>
    setDraft((x) => ({ ...x, details: { ...x.details, ...patch } }));
  const setR = (patch: Partial<ContractDetailsInput['recipient']>) =>
    set({ recipient: { ...d.recipient, ...patch } });
  const setG = (patch: Partial<NonNullable<ContractDetailsInput['guardian']>>) =>
    set({ guardian: { ...(d.guardian ?? {}), ...patch } });
  const setC = (patch: Partial<ContractDetailsInput['compensation']>) =>
    set({ compensation: { ...d.compensation, ...patch } });
  const bad = (k: string) => (invalid.has(k) ? t('fieldInvalid') : null);
  const len =
    d.startDate && d.endDate && d.startDate <= d.endDate
      ? contractLength(d.startDate, d.endDate)
      : null;
  // Same rule as the API: a guardian signs too when the recipient is under 18 today.
  const minor = !!isMinorOn(d.recipient.dateOfBirth, new Date().toISOString().slice(0, 10));
  const showGuardian = minor || !!(d.guardian && Object.values(d.guardian).some(Boolean));
  const teamOptions = (teams.data ?? []).filter(
    (x) =>
      x.id === draft.teamId ||
      covers.team('contracts.edit', x) ||
      covers.team('contracts.create', x),
  );
  const currencyOptions = CURRENCIES.map((c) => (
    <option key={c.code} value={c.code}>
      {c.code}
    </option>
  ));

  return (
    <div className="flex flex-col gap-5">
      <Group title={t('general')}>
        <TextField
          label={t('title')}
          hint={t('titleHint')}
          optional
          value={d.title ?? ''}
          disabled={disabled}
          onChange={(e) => set({ title: o(e.target.value) })}
        />
        <SelectField
          label={t('language')}
          value={d.language}
          disabled={disabled}
          onChange={(e) => set({ language: e.target.value as ContractDetailsInput['language'] })}
        >
          {DOCUMENT_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {L.language[l]}
            </option>
          ))}
        </SelectField>
      </Group>

      <Group
        title={t('recipient')}
        lead={minor ? <span className="text-amber-ink">{t('minorNote')}</span> : undefined}
      >
        <SelectField
          label={t('kind')}
          value={d.recipient.kind}
          disabled={disabled}
          onChange={(e) =>
            setR({ kind: e.target.value as ContractDetailsInput['recipient']['kind'] })
          }
        >
          {RECIPIENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {L.recipientKind[k]}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('nationality')}
          optional
          value={d.recipient.nationality ?? ''}
          disabled={disabled}
          onChange={(e) => setR({ nationality: o(e.target.value) })}
        />
        <TextField
          label={t('fullNameEn')}
          dir="ltr"
          value={d.recipient.fullNameEn ?? ''}
          disabled={disabled}
          onChange={(e) => setR({ fullNameEn: o(e.target.value) })}
        />
        <TextField
          label={t('fullNameAr')}
          dir="rtl"
          value={d.recipient.fullNameAr ?? ''}
          disabled={disabled}
          onChange={(e) => setR({ fullNameAr: o(e.target.value) })}
        />
        <TextField
          label={t('dateOfBirth')}
          type="date"
          optional
          value={d.recipient.dateOfBirth ?? ''}
          disabled={disabled}
          error={bad('dateOfBirth')}
          onChange={(e) => setR({ dateOfBirth: o(e.target.value) })}
        />
        <TextField
          label={t('idNumber')}
          optional
          dir="ltr"
          value={d.recipient.idNumber ?? ''}
          disabled={disabled}
          onChange={(e) => setR({ idNumber: o(e.target.value) })}
        />
        <TextField
          label={t('email')}
          type="email"
          optional
          dir="ltr"
          value={d.recipient.email ?? ''}
          disabled={disabled}
          error={bad('email')}
          onChange={(e) => setR({ email: o(e.target.value) })}
        />
        <TextField
          label={t('phone')}
          type="tel"
          optional
          dir="ltr"
          value={d.recipient.phone ?? ''}
          disabled={disabled}
          onChange={(e) => setR({ phone: o(e.target.value) })}
        />
        <Full>
          <TextArea
            label={t('address')}
            optional
            rows={2}
            value={d.recipient.address ?? ''}
            disabled={disabled}
            onChange={(e) => setR({ address: o(e.target.value) })}
          />
        </Full>
      </Group>

      {showGuardian && (
        <Group title={t('guardian')}>
          <TextField
            label={t('guardianName')}
            value={d.guardian?.fullName ?? ''}
            disabled={disabled}
            onChange={(e) => setG({ fullName: o(e.target.value) })}
          />
          <TextField
            label={t('relationship')}
            value={d.guardian?.relationship ?? ''}
            disabled={disabled}
            onChange={(e) => setG({ relationship: o(e.target.value) })}
          />
          <TextField
            label={t('email')}
            type="email"
            optional
            dir="ltr"
            value={d.guardian?.email ?? ''}
            disabled={disabled}
            onChange={(e) => setG({ email: o(e.target.value) })}
          />
          <TextField
            label={t('phone')}
            type="tel"
            optional
            dir="ltr"
            value={d.guardian?.phone ?? ''}
            disabled={disabled}
            onChange={(e) => setG({ phone: o(e.target.value) })}
          />
        </Group>
      )}

      <Group title={t('assignment')}>
        {teams.data ? (
          <SelectField
            label={tc('team')}
            value={draft.teamId ?? ''}
            disabled={disabled}
            onChange={(e) =>
              setDraft((x) => ({
                ...x,
                teamId: e.target.value || null,
                rosterMemberId: e.target.value === x.teamId ? x.rosterMemberId : null,
              }))
            }
          >
            {(covers.department('contracts.edit', null) ||
              covers.department('contracts.create', null) ||
              !draft.teamId) && <option value="">{tc('noTeam')}</option>}
            {teamOptions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
        ) : (
          <TextField
            label={tc('team')}
            value={teamOptions.find((x) => x.id === draft.teamId)?.name ?? ''}
            disabled
            readOnly
          />
        )}
        {games.data ? (
          <SelectField
            label={t('game')}
            value={d.gameId ?? ''}
            disabled={disabled}
            onChange={(e) => set({ gameId: e.target.value || null })}
          >
            <option value="">{t('noGame')}</option>
            {games.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <Full>
          <TextField
            label={t('role')}
            value={d.role ?? ''}
            disabled={disabled}
            onChange={(e) => set({ role: o(e.target.value) })}
          />
        </Full>
      </Group>

      <Group
        title={t('term')}
        lead={
          len ? t('duration', { duration: formatDuration(len.months, len.days, loc) }) : undefined
        }
      >
        <TextField
          label={t('startDate')}
          type="date"
          value={d.startDate ?? ''}
          disabled={disabled}
          onChange={(e) => set({ startDate: o(e.target.value) })}
        />
        <TextField
          label={t('endDate')}
          type="date"
          optional
          value={d.endDate ?? ''}
          disabled={disabled}
          error={bad('endDate')}
          onChange={(e) => set({ endDate: o(e.target.value) })}
        />
      </Group>

      <Group title={t('pay')}>
        <TextField
          label={t('amount')}
          inputMode="decimal"
          dir="ltr"
          value={d.compensation.amount ?? ''}
          disabled={disabled}
          error={bad('amount')}
          onChange={(e) => setC({ amount: o(e.target.value) })}
        />
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label={t('currency')}
            value={d.compensation.currency}
            disabled={disabled}
            onChange={(e) => setC({ currency: e.target.value })}
          >
            {currencyOptions}
          </SelectField>
          <SelectField
            label={t('frequency')}
            value={d.compensation.frequency}
            disabled={disabled}
            onChange={(e) =>
              setC({
                frequency: e.target.value as ContractDetailsInput['compensation']['frequency'],
              })
            }
          >
            {PAY_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {F.payFrequency[f]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label={t('offSeasonAmount')}
          optional
          inputMode="decimal"
          dir="ltr"
          value={d.compensation.offSeasonAmount ?? ''}
          disabled={disabled}
          error={bad('offSeasonAmount')}
          onChange={(e) => setC({ offSeasonAmount: o(e.target.value) })}
        />
        <TextField
          label={t('offSeasonNotes')}
          optional
          value={d.compensation.offSeasonNotes ?? ''}
          disabled={disabled}
          onChange={(e) => setC({ offSeasonNotes: o(e.target.value) })}
        />
        <TextField
          label={t('percent')}
          optional
          inputMode="decimal"
          dir="ltr"
          value={d.revenueShare.percent ?? ''}
          disabled={disabled}
          error={bad('percent')}
          onChange={(e) => set({ revenueShare: { ...d.revenueShare, percent: o(e.target.value) } })}
        />
        <TextField
          label={`${t('revenueShare')} — ${t('description')}`}
          optional
          value={d.revenueShare.description ?? ''}
          disabled={disabled}
          onChange={(e) =>
            set({ revenueShare: { ...d.revenueShare, description: o(e.target.value) } })
          }
        />
      </Group>

      <Group title={t('bonuses')}>
        <Full>
          <ul className="flex flex-col gap-4">
            {d.bonuses.map((b, i) => (
              <li
                key={i}
                className="grid gap-3 rounded-md border border-line p-4 sm:grid-cols-[2fr_1fr_6rem_auto] sm:items-end"
              >
                <TextField
                  label={t('bonusDescription')}
                  value={b.description}
                  disabled={disabled}
                  onChange={(e) =>
                    set({
                      bonuses: d.bonuses.map((x, j) =>
                        j === i ? { ...x, description: e.target.value } : x,
                      ),
                    })
                  }
                />
                <TextField
                  label={t('bonusAmount')}
                  optional
                  inputMode="decimal"
                  dir="ltr"
                  value={b.amount ?? ''}
                  disabled={disabled}
                  onChange={(e) =>
                    set({
                      bonuses: d.bonuses.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              amount: o(e.target.value),
                              currency: x.currency ?? d.compensation.currency,
                            }
                          : x,
                      ),
                    })
                  }
                />
                <SelectField
                  label={t('currency')}
                  value={b.currency ?? d.compensation.currency}
                  disabled={disabled}
                  onChange={(e) =>
                    set({
                      bonuses: d.bonuses.map((x, j) =>
                        j === i ? { ...x, currency: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {currencyOptions}
                </SelectField>
                {!disabled && (
                  <Button
                    variant="ghost"
                    aria-label={t('removeBonus')}
                    onClick={() => set({ bonuses: d.bonuses.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                )}
                <div className="sm:col-span-4">
                  <TextField
                    label={t('bonusCondition')}
                    optional
                    value={b.condition ?? ''}
                    disabled={disabled}
                    onChange={(e) =>
                      set({
                        bonuses: d.bonuses.map((x, j) =>
                          j === i ? { ...x, condition: o(e.target.value) } : x,
                        ),
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
          {!disabled && (
            <Button
              size="sm"
              className="mt-3"
              onClick={() =>
                set({
                  bonuses: [
                    ...d.bonuses,
                    {
                      description: '',
                      amount: null,
                      currency: d.compensation.currency,
                      condition: null,
                    },
                  ],
                })
              }
            >
              <Plus className="size-4" aria-hidden="true" />
              {t('addBonus')}
            </Button>
          )}
        </Full>
      </Group>

      <Group title={t('buyout')}>
        <div className="grid grid-cols-[1fr_6rem] gap-4">
          <TextField
            label={t('buyoutAmount')}
            optional
            inputMode="decimal"
            dir="ltr"
            value={d.buyout.amount ?? ''}
            disabled={disabled}
            error={bad('buyoutAmount')}
            onChange={(e) => set({ buyout: { ...d.buyout, amount: o(e.target.value) } })}
          />
          <SelectField
            label={t('currency')}
            value={d.buyout.currency}
            disabled={disabled}
            onChange={(e) => set({ buyout: { ...d.buyout, currency: e.target.value } })}
          >
            {currencyOptions}
          </SelectField>
        </div>
        <TextArea
          label={t('buyoutTriggers')}
          optional
          rows={2}
          value={d.buyout.triggers ?? ''}
          disabled={disabled}
          onChange={(e) => set({ buyout: { ...d.buyout, triggers: o(e.target.value) } })}
        />
      </Group>

      <Group title={t('other')}>
        <Full>
          <TextArea
            label={t('terminationConditions')}
            optional
            value={d.terminationConditions ?? ''}
            disabled={disabled}
            onChange={(e) => set({ terminationConditions: o(e.target.value) })}
          />
        </Full>
        <Full>
          <TextArea
            label={t('obligations')}
            optional
            value={d.obligations ?? ''}
            disabled={disabled}
            onChange={(e) => set({ obligations: o(e.target.value) })}
          />
        </Full>
        <Full>
          <TextArea
            label={t('internalNotes')}
            hint={t('internalNotesHint')}
            optional
            rows={2}
            value={d.internalNotes ?? ''}
            disabled={disabled}
            onChange={(e) => set({ internalNotes: o(e.target.value) })}
          />
        </Full>
      </Group>
    </div>
  );
}

function ClauseEditor({
  clause,
  onChange,
}: {
  clause: ContractClause;
  onChange: (c: ContractClause) => void;
}) {
  const t = useTranslations('contracts.clauses');
  return (
    <div className="grid gap-4 border-t border-line px-4 py-4 sm:grid-cols-2">
      <TextField
        label={t('titleEn')}
        dir="ltr"
        value={clause.titleEn}
        onChange={(e) => onChange({ ...clause, titleEn: e.target.value })}
      />
      <TextField
        label={t('titleAr')}
        dir="rtl"
        value={clause.titleAr}
        onChange={(e) => onChange({ ...clause, titleAr: e.target.value })}
      />
      <TextArea
        label={t('bodyEn')}
        dir="ltr"
        rows={6}
        value={clause.bodyEn}
        onChange={(e) => onChange({ ...clause, bodyEn: e.target.value })}
      />
      <TextArea
        label={t('bodyAr')}
        dir="rtl"
        rows={6}
        value={clause.bodyAr}
        onChange={(e) => onChange({ ...clause, bodyAr: e.target.value })}
      />
    </div>
  );
}

export function MergeFieldHelp() {
  const t = useTranslations('contracts.clauses');
  const L = useContractLabels();
  return (
    <details className="rounded-md border border-line bg-panel-2 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('fields')}</summary>
      <p className="mt-2 text-muted">{t('mergeHelp', { example: '{{recipientName}}' })}</p>
      <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {MERGE_FIELDS.map((f) => (
          <li key={f} className="flex justify-between gap-3">
            <code dir="ltr" className="text-[0.8125rem]">{`{{${f}}}`}</code>
            <span className="text-muted">{L.field[f]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ClauseList({
  clauses,
  onChange,
  disabled,
  modifiedIds,
  onAssistant,
  template = false,
}: {
  clauses: ContractClause[];
  onChange: (next: ContractClause[]) => void;
  disabled: boolean;
  modifiedIds: string[];
  onAssistant?: () => void;
  /** Editing a type's template (Owner): the required flag is set here; anything can be removed. */
  template?: boolean;
}) {
  const t = useTranslations('contracts.clauses');
  const loc = useContractLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const move = (i: number, by: number) => {
    const next = [...clauses];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c!);
    onChange(next);
  };
  const update = (c: ContractClause) => onChange(clauses.map((x) => (x.id === c.id ? c : x)));
  let n = 0;
  return (
    <div className="flex flex-col gap-4">
      {!template && <p className="text-sm text-muted">{t('lead')}</p>}
      {!disabled && <MergeFieldHelp />}
      {!clauses.length && <p className="text-muted">{t('empty')}</p>}
      <ol className="flex flex-col gap-3">
        {clauses.map((c, i) => {
          if (c.included) n += 1;
          const title =
            (loc === 'ar' ? c.titleAr || c.titleEn : c.titleEn || c.titleAr) || t('newTitle');
          const body = loc === 'ar' ? c.bodyAr || c.bodyEn : c.bodyEn || c.bodyAr;
          const open = editing === c.id;
          return (
            <li
              key={c.id}
              className={cx(
                'rounded-lg border bg-panel',
                c.included ? 'border-line' : 'border-dashed border-line-strong opacity-75',
              )}
            >
              <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {c.included && <span className="text-muted">{n}. </span>}
                    {title}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={c.required ? 'turf' : 'neutral'}>
                      {c.required ? t('required') : t('optional')}
                    </Badge>
                    {!template && <Badge>{t(`source.${c.source}`)}</Badge>}
                    {modifiedIds.includes(c.id) && <Badge tone="amber">{t('edited')}</Badge>}
                    {!c.included && <Badge>{t('excluded')}</Badge>}
                  </div>
                  {!open && body && (
                    <p className="mt-2 line-clamp-3 text-sm whitespace-pre-line text-muted">
                      {body}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {template ? (
                    <Checkbox
                      label={t('required')}
                      checked={c.required}
                      disabled={disabled}
                      onChange={(e) => update({ ...c, required: e.target.checked, included: true })}
                    />
                  ) : c.required ? (
                    <span
                      className="inline-flex items-center gap-1 px-2 text-[0.8125rem] text-muted"
                      title={t('lockedRequired')}
                    >
                      <Lock className="size-3.5" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">{t('lockedRequired')}</span>
                    </span>
                  ) : (
                    <Checkbox
                      label={t('include')}
                      checked={c.included}
                      disabled={disabled}
                      onChange={(e) => update({ ...c, included: e.target.checked })}
                    />
                  )}
                  {!disabled && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('moveUp')}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('moveDown')}
                        disabled={i === clauses.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant={open ? 'secondary' : 'ghost'}
                        onClick={() => setEditing(open ? null : c.id)}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                        {open ? t('done') : t('edit')}
                      </Button>
                      {(template || !c.required) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('remove')}
                          onClick={() => onChange(clauses.filter((x) => x.id !== c.id))}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {open && <ClauseEditor clause={c} onChange={update} />}
            </li>
          );
        })}
      </ol>
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              const id = crypto.randomUUID();
              onChange([
                ...clauses,
                {
                  id,
                  templateClauseId: null,
                  source: 'custom',
                  required: false,
                  included: true,
                  titleEn: '',
                  titleAr: '',
                  bodyEn: '',
                  bodyAr: '',
                },
              ]);
              setEditing(id);
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('add')}
          </Button>
          {onAssistant && (
            <Button onClick={onAssistant}>
              <Sparkles className="size-4" aria-hidden="true" />
              {t('assistant')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
