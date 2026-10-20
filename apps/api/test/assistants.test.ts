/**
 * Phase 5 — AI assistants, end to end over HTTP against the real app (Postgres, Redis).
 * The AI provider is a scripted fake that records every request: tests never call the Anthropic
 * API (no key is available in this build). What these tests prove is the platform's behaviour
 * around the model — permissions, tools, logging, guardrails, proposal-only — not the quality of
 * a real model's answers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AssistantsOverviewDto,
  type ContractDto,
  type ContractTypeDto,
  type ConversationDto,
  DEFAULT_ROLE_TEMPLATES,
  type GeneralAnswer,
  type OfferAnswer,
  PERMISSIONS,
  type PermissionKey,
  type ToolCallLogDto,
} from '@esports/shared';
import { eq, sql } from 'drizzle-orm';
import type {
  AiConverseRequest,
  AiConverseResult,
  AiJsonRequest,
  AiJsonResult,
  AiOutputBlock,
  AiProvider,
} from '../src/ai/ai.provider';
import { AssistantEngine } from '../src/assistants/assistant-engine';
import { titleFrom } from '../src/assistants/assistants.service';
import { auditLogs, devOutbox } from '../src/db/schema';
import { aiMessages, aiToolCalls } from '../src/db/schema-assistants';
import { expense, financeOrg, withRole } from './finance-fixtures';
import { type Client, startApp, type TestApp } from './harness';

// ---------------------------------------------------------------- scripted provider

type ConverseStep = (
  req: AiConverseRequest,
) => Partial<AiConverseResult> & { blocks: AiOutputBlock[] };
type JsonStep = (req: AiJsonRequest) => unknown;

const usage = { inputTokens: 10, outputTokens: 5, webSearchRequests: 0 };

class ScriptedAi implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly configured = true;
  converseCalls: AiConverseRequest[] = [];
  jsonCalls: AiJsonRequest[] = [];
  converseSteps: ConverseStep[] = [];
  jsonSteps: JsonStep[] = [];
  gate: Promise<void> | null = null;
  failNext = false;

  reset() {
    this.converseCalls = [];
    this.jsonCalls = [];
    this.converseSteps = [];
    this.jsonSteps = [];
    this.gate = null;
    this.failNext = false;
  }

  async converse(req: AiConverseRequest): Promise<AiConverseResult> {
    this.converseCalls.push(structuredClone(req));
    if (this.gate) await this.gate;
    const step = this.converseSteps.shift();
    const r = step
      ? step(req)
      : { blocks: [{ type: 'text' as const, text: 'No lookups needed.', citations: [] }] };
    return {
      raw: r.raw ?? r.blocks,
      stopReason: r.stopReason ?? 'end_turn',
      model: 'fake-model',
      usage: r.usage ?? usage,
      blocks: r.blocks,
    };
  }

  async generateJson(req: AiJsonRequest): Promise<AiJsonResult> {
    this.jsonCalls.push(structuredClone(req));
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      const { AppError } = await import('../src/common/errors');
      throw new AppError('ai_unavailable', 502, 'The assistant is busy. Try again in a moment.');
    }
    const step = this.jsonSteps.shift();
    return { data: step ? step(req) : defaultAnswer(req), model: 'fake-model', usage };
  }
}

const isArabic = (req: AiJsonRequest) => req.prompt.includes('Write everything in Arabic');
const props = (req: AiJsonRequest) =>
  Object.keys((req.schema as { properties: object }).properties);

/** A plausible answer for whichever assistant's schema was requested. */
function defaultAnswer(req: AiJsonRequest) {
  const ar = isArabic(req);
  const p = props(req);
  if (p.includes('reply'))
    return {
      reply: ar
        ? 'هذه إجابة تجريبية عن الرياضات الإلكترونية والفرق.'
        : 'This is a test answer about esports teams.',
      claims: [],
      gaps: [],
      followUps: [],
    };
  if (p.includes('message'))
    return {
      message: ar
        ? 'السيد سعد الحربي المحترم، نود إبلاغكم بموعد التدريب القادم.'
        : 'Dear Mr Alharbi, we would like to inform you of the next training session.',
    };
  if (p.includes('body'))
    return {
      to: [{ name: 'Saad Alharbi', email: '' }],
      cc: [],
      subject: 'Training schedule for next week',
      body: 'Dear Saad,\n\nPlease find the training schedule for next week below.\n\nBest regards,\nSara',
      notes: [],
    };
  if (p.includes('alternatives'))
    return {
      summary: 'The player asks for more money and a shorter term than the organization prefers.',
      differences: [
        {
          term: 'Salary',
          preferred: '15,000 monthly',
          requested: '18,000 monthly',
          note: '3,000 gap',
        },
      ],
      constraints: ['Team payroll budget'],
      alternatives: [
        {
          label: 'Longer term, lower base',
          terms: {
            salaryAmount: '16000',
            currency: 'SAR',
            frequency: 'monthly',
            durationMonths: '18',
            signingBonus: '5000',
            bonuses: [{ description: 'Masters qualification', amount: '20000' }],
            revenueSharePercent: '',
            buyoutAmount: '150000',
            otherTerms: '',
          },
          rationale: 'Security for the player, lower monthly cost.',
          risk: 'medium',
          riskExplanation: 'A longer commitment.',
          tradeoffs: 'The player gets security; the organization commits longer.',
          financialImpact: 'Higher total commitment, lower monthly cash outflow.',
        },
        {
          label: 'Requested base, performance-heavy',
          terms: {
            salaryAmount: '18000',
            currency: 'SAR',
            frequency: 'monthly',
            durationMonths: '12',
            signingBonus: '',
            bonuses: [],
            revenueSharePercent: '5',
            buyoutAmount: '',
            otherTerms: '',
          },
          rationale: 'Meets the ask.',
          risk: 'high',
          riskExplanation: 'Highest monthly cost.',
          tradeoffs: 'Matches the request.',
          financialImpact: 'Raises monthly payroll.',
        },
      ],
      recommendation: 'Start with the first alternative.',
      claims: [],
      gaps: [],
    };
  return {
    summary: ar ? 'لاعب واعد بمخاطر متوسطة.' : 'A promising player with moderate risk.',
    performance: 'Consistent in regional play.',
    cost: 'Moderate.',
    risk: 'Limited international experience.',
    potentialReturn: 'Possible qualification bonus and sponsor interest.',
    scenarios: ['conservative', 'base', 'optimistic'].map((name) => ({
      name,
      narrative: `${name} case.`,
      assumptions: ['Stays healthy'],
      estimatedCost: 'Salary over the term',
      potentialReturn: 'Depends on results',
      keyRisks: ['Form'],
    })),
    claims: [],
    gaps: ['No international results in the evidence'],
  };
}

const text = (t: string, citations: { url: string; title: string; citedText: string }[] = []) => ({
  type: 'text' as const,
  text: t,
  citations,
});
const toolUse = (
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${name}_${Math.random().toString(36).slice(2, 7)}`,
) => ({
  type: 'tool_use' as const,
  id,
  name,
  input,
});

// ---------------------------------------------------------------- app & fixtures

const ai = new ScriptedAi();
let t: TestApp;
beforeAll(async () => {
  // Web search is off by default since Phase 6 (billed per search); these tests exercise it.
  t = await startApp({ ai, clock: { today: () => '2026-10-18' }, env: { ASSISTANT_WEB_SEARCH: 'on' } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await idle();
  await t.reset();
  ai.reset();
});

const idle = () => t.app.get(AssistantEngine, { strict: false }).idle();

async function org() {
  const base = await financeOrg(t);
  const { owner, teamA, teamB } = base;
  const manager = await withRole(t, owner, 'manager@example.com', 'esports_manager', {
    type: 'team',
    id: teamA.id,
  });
  const ops = await withRole(t, owner, 'ops@example.com', 'esports_operations', {
    type: 'organization',
  });
  // Team A and team B data: pay, expenses, a roster member each.
  const saad = (
    await owner.post('/roster-members', {
      teamId: teamA.id,
      fullName: 'Saad Alharbi',
      role: 'starter',
      nationality: 'Saudi',
      dateOfBirth: '2001-04-02',
      email: 'saad@example.com',
      compensation: { currency: 'SAR', amount: '15000', frequency: 'monthly' },
    })
  ).body as { id: string };
  const omar = (
    await owner.post('/roster-members', {
      teamId: teamB.id,
      fullName: 'Omar Bravo-Secret',
      role: 'starter',
      dateOfBirth: '1999-01-01',
      compensation: { currency: 'SAR', amount: '77777', frequency: 'monthly' },
    })
  ).body as { id: string };
  expect(
    (await owner.post('/finance/expenses', expense({ teamId: teamA.id, amount: '1234' }))).status,
  ).toBe(201);
  expect(
    (await owner.post('/finance/expenses', expense({ teamId: teamB.id, amount: '98765' }))).status,
  ).toBe(201);
  return {
    ...base,
    manager: manager.client,
    managerId: manager.me.user.id,
    ops: ops.client,
    saad,
    omar,
  };
}

async function draftContract(by: Client, teamId: string, rosterMemberId: string | null = null) {
  const types = (await by.get<ContractTypeDto[]>('/contract-types')).body;
  const c = (
    await by.post<ContractDto>('/contracts', {
      contractTypeId: types.find((x) => x.key === 'player')!.id,
      teamId,
      rosterMemberId,
    })
  ).body;
  const saved = await by.put<ContractDto>(`/contracts/${c.id}`, {
    teamId,
    rosterMemberId,
    details: {
      ...c.snapshot.details,
      recipient: {
        ...c.snapshot.details.recipient,
        fullNameEn: 'Saad Alharbi',
        dateOfBirth: '2001-04-02',
      },
      role: 'Duelist',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      compensation: { amount: '15000', currency: 'SAR', frequency: 'monthly' },
    },
    clauses: c.snapshot.clauses,
  });
  expect(saved.status).toBe(200);
  return saved.body;
}

async function converse(
  c: Client,
  assistant: string,
  message: string,
  opts: { context?: Record<string, unknown>; replyLanguage?: string; webSearch?: boolean } = {},
) {
  const created = await c.post<ConversationDto>('/assistants/conversations', {
    assistant,
    context: opts.context,
    replyLanguage: opts.replyLanguage ?? 'auto',
    webSearch: opts.webSearch,
  });
  expect(created.status).toBe(201);
  return say(c, created.body.id, message);
}

async function say(c: Client, conversationId: string, message: string) {
  const sent = await c.post<ConversationDto>(
    `/assistants/conversations/${conversationId}/messages`,
    {
      text: message,
    },
  );
  expect(sent.status).toBe(202);
  // The reply is prepared in the background (it may already be done with the fake provider).
  expect(sent.body.messages.at(-1)!.role).toBe('assistant');
  await idle();
  const done = await c.get<ConversationDto>(`/assistants/conversations/${conversationId}`);
  expect(done.status).toBe(200);
  return { conversation: done.body, reply: done.body.messages.at(-1)! };
}

/** Every app table except the assistants' own (rows + content hash). */
async function fingerprint() {
  const tables = (await t.db.execute(
    sql`select tablename from pg_tables where schemaname = 'app' and tablename not like 'ai\\_%' and tablename <> '__drizzle_migrations' order by tablename`,
  )) as unknown as { tablename: string }[];
  const out: Record<string, string> = {};
  for (const { tablename } of tables) {
    const [r] = (await t.db.execute(
      sql.raw(
        `select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h from app."${tablename}" x`,
      ),
    )) as unknown as { n: number; h: string }[];
    out[tablename] = `${r!.n}:${r!.h}`;
  }
  return out;
}

// ---------------------------------------------------------------- Definition of Done

describe('Phase 5 Definition of Done', () => {
  test('each of the five assistants returns a human-reviewable proposal and changes nothing', async () => {
    const o = await org();
    const overview = (await o.manager.get<AssistantsOverviewDto>('/assistants')).body;
    expect(overview).toMatchObject({ configured: true, canSendEmail: true });
    expect(overview.assistants.map((a) => [a.key, a.allowed, a.proposal])).toEqual([
      ['general', true, 'none'],
      ['formal_message', true, 'message'],
      ['email', true, 'email'],
      ['offer_optimizer', true, 'offer'],
      ['player_analyst', true, 'analysis'],
    ]);
    const before = await fingerprint();
    const cases: [string, string, string][] = [
      ['general', 'How is team A doing financially?', 'general'],
      ['formal_message', 'Tell Saad training moves to 6 pm on Thursday.', 'formal_message'],
      ['email', 'Invite Saad to the Thursday review.', 'email'],
      ['offer_optimizer', 'Find a middle ground.', 'offer_optimizer'],
      ['player_analyst', 'Is Saad a good investment?', 'player_analyst'],
    ];
    for (const [assistant, message, kind] of cases) {
      const { reply, conversation } = await converse(o.manager, assistant, message, {
        context:
          assistant === 'offer_optimizer'
            ? {
                preferred: { salaryAmount: '15000', durationMonths: 12 },
                requested: { salaryAmount: '18000', durationMonths: 24, signingBonus: '20000' },
              }
            : assistant === 'player_analyst'
              ? { rosterMemberId: o.saad.id }
              : undefined,
      });
      expect(reply).toMatchObject({ role: 'assistant', status: 'complete', language: 'en' });
      expect(reply.answer!.kind as string).toBe(kind);
      expect(conversation.title).toBe(titleFrom(message));
    }
    // Nothing outside the assistants' own records changed: no contract, ledger, email, audit.
    expect(await fingerprint()).toEqual(before);
    // Composition assistants never got tools; research assistants did.
    expect(ai.converseCalls.length).toBe(3);
  });
});

// ---------------------------------------------------------------- proposal only

describe('proposal only: no assistant can change data without an explicit human action', () => {
  test('a model that tries to write (unknown tools, claims of success) changes nothing', async () => {
    const o = await org();
    const draft = await draftContract(o.manager, o.teamA.id, o.saad.id);
    const before = await fingerprint();
    for (const assistant of ['general', 'offer_optimizer', 'player_analyst']) {
      ai.converseSteps.push(() => ({
        stopReason: 'tool_use',
        blocks: [
          text('Updating the contract and sending the offer now.'),
          toolUse('update_contract', { contractId: draft.id, salary: '99999' }),
          toolUse('send_email', { to: 'saad@example.com', body: 'Signed!' }),
          toolUse('create_expense', { amount: '5' }),
        ],
      }));
      ai.jsonSteps.push((req) => ({
        ...(defaultAnswer(req) as object),
        ...(props(req).includes('reply')
          ? { reply: 'I have updated the contract to 99,999 SAR and emailed Saad.' }
          : {}),
      }));
      const { reply } = await converse(
        o.manager,
        assistant,
        'Change the salary to 99,999 and send it.',
        {
          context:
            assistant === 'offer_optimizer' ? { preferred: { salaryAmount: '15000' } } : undefined,
        },
      );
      expect(reply.status).toBe('complete');
      expect(reply.flags.map((f) => f.code)).toContain('unknown_tool');
      expect(reply.toolCalls.map((c) => [c.tool, c.outcome])).toEqual(
        expect.arrayContaining([
          ['update_contract', 'unknown_tool'],
          ['send_email', 'unknown_tool'],
          ['create_expense', 'unknown_tool'],
        ]),
      );
      // The model was told it cannot change anything.
      const results = ai.converseCalls.at(-1)!.messages.at(-1)!;
      expect(JSON.stringify(results)).toContain('you cannot change, save or send anything');
    }
    // The composition assistants have no tools at all; a request to "send" is just text.
    for (const assistant of ['formal_message', 'email']) {
      const calls = ai.converseCalls.length;
      const { reply } = await converse(o.manager, assistant, 'Send this to Saad right now.');
      expect(reply.status).toBe('complete');
      expect(ai.converseCalls.length).toBe(calls);
    }
    expect(await fingerprint()).toEqual(before);
    const after = (await o.manager.get<ContractDto>(`/contracts/${draft.id}`)).body;
    expect(after.currentVersion).toBe(draft.currentVersion);
    expect(after.snapshot.details.compensation.amount).toBe('15000');
    expect(
      await t.db.select().from(devOutbox).where(eq(devOutbox.template, 'assistant_email')),
    ).toEqual([]);
    // The system prompts carry the hard rule.
    expect(
      ai.jsonCalls.every((r) =>
        r.system.includes('You only propose. You cannot save, send, change'),
      ),
    ).toBe(true);
  });

  test('only the explicit Apply action changes a contract, through the contract rules', async () => {
    const o = await org();
    const draft = await draftContract(o.manager, o.teamA.id, o.saad.id);
    const { reply } = await converse(o.manager, 'offer_optimizer', 'Options please', {
      context: {
        preferred: { salaryAmount: '15000', durationMonths: 12 },
        requested: { salaryAmount: '18000', durationMonths: 24, signingBonus: '20000' },
      },
    });
    const answer = reply.answer as OfferAnswer;
    // Costs are computed by the platform from the terms (hand-computed):
    // preferred 15,000 × 12 = 180,000; requested 18,000 × 24 + 20,000 = 452,000;
    // alternative 1: 16,000 × 18 + 5,000 + 20,000 = 313,000.
    expect(answer.preferredCost.totalUpperBound).toBe('180000.00');
    expect(answer.requestedCost.totalUpperBound).toBe('452000.00');
    expect(answer.alternatives[0]!.cost).toMatchObject({
      monthly: '16000.00',
      base: '288000.00',
      signingBonus: '5000.00',
      bonusesMax: '20000.00',
      totalUpperBound: '313000.00',
    });
    expect(answer.alternatives[0]!.deltaVsPreferred).toBe('133000.00');
    expect(answer.alternatives[0]!.deltaVsRequested).toBe('-139000.00');
    expect(answer.alternatives[1]!.cost.notes).toEqual(['revenue_share_not_costed']);
    // The calculated figures were given to the model as evidence; the totals weren't asked of it.
    expect(ai.jsonCalls.at(-1)!.prompt).toContain('total upper bound 452000.00 SAR');

    const applied = await o.manager.post<ContractDto>(
      `/assistants/messages/${reply.id}/apply-offer`,
      {
        alternative: 0,
        contractId: draft.id,
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.currentVersion).toBe(draft.currentVersion + 1);
    const d = applied.body.snapshot.details;
    expect(d.compensation).toMatchObject({
      amount: '16000',
      currency: 'SAR',
      frequency: 'monthly',
    });
    expect(d.startDate).toBe('2027-01-01');
    expect(d.endDate).toBe('2028-06-30'); // 18 months from 1 Jan 2027, inclusive
    expect(d.bonuses).toEqual([
      {
        description: 'Signing bonus',
        amount: '5000',
        currency: 'SAR',
        condition: 'Paid on signing',
      },
      { description: 'Masters qualification', amount: '20000', currency: 'SAR', condition: null },
    ]);
    expect(d.buyout).toMatchObject({ amount: '150000', currency: 'SAR' });
    expect(applied.body.versions.at(-1)!.note).toBe(
      'Offer Optimizer: applied “Longer term, lower base”',
    );
    const [stored] = await t.db.select().from(aiMessages).where(eq(aiMessages.id, reply.id));
    const conv = (
      await o.manager.get<ConversationDto>(`/assistants/conversations/${stored!.conversationId}`)
    ).body;
    expect(
      conv.messages.at(-1)!.actions.map((a) => [a.action, a.detail.number, a.detail.version]),
    ).toEqual([['offer_applied', draft.number, draft.currentVersion + 1]]);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'assistant.offer_applied'));
    expect(audit).toMatchObject({ actorUserId: o.managerId, targetId: draft.id });

    // The contract rules still apply: an approved contract can't be changed, and another
    // team's contract isn't visible to this manager.
    const other = await draftContract(o.owner, o.teamB.id);
    const denied = await o.manager.post(`/assistants/messages/${reply.id}/apply-offer`, {
      alternative: 0,
      contractId: other.id,
    });
    expect(denied.status).toBe(404);
    expect(
      (
        await o.manager.post(`/assistants/messages/${reply.id}/apply-offer`, {
          alternative: 7,
          contractId: draft.id,
        })
      ).status,
    ).toBe(404);
    // Someone else can't apply this user's proposal.
    expect(
      (
        await o.owner.post(`/assistants/messages/${reply.id}/apply-offer`, {
          alternative: 0,
          contractId: draft.id,
        })
      ).status,
    ).toBe(404);
  });

  test('only the explicit Send action sends an email, with the reviewed text, and it needs its own permission', async () => {
    const o = await org();
    const { reply, conversation } = await converse(
      o.manager,
      'email',
      'Invite Saad to the review',
      {
        context: {
          recipientName: 'Saad Alharbi',
          recipientEmail: 'saad@example.com',
          tone: 'friendly',
        },
      },
    );
    // The address the user typed in is filled in; the model never invents one.
    expect(reply.answer).toMatchObject({
      kind: 'email',
      to: [{ name: 'Saad Alharbi', email: 'saad@example.com' }],
    });
    expect(
      await t.db.select().from(devOutbox).where(eq(devOutbox.template, 'assistant_email')),
    ).toEqual([]);

    const body = {
      to: [{ email: 'saad@example.com', name: 'Saad' }],
      cc: [{ email: 'coach@example.com' }],
      subject: 'Review on Thursday (edited)',
      body: 'Hi Saad, see you Thursday at 6 pm.',
    };
    // Operations can draft emails but not send them from the platform.
    const opsConv = await converse(o.ops, 'email', 'Draft an email to Saad');
    expect(
      (await o.ops.post(`/assistants/messages/${opsConv.reply.id}/send-email`, body)).status,
    ).toBe(403);

    const sent = await o.manager.post<ConversationDto>(
      `/assistants/messages/${reply.id}/send-email`,
      body,
    );
    expect(sent.status).toBe(200);
    const [mail] = await t.db
      .select()
      .from(devOutbox)
      .where(eq(devOutbox.template, 'assistant_email'));
    expect(mail).toMatchObject({ to: 'saad@example.com', subject: 'Review on Thursday (edited)' });
    expect(mail!.text).toContain('Cc: coach@example.com');
    expect(mail!.text).toContain('Reply-To: manager@example.com');
    expect(mail!.text).toContain('Hi Saad, see you Thursday at 6 pm.');
    expect(sent.body.messages.at(-1)!.actions[0]).toMatchObject({
      action: 'email_sent',
      detail: {
        to: ['saad@example.com'],
        cc: ['coach@example.com'],
        subject: 'Review on Thursday (edited)',
      },
    });
    expect(conversation.id).toBe(sent.body.id);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'assistant.email_sent'));
    expect(audits.length).toBe(1);
  });
});

// ---------------------------------------------------------------- permission scoping

describe('assistants only see what the invoking user can see', () => {
  test("a team-scoped manager's lookups of another team come back as not available, and none of that data reaches the model", async () => {
    const o = await org();
    const bContract = await draftContract(o.owner, o.teamB.id);
    ai.converseSteps.push(() => ({
      stopReason: 'tool_use',
      blocks: [
        toolUse('get_finance_summary', { scope: 'team', teamId: o.teamB.id }),
        toolUse('list_roster', { teamId: o.teamB.id }),
        toolUse('get_contract_terms', { contractId: bContract.id }),
        toolUse('get_finance_summary', { scope: 'organization' }),
        toolUse('get_roster_member', { rosterMemberId: o.omar.id }),
        toolUse('get_finance_summary', { scope: 'team', teamId: o.teamA.id }),
        toolUse('list_roster', { teamId: o.teamA.id }),
      ],
    }));
    const { reply } = await converse(o.manager, 'general', 'Compare team A and team B salaries.');
    const outcomes = reply.toolCalls.map((c) => [c.tool, c.outcome]);
    expect(outcomes).toEqual([
      ['get_finance_summary', 'not_found'],
      ['list_roster', 'not_found'],
      ['get_contract_terms', 'not_found'],
      ['get_finance_summary', 'denied'],
      ['get_roster_member', 'not_found'],
      ['get_finance_summary', 'ok'],
      ['list_roster', 'ok'],
    ]);
    expect(reply.flags.map((f) => f.code)).toContain('tool_denied');
    // What the model received: team A's data, nothing of team B.
    const sentToModel =
      JSON.stringify(ai.converseCalls.at(-1)!.messages) + ai.jsonCalls.at(-1)!.prompt;
    expect(sentToModel).toContain('Saad Alharbi');
    expect(sentToModel).toContain('1234');
    expect(sentToModel).not.toContain('Omar Bravo-Secret');
    expect(sentToModel).not.toContain('77777');
    expect(sentToModel).not.toContain('98765');
    expect(sentToModel).not.toContain('CS2 Team B');
    // No contact details or dates of birth are sent: an age instead.
    expect(sentToModel).not.toContain('saad@example.com');
    expect(sentToModel).not.toContain('2001-04-02');
    expect(sentToModel).toContain('"age":25');
    // Sources: only what was actually returned.
    expect(reply.sources.map((s) => [s.id, s.kind, s.title, s.label, s.subject])).toEqual([
      ['P1', 'platform', 'Finance report — Valorant Team A', 'finance_report', 'Valorant Team A'],
      ['P2', 'platform', 'Roster — Valorant Team A', 'roster', 'Valorant Team A'],
    ]);
  });

  test('tools are offered only for what the user may see; assistants need their own permission', async () => {
    const o = await org();
    await converse(o.ops, 'general', 'What do we have?');
    expect(
      ai.converseCalls
        .at(-1)!
        .tools.map((x) => x.name)
        .sort(),
    ).toEqual(['get_roster_member', 'list_roster', 'list_teams', 'list_tournaments']);
    await converse(o.manager, 'general', 'What do we have?');
    expect(
      ai.converseCalls
        .at(-1)!
        .tools.map((x) => x.name)
        .sort(),
    ).toEqual([
      'get_contract_terms',
      'get_finance_summary',
      'get_roster_member',
      'list_budgets',
      'list_contracts',
      'list_roster',
      'list_teams',
      'list_tournaments',
    ]);
    // Operations has no Offer Optimizer or Player Analyst.
    const denied = await o.ops.post('/assistants/conversations', { assistant: 'offer_optimizer' });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'assistant_not_allowed']);
    const overview = (await o.ops.get<AssistantsOverviewDto>('/assistants')).body;
    expect(overview.assistants.filter((a) => a.allowed).map((a) => a.key)).toEqual([
      'general',
      'formal_message',
      'email',
    ]);
    expect(overview.canSendEmail).toBe(false);
    // Conversations are private.
    const mine = await converse(o.manager, 'general', 'Private question');
    expect((await o.owner.get(`/assistants/conversations/${mine.conversation.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await o.owner.post(`/assistants/conversations/${mine.conversation.id}/messages`, {
          text: 'hi',
        })
      ).status,
    ).toBe(404);
    // A player picked in the analyst's context is fetched with the user's permissions too.
    const { reply } = await converse(o.manager, 'player_analyst', 'Assess him', {
      context: { rosterMemberId: o.omar.id },
    });
    expect(reply.toolCalls.map((c) => [c.tool, c.outcome])).toEqual([
      ['get_roster_member', 'not_found'],
    ]);
    expect(JSON.stringify(ai.jsonCalls.at(-1)!)).not.toContain('Omar');
  });
});

// ---------------------------------------------------------------- citations and confidence

describe('citations, confidence labels and anti-fabrication', () => {
  test('claims cite only real sources; unsupported or invented ones are corrected and flagged', async () => {
    const o = await org();
    ai.converseSteps.push(() => ({
      usage: { inputTokens: 100, outputTokens: 50, webSearchRequests: 1 },
      blocks: [
        { type: 'web_search', id: 'srvtoolu_1', query: 'VALORANT Champions 2026 prize pool' },
        {
          type: 'web_search_result',
          toolUseId: 'srvtoolu_1',
          errorCode: null,
          results: [
            {
              url: 'https://example.org/champions-2026',
              title: 'Champions 2026 announced',
              pageAge: 'October 1, 2026',
            },
            { url: 'https://example.net/rumours', title: 'Rumours', pageAge: null },
          ],
        },
        text('The prize pool was announced.', [
          {
            url: 'https://example.org/champions-2026',
            title: 'Champions 2026 announced',
            citedText: 'The total prize pool for Champions 2026 is USD 2,250,000.',
          },
        ]),
      ],
    }));
    ai.jsonSteps.push(() => ({
      reply:
        'The prize pool is USD 2.25 million (see https://example.org/champions-2026). A full report is at https://fake.example/report.',
      claims: [
        { text: 'The prize pool is USD 2,250,000.', confidence: 'confirmed', sources: ['W1'] },
        { text: 'Teams will be announced in November.', confidence: 'confirmed', sources: ['W2'] },
        { text: 'Viewership doubled.', confidence: 'confirmed', sources: ['W9'] },
        { text: 'Our team could qualify.', confidence: 'estimated', sources: [] },
      ],
      gaps: ['Qualification dates'],
      followUps: [],
    }));
    const { reply } = await converse(
      o.manager,
      'general',
      'What is the Champions 2026 prize pool?',
    );
    const a = reply.answer as GeneralAnswer;
    expect(a.claims).toEqual([
      { text: 'The prize pool is USD 2,250,000.', confidence: 'confirmed', sourceIds: ['W1'] },
      // A search result with no quoted text can't confirm anything.
      { text: 'Teams will be announced in November.', confidence: 'uncertain', sourceIds: ['W2'] },
      // An invented source id is removed.
      { text: 'Viewership doubled.', confidence: 'uncertain', sourceIds: [] },
      { text: 'Our team could qualify.', confidence: 'estimated', sourceIds: [] },
    ]);
    expect(a.reply).toContain('https://example.org/champions-2026');
    expect(a.reply).not.toContain('fake.example');
    expect(a.reply).toContain('[link removed: not from a verified source]');
    expect(reply.flags.map((f) => [f.code, f.detail])).toEqual(
      expect.arrayContaining([
        ['unsupported_confirmation', 'Teams will be announced in November.'],
        ['unknown_source_removed', 'W9'],
        ['link_removed', 'https://fake.example/report'],
      ]),
    );
    expect(reply.sources).toEqual([
      expect.objectContaining({
        id: 'W1',
        kind: 'web',
        title: 'Champions 2026 announced',
        url: 'https://example.org/champions-2026',
        pageAge: 'October 1, 2026',
        excerpt: 'The total prize pool for Champions 2026 is USD 2,250,000.',
      }),
      expect.objectContaining({ id: 'W2', url: 'https://example.net/rumours', excerpt: null }),
    ]);
    // The compose step saw the evidence with ids and the quoted text, and the rules.
    const compose = ai.jsonCalls.at(-1)!;
    expect(compose.prompt).toContain(
      '[W1] web — Champions 2026 announced <https://example.org/champions-2026>',
    );
    expect(compose.prompt).toContain(
      'quoted: "The total prize pool for Champions 2026 is USD 2,250,000."',
    );
    expect(compose.system).toContain('Never invent sources, links, figures, quotes or names');
    expect(compose.system).toContain('"confirmed" only when a cited source directly supports it');
    // The web search request and the logged query.
    expect(ai.converseCalls.at(-1)!.webSearch).toEqual({ maxUses: 5 });
    const [log] = await t.db.select().from(aiToolCalls).where(eq(aiToolCalls.tool, 'web_search'));
    expect(log).toMatchObject({
      kind: 'web_search',
      assistant: 'general',
      userId: o.managerId,
      outcome: 'ok',
      input: { query: 'VALORANT Champions 2026 prize pool' },
      resultSummary: { count: 2, sourceIds: ['W1', 'W2'] },
    });
    expect(log!.createdAt).toBeInstanceOf(Date);
    const [stored] = await t.db.select().from(aiMessages).where(eq(aiMessages.id, reply.id));
    expect(stored!.usage).toEqual({
      inputTokens: 110,
      outputTokens: 55,
      webSearchRequests: 1,
      calls: 2,
    });
  });

  test('web search can be switched off per conversation; scenarios that promise outcomes are flagged', async () => {
    const o = await org();
    await converse(o.manager, 'general', 'Anything new?', { webSearch: false });
    expect(ai.converseCalls.at(-1)!.webSearch).toBeNull();
    ai.jsonSteps.push((req) => ({
      ...(defaultAnswer(req) as object),
      potentialReturn: 'A guaranteed return within one season.',
    }));
    const { reply } = await converse(o.manager, 'player_analyst', 'Will he pay off?');
    expect(reply.flags).toContainEqual({ code: 'guarantee_language', detail: 'guaranteed' });
    expect(ai.jsonCalls.at(-1)!.system).toContain('never promise or guarantee an outcome');
  });
  test('a paused turn is resent unchanged; a search deferred by a tool call is paired with its later result', async () => {
    const o = await org();
    ai.converseSteps.push(
      () => ({
        stopReason: 'pause_turn',
        raw: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_p',
            name: 'web_search',
            input: { query: 'paused query' },
          },
        ],
        blocks: [{ type: 'web_search', id: 'srvtoolu_p', query: 'paused query' }],
      }),
      () => ({
        stopReason: 'tool_use',
        blocks: [
          {
            type: 'web_search_result',
            toolUseId: 'srvtoolu_p',
            errorCode: null,
            results: [{ url: 'https://a.example/x', title: 'A', pageAge: null }],
          },
          { type: 'web_search', id: 'srvtoolu_d', query: 'deferred query' },
          toolUse('list_teams', {}, 'toolu_teams'),
        ],
      }),
      () => ({
        blocks: [
          {
            type: 'web_search_result',
            toolUseId: 'srvtoolu_d',
            errorCode: 'max_uses_exceeded',
            results: [],
          },
          text('Notes done.'),
        ],
      }),
    );
    const { reply } = await converse(o.manager, 'general', 'Look it up.');
    // Call 2 got the paused content back verbatim; call 3 got only the tool results.
    expect(ai.converseCalls[1]!.messages.at(-1)).toEqual({
      role: 'assistant_turn',
      raw: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_p',
          name: 'web_search',
          input: { query: 'paused query' },
        },
      ],
    });
    expect(ai.converseCalls[2]!.messages.at(-1)).toMatchObject({
      role: 'tool_results',
      results: [{ toolUseId: 'toolu_teams', isError: false }],
    });
    expect(reply.toolCalls.map((c) => [c.tool, c.input.query ?? null, c.outcome])).toEqual([
      ['web_search', 'paused query', 'ok'],
      ['list_teams', null, 'ok'],
      ['web_search', 'deferred query', 'error'],
    ]);
  });
});

// ---------------------------------------------------------------- logging

describe('tool-call log', () => {
  test('every tool call is logged with query, user, assistant and time; the log is append-only and audit-only', async () => {
    const o = await org();
    ai.converseSteps.push(() => ({ stopReason: 'tool_use', blocks: [toolUse('list_teams', {})] }));
    await converse(o.manager, 'general', 'Which teams do we have?');
    const forbidden = await o.manager.get('/assistants/tool-calls');
    expect(forbidden.status).toBe(403);
    const log = (await o.owner.get<ToolCallLogDto[]>('/assistants/tool-calls')).body;
    expect(log.map((l) => [l.tool, l.kind, l.outcome, l.assistant, l.user.displayName])).toEqual([
      ['list_teams', 'platform', 'ok', 'general', 'Invited Member'],
    ]);
    expect(log[0]!.resultSummary).toEqual({ count: 1, sourceIds: ['P1'] });
    expect(Date.parse(log[0]!.createdAt)).toBeGreaterThan(Date.now() - 60_000);
    await expect(
      Promise.resolve(t.db.update(aiToolCalls).set({ outcome: 'error' })),
    ).rejects.toThrow();
    await expect(Promise.resolve(t.db.delete(aiToolCalls))).rejects.toThrow();
    // A completed reply can't be rewritten either.
    await expect(
      Promise.resolve(
        t.db.update(aiMessages).set({ errorCode: 'x' }).where(eq(aiMessages.role, 'assistant')),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- language

describe('Arabic / English per conversation', () => {
  test('replies follow the language of each message, and switch mid-conversation', async () => {
    const o = await org();
    const first = await converse(o.manager, 'general', 'كيف حال الفريق هذا الموسم؟');
    expect(first.reply.language).toBe('ar');
    expect(ai.jsonCalls.at(-1)!.prompt).toContain('Write everything in Arabic');
    expect(ai.jsonCalls.at(-1)!.system).toContain('Write your whole answer in Arabic');
    const second = await say(
      o.manager,
      first.conversation.id,
      'And in English please: how many players?',
    );
    expect(second.reply.language).toBe('en');
    // The earlier exchange is carried as history.
    expect(ai.jsonCalls.at(-1)!.prompt).toContain('كيف حال الفريق هذا الموسم؟');
    // A fixed language overrides the message's language.
    await o.manager.patch(`/assistants/conversations/${first.conversation.id}`, {
      replyLanguage: 'ar',
    });
    const third = await say(o.manager, first.conversation.id, 'One more question in English.');
    expect(third.reply.language).toBe('ar');
  });

  test('an answer in the wrong language is retried once, then flagged', async () => {
    const o = await org();
    const english = () => ({
      reply: 'This answer is written in English, not Arabic.',
      claims: [],
      gaps: [],
      followUps: [],
    });
    ai.jsonSteps.push(english, english);
    const { reply } = await converse(o.manager, 'general', 'ما هي ميزانية الفريق؟', {
      webSearch: false,
    });
    expect(
      ai.jsonCalls
        .slice(-2)
        .map((r) => r.prompt.includes('IMPORTANT: your previous answer was not in Arabic')),
    ).toEqual([false, true]);
    expect(reply.flags).toContainEqual({ code: 'language_mismatch', detail: 'ar' });
  });
});

// ---------------------------------------------------------------- operational rules

describe('turns', () => {
  test('one reply at a time per conversation; failures are recorded and the conversation recovers', async () => {
    const o = await org();
    let open!: () => void;
    ai.gate = new Promise<void>((r) => (open = r));
    const conv = (
      await o.manager.post<ConversationDto>('/assistants/conversations', {
        assistant: 'formal_message',
      })
    ).body;
    expect(
      (await o.manager.post(`/assistants/conversations/${conv.id}/messages`, { text: 'First' }))
        .status,
    ).toBe(202);
    const second = await o.manager.post(`/assistants/conversations/${conv.id}/messages`, {
      text: 'Second',
    });
    expect([second.status, second.body.error.code]).toEqual([409, 'assistant_busy']);
    open();
    await idle();
    ai.gate = null;
    ai.failNext = true;
    const failed = await say(o.manager, conv.id, 'Third');
    expect(failed.reply).toMatchObject({
      status: 'failed',
      errorCode: 'ai_unavailable',
      answer: null,
    });
    const ok = await say(o.manager, conv.id, 'Fourth');
    expect(ok.reply.status).toBe('complete');
    expect(ok.conversation.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
      ['user', 'complete'],
      ['assistant', 'failed'],
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
  });

  test('without an API key the assistants say they are not configured; nothing is stored', async () => {
    const plain = await startApp({});
    try {
      await plain.reset();
      const { client } = await (await import('./harness')).registerOwner(plain);
      expect((await client.get<AssistantsOverviewDto>('/assistants')).body.configured).toBe(false);
      const conv = (
        await client.post<ConversationDto>('/assistants/conversations', { assistant: 'general' })
      ).body;
      const r = await client.post(`/assistants/conversations/${conv.id}/messages`, {
        text: 'Hello',
      });
      expect([r.status, r.body.error.code]).toEqual([503, 'ai_not_configured']);
      expect(
        (await client.get<ConversationDto>(`/assistants/conversations/${conv.id}`)).body.messages,
      ).toEqual([]);
    } finally {
      await plain.close();
    }
  });

  test('migration 0009 grants existing template roles exactly the template assistant permissions', () => {
    const sqlText = readFileSync(
      join(import.meta.dir, '../drizzle/0009_assistants_hardening.sql'),
      'utf8',
    );
    const fromSql = Object.fromEntries(
      [...sqlText.matchAll(/unnest\(ARRAY\[([\s\S]*?)\]\)[\s\S]*?template_key = '(\w+)'/g)].map(
        (m) => [m[2]!, [...m[1]!.matchAll(/'([\w.]+)'/g)].map((x) => x[1]!).sort()],
      ),
    );
    const fromTemplates = Object.fromEntries(
      DEFAULT_ROLE_TEMPLATES.filter((r) => r.templateKey !== 'owner').map((r) => [
        r.templateKey,
        r.permissions.filter((p) => PERMISSIONS[p as PermissionKey].domain === 'assistants').sort(),
      ]),
    );
    expect(fromSql).toEqual(fromTemplates);
  });
});
